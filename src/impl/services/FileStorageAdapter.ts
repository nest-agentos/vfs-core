import { checkOperation, FSError, FSCapabilityError, type IStorageBackend, type FileStorageBackend,
    type FileStat, type FSNode, type OperationOptions, type ReadOptions, type ReplaceCondition } from '../../protocol';
import * as P from '../../utils/path';
import { normalizeVirtualPath } from './FileSystemView';

/** Compatibility boundary: new file-only drivers need no tag/record implementations. */
export class FileStorageAdapter implements IStorageBackend {
    constructor(readonly fileStorage: FileStorageBackend) {}
    get name() { return this.fileStorage.name; }
    init(options?: OperationOptions) { return this.fileStorage.init(options); }
    close() { return this.fileStorage.close(); }
    async stat(path: string, options?: OperationOptions): Promise<FSNode | null> {
        const stat = await this.fileStorage.files.stat(this.path(path), options);
        return stat ? this.node(path, stat) : null;
    }
    async statType(path: string, options?: OperationOptions) {
        const reader = this.fileStorage.files;
        const stat = await (reader.statType?.(this.path(path), options) ?? reader.stat(this.path(path), options));
        return stat ? { type: stat.kind } : null;
    }
    async list(path: string, options?: OperationOptions): Promise<FSNode[]> {
        const nodes: FSNode[] = [], seen = new Set<string>();
        let cursor: string | undefined;
        do {
            checkOperation(options);
            const page = await this.fileStorage.files.list(this.path(path), { ...options, cursor });
            if (page.warnings?.length) throw new FSError('ECAPABILITY', 'Directory contains unsupported entries');
            for (const entry of page.entries) {
                if (!entry.name || /[/\\\0]/.test(entry.name) || ['.', '..'].includes(entry.name)) throw new FSError('EIO', 'Invalid source entry');
                nodes.push(this.node(P.join(path, entry.name), entry.stat));
            }
            cursor = page.nextCursor ?? undefined;
            if (cursor && seen.has(cursor)) throw new FSError('EIO', 'Repeated directory cursor');
            if (cursor) seen.add(cursor);
            if (nodes.length > 100_000) throw new FSError('EIO', 'Directory listing limit exceeded');
        } while (cursor);
        return nodes;
    }
    async read(path: string, options?: ReadOptions) {
        const result = await this.fileStorage.files.read(this.path(path), options);
        options?.onRevision?.(result.revision); return result.data;
    }
    async write(): Promise<FSNode> { throw new FSCapabilityError('conditional replace'); }
    async replace(path: string, data: Uint8Array, condition: ReplaceCondition, options?: OperationOptions): Promise<FSNode> {
        if (!this.fileStorage.mutations) throw new FSError('EROFS', 'Read-only source');
        return this.node(path, await this.fileStorage.mutations.replace(this.path(path), data, condition, options));
    }
    async mkdir(path: string, options?: OperationOptions): Promise<FSNode> {
        if (!this.fileStorage.mutations) throw new FSError('EROFS', 'Read-only source');
        return this.node(path, await this.fileStorage.mutations.mkdir(this.path(path), options));
    }
    async delete(path: string, options?: OperationOptions & { recursive?: boolean }): Promise<void> {
        if (!this.fileStorage.mutations) throw new FSError('EROFS', 'Read-only source');
        return this.fileStorage.mutations.remove(this.path(path), options);
    }
    async rename(from: string, to: string, options?: OperationOptions): Promise<void> {
        if (!this.fileStorage.mutations) throw new FSError('EROFS', 'Read-only source');
        return this.fileStorage.mutations.rename(this.path(from), this.path(to), options);
    }
    async updateMetadata(): Promise<void> { throw new FSCapabilityError('metadata'); }
    async setTags(): Promise<void> { throw new FSCapabilityError('tags'); }
    async getAllTags(): Promise<string[]> { return []; }
    private path(path: string) { return normalizeVirtualPath(path).slice(1); }
    private node(path: string, stat: FileStat): FSNode {
        path = normalizeVirtualPath(path);
        return { path, parentPath: path === '/' ? null : P.dirname(path), name: P.basename(path),
            type: stat.kind, createdAt: stat.createdAt ?? 0, modifiedAt: stat.modifiedAt ?? 0,
            version: 0, revision: stat.revision, size: stat.size, tags: [], metadata: {},
            ...(stat.kind === 'symlink' ? { target: '' } : {}) } as FSNode;
    }
}
