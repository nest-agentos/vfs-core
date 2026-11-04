import type { ReadOptions, WriteOptions } from '../../protocol';
/**
 * @file packages/vfs-core/src/impl/file-io/File.ts
 * @desc Base IFile implementation backed by IFileSystem.
 *
 * Assetdir sub-files are accessed via file.asset("name") which returns an AssetObj —
 * a lightweight handle for read/write/delete/exists. All sub-files (internal config,
 * message nodes, user attachments) use this same uniform API.
 *
 * Asset lookups re-enter the file view for every operation so revocation and
 * updates made through another handle are observed.
 */
import type {
    IFileSystem,
    IFile,
    AssetObj,
    FSNode,
    FSEventType,
    FSEvent,
} from '../../protocol';
import { FSNotFoundError } from '../../protocol';
import * as P from '../../utils/path';
import { toBuffer } from '../../utils/encoding';

// ═══════════════════════════════════════════════════════════════
// InlineAssetObj — lightweight handle for a sub-file in the assetdir
// ═══════════════════════════════════════════════════════════════

class InlineAssetObj implements AssetObj {
    constructor(
        readonly name: string,
        private readonly _file: FileHandle,
    ) {}

    async read(): Promise<ArrayBuffer | null> {
        const index = await this._file._assetIndex();
        if (!index) return null;
        const id = index.get(this.name);
        if (!id) return null;
        const content = await this._file.fs.driver.readContent(id);
        return toBuffer(content as string | ArrayBuffer);
    }

    async readText(): Promise<string | null> {
        const data = await this.read();
        if (!data) return null;
        return new TextDecoder().decode(data);
    }

    async write(content: Uint8Array | ArrayBuffer | string): Promise<string> {
        const buf = typeof content === 'string'
            ? new TextEncoder().encode(content)
            : content instanceof ArrayBuffer ? new Uint8Array(content) : new Uint8Array(content);
        await this._file.fs.meta.assets.putAsset(this._file.path, this.name, buf);
        return `@asset/${this.name}`;
    }

    async delete(): Promise<void> {
        const index = await this._file._assetIndex();
        if (!index) return;
        const id = index.get(this.name);
        if (!id) return;
        await this._file.fs.driver.delete([id]);
        index.delete(this.name);
    }

    async exists(): Promise<boolean> {
        const index = await this._file._assetIndex();
        return index !== null && index.has(this.name);
    }
}

// ═══════════════════════════════════════════════════════════════
// FileHandle
// ═══════════════════════════════════════════════════════════════

export class FileHandle implements IFile {
    private _path: string;
    private revision?: string;
    get path(): string { return this._path; }

    constructor(
        readonly fs: IFileSystem,
        nodeId: string,
    ) {
        this._path = nodeId;
    }

    // ══ Identity ═══════════════════════════════════════════════

    async getName(): Promise<string> { return (await this._requireNode()).name; }
    async getPath(): Promise<string> { return (await this._requireNode()).path; }
    async getNode(): Promise<FSNode> { return this._requireNode(); }
    async getIcon(): Promise<string> { return (await this._requireNode()).icon ?? ''; }
    async getTags(): Promise<string[]> { return [...((await this._requireNode()).tags ?? [])]; }
    async setTags(tags: string[]): Promise<void> { await this.fs.meta.tags.setTags(this.path, tags); }

    // ══ High-level content ═════════════════════════════════════

    async read(options?: ReadOptions): Promise<string | ArrayBuffer> { return this.readRaw(options); }
    async write(content: string | ArrayBuffer, options?: WriteOptions): Promise<void> { await this.writeRaw(content, options); }

    // ══ Lifecycle ══════════════════════════════════════════════

    async rename(newName: string): Promise<void> {
        await this.fs.driver.rename(this.path, newName);
        this._path = P.join(P.dirname(this._path), newName);
    }

    async copy(destDirNodeId: string, newName?: string): Promise<IFile> {
        const name = newName ?? await this.getName();
        const content = await this.readRaw();
        const newNode = await this.fs.driver.createFile({ name, parentPath: destDirNodeId, content });
        const newFile = new FileHandle(this.fs, newNode.path);
        const assetNames = await this.listAssets();
        for (const assetName of assetNames) {
            const data = await this.asset(assetName).read();
            if (data) await newFile.asset(assetName).write(data);
        }
        return newFile;
    }

    async move(destDirNodeId: string): Promise<void> {
        // engine.move already relocates the companion assetdir; passing it
        // explicitly would double-move and throw after the first rename.
        await this.fs.driver.move([this.path], destDirNodeId);
        this._path = P.join(destDirNodeId, P.basename(this._path));
    }

    async delete(): Promise<void> {
        // engine.delete already cascades the companion assetdir.
        await this.fs.driver.delete([this.path]);
    }

    // ══ Low-level: raw main-file ═══════════════════════════════

    async readRaw(options?: ReadOptions): Promise<string | ArrayBuffer> {
        const content = await this.fs.driver.readContent(this.path, { ...options, onRevision: value => { this.revision = value; options?.onRevision?.(value); } });
        return typeof content === 'string' ? content : toBuffer(content);
    }

    async writeRaw(content: string | ArrayBuffer, options?: WriteOptions): Promise<void> {
        await this.fs.driver.writeContent(this.path, content, { ...options, ifRevision: options?.ifRevision ?? this.revision,
            onRevision: value => { this.revision = value; options?.onRevision?.(value); } });
    }

    // ══ Assetdir ═══════════════════════════════════════════════

    asset(name: string): AssetObj {
        return new InlineAssetObj(name, this);
    }

    async listAssets(): Promise<string[]> {
        const index = await this._assetIndex();
        return index ? Array.from(index.keys()) : [];
    }

    async hasAssetDir(): Promise<boolean> {
        return (await this._resolveAssetDirPath()) !== null;
    }

    // ══ Events ═════════════════════════════════════════════════

    on<E extends FSEventType>(event: E, callback: (event: FSEvent<E>) => void): () => void {
        return this.fs.driver.on(event, callback);
    }

    // ══ Internal (exposed for InlineAssetObj and subclasses) ══

    /** @internal — resolve through the current view, including its lifetime gate. */
    async _resolveAssetDirPath(): Promise<string | null> {
        if (!(await this.fs.capabilitiesAt(this.path)).assets) return null;
        return this.fs.meta.assets.getAssetDirPath(this.path);
    }

    /** @internal — an operation-local index; it is never reused after revocation. */
    async _assetIndex(): Promise<Map<string, string> | null> {
        const dirPath = await this._resolveAssetDirPath();
        if (!dirPath) return null;
        const children = await this.fs.driver.getChildren(dirPath);
        return new Map(children.filter(c => c.type === 'file').map(c => [c.name, c.path]));
    }

    private async _requireNode(): Promise<FSNode> {
        const node = await this.fs.driver.getNode(this.path);
        if (!node) throw new FSNotFoundError(this.path, 'FileHandle.getNode');
        return node;
    }
}

export function createFile(fs: IFileSystem, nodeId: string): IFile {
    return new FileHandle(fs, nodeId);
}
