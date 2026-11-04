/**
 * @file packages/vfs-core/src/interfaces/IMDXFile.ts
 * @desc MDX / Markdown file handle.
 *
 * Extends IFile with Markdown-specific capabilities:
 *  - Resolving @asset/ references to Blob URLs for rendering
 *  - Extracting the list of referenced assets from document content
 *  - Pruning unreferenced assets automatically
 *
 * read() returns MDX text directly (no transformation over readRaw).
 *
 * Create via factory: createMDXFile(engine: IFSEngine, nodeId: string): IMDXFile
 */
import type { IFile } from './IFile';

export interface IMDXFile extends IFile {
    /**
     * Replace every @asset/<name> reference in the given Markdown content with
     * a Blob URL so that the rendered document can display embedded resources.
     * @param content Raw Markdown text (may contain @asset/ references)
     * @returns Markdown text with @asset/ references replaced by Blob URLs
     */
    resolveAssetReferences(content: string): Promise<string>;

    /**
     * Scan content and return the filenames of every @asset/ reference found.
     * Pure function — does not perform any I/O.
     */
    extractReferencedAssets(content: string): string[];

    /**
     * Read the current file content, extract all @asset/ references, then
     * delete every asset in the assetdir that is not referenced.
     * @returns Number of assets deleted
     */
    pruneUnusedAssets(): Promise<number>;

    /**
     * Revoke all Blob URLs created by resolveAssetReferences and free memory.
     * Call when the document is closed or the file handle is no longer needed.
     */
    destroy(): void;
}
