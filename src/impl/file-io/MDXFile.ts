/**
 * @file packages/vfs-core/src/impl/file-io/MDXFile.ts
 * @desc MDX/Markdown file handle implementing IMDXFile.
 *
 * Extends FileHandle to reuse all base asset operations.
 * Adds MDX-specific capabilities:
 *  - @asset/ reference resolution to Blob URLs (cached per instance, parallel fetch)
 *  - Referenced-asset extraction from Markdown content
 *  - Automatic pruning of unreferenced assets
 *
 * read() returns MDX text directly (no transformation over readRaw).
 */
import type { IFileSystem, IMDXFile } from '../../protocol';
import { guessMimeType } from '../../utils';
import { FileHandle } from './File';

const ASSET_REF_REGEX = /@asset\/([^\s)"']+)/g;

export class MDXFileHandle extends FileHandle implements IMDXFile {
    /** Blob URLs keyed by asset name — reused across renders, revoked on destroy(). */
    private readonly _blobUrls = new Map<string, string>();

    constructor(fs: IFileSystem, nodeId: string) {
        super(fs, nodeId);
    }

    // ========== IMDXFile ==========

    extractReferencedAssets(content: string): string[] {
        const names: string[] = [];
        const regex = new RegExp(ASSET_REF_REGEX.source, 'g');
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
            names.push(match[1]);
        }
        return names;
    }

    async resolveAssetReferences(content: string): Promise<string> {
        const names = this.extractReferencedAssets(content);
        if (names.length === 0) return content;

        // Deduplicate before fetching to avoid redundant concurrent requests
        // for the same asset name appearing multiple times in the document.
        const uniqueNames = [...new Set(names)];
        const entries = await Promise.all(
            uniqueNames.map(async (name) => [name, await this._getOrCreateBlobUrl(name)] as const)
        );

        let result = content;
        for (const [name, blobUrl] of entries) {
            if (blobUrl) result = result.replaceAll(`@asset/${name}`, blobUrl);
        }
        return result;
    }

    async pruneUnusedAssets(): Promise<number> {
        const content = await this.read();
        const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
        const refs = new Set(this.extractReferencedAssets(text));
        const all = await this.listAssets();
        let count = 0;
        for (const name of all) {
            if (!refs.has(name)) {
                await this.asset(name).delete();
                count++;
            }
        }
        return count;
    }

    destroy(): void {
        this._blobUrls.forEach((url) => URL.revokeObjectURL(url));
        this._blobUrls.clear();
    }

    private async _getOrCreateBlobUrl(name: string): Promise<string | null> {
        if (this._blobUrls.has(name)) return this._blobUrls.get(name)!;

        const data = await this.asset(name).read();
        if (!data) return null;

        const url = URL.createObjectURL(new Blob([data], { type: guessMimeType(name) }));
        this._blobUrls.set(name, url);
        return url;
    }
}

export function createMDXFile(fs: IFileSystem, nodeId: string): IMDXFile {
    return new MDXFileHandle(fs, nodeId);
}
