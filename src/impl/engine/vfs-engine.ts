import { checkOperation, type OperationOptions } from '../../protocol';
/**
 * @file packages/vfs-core/src/impl/engine/vfs-engine.ts
 * @desc VFS 引擎 — 系统级核心操作（v4.1: path-based 后端）
 *
 * 职责：
 * - 管理根后端 + 挂载路由
 * - Bootstrap 基础目录结构 (/etc, /dev, /module)
 * - 系统级路径操作
 * - 持有 plugin pipeline、device registry、event bus、access controller
 *
 * v4.1 变更：
 * - 废弃 IInodeStore/IMetaStore/IContentStore 三层分离
 * - 所有存储操作通过 path-based IStorageBackend 接口
 * - 删除 PathResolver、node-mapper、ROOT_INO、contentRef 中间层
 */

import type {
    IStorageBackend,
    FSNode,
    DirEntry,
    FileContent,
    WriteOptions,
    ReadOptions,
    DeleteOptions,
    IMountRouter,
    IOOperation,
} from '../../protocol';

import {
    FSError,
    FSAlreadyExistsError,
    FSCapabilityError,
    FSConflictError,
    SYSTEM_DIRS,
    DEVICE_HANDLER_METADATA_KEY,
    DEFAULT_FILENAME_PATTERN,
    IO_OPERATIONS,
} from '../../protocol';

import { FSEventBus } from '../event/event-bus';
import { PluginPipeline } from './plugin-pipeline';
import { DeviceRegistry } from './device-registry';
import { toBuffer, toString } from '../../utils/encoding';
import * as P from '../../utils/path';
import { toAssetDirName, validateFilename } from '../../utils/validation';

export class VFSEngine {
    readonly events: FSEventBus;
    readonly plugins: PluginPipeline;
    readonly devices: DeviceRegistry;

    /** Counts of backend operations for performance diagnostics. */
    readonly ioStats: Record<IOOperation, number> = {
        stat: 0, list: 0, read: 0, write: 0, mkdir: 0,
        delete: 0, rename: 0, metadata: 0, search: 0,
    };
    resetIOStats(): void {
        IO_OPERATIONS.forEach(operation => { this.ioStats[operation] = 0; });
    }

    private readonly backend: IStorageBackend;
    private _mountRouter: IMountRouter | null = null;
    private filenamePattern: RegExp = DEFAULT_FILENAME_PATTERN;
    private initialized = false;

    private _inc(op: IOOperation): void { this.ioStats[op]++; }

    constructor(
        backend: IStorageBackend,
    ) {
        this.backend = backend;
        this.events = new FSEventBus();
        this.plugins = new PluginPipeline();
        this.devices = new DeviceRegistry();
    }

    get store(): IStorageBackend { return this.backend; }
    getBackend(): IStorageBackend { return this.backend; }

    setMountRouter(router: IMountRouter): void { this._mountRouter = router; }

    setFilenamePattern(pattern: RegExp): void { this.filenamePattern = pattern; }

    getBackendForPath(systemPath: string): IStorageBackend {
        if (!this._mountRouter) return this.backend;
        return this._mountRouter.resolve(systemPath).mount.backend;
    }

    /** Resolve record addressing and reject a transaction crossing its owning backend. */
    recordLocation(systemPath: string, owner: IStorageBackend): { localPath: string; mountPath: string } {
        const location = this.resolveStore(systemPath);
        if (location.backend !== owner) throw new FSError('EXMOUNT', 'Record operations must stay in their module backend', 'record', systemPath);
        return location;
    }

    /** Resolve backend + local path + mount path for a system path. */
    private resolveStore(systemPath: string): { backend: IStorageBackend; localPath: string; mountPath: string } {
        if (!this._mountRouter) return { backend: this.backend, localPath: systemPath, mountPath: '/' };
        // Always translate through the resolved mount, even when a sub-mount aliases
        // the root backend. The old backend-identity shortcut made /nested/... bypass
        // its mount and read/write the root-local path instead.
        const { mount, relativePath } = this._mountRouter.resolve(systemPath);
        return { backend: mount.backend, localPath: relativePath ? '/' + relativePath : '/', mountPath: mount.mountPath };
    }

    /** Map a backend-local node to a system-path node. */
    private mapToSystemNode(node: FSNode, mountPath: string): FSNode {
        if (mountPath === '/') return node;
        const mapPath = (p: string | null) => p ? this.mapToSystemPath(p, mountPath) : null;
        return { ...node, path: mapPath(node.path)!, parentPath: mapPath(node.parentPath) };
    }

    private mapToSystemPath(path: string, mountPath: string): string {
        if (mountPath === '/') return path;
        return path === '/' ? mountPath : mountPath + path;
    }

    // ── Lifecycle ──

    async initialize(): Promise<void> {
        if (this.initialized) return;
        try {
            await this.backend.init();
            await this.bootstrap();
            await this.plugins.initAll();
            await this.devices.initAll();
            this.initialized = true;
        } catch (error) {
            const cleanup = await this.releaseResources();
            if (cleanup.length) throw new AggregateError([error, ...cleanup], 'Filesystem initialization and cleanup failed');
            throw error;
        }
    }

    async dispose(): Promise<void> {
        if (!this.initialized) return;
        this.initialized = false;
        const failures = await this.releaseResources();
        if (failures.length) throw new AggregateError(failures, 'Filesystem cleanup failed');
    }

    private async releaseResources(): Promise<unknown[]> {
        const failures: unknown[] = [];
        // Plugins/devices may still need the backend while shutting down.
        for (const close of [() => this.plugins.disposeAll(), () => this.devices.disposeAll(), () => this.backend.close()]) {
            try { await close(); } catch (error) { failures.push(error); }
        }
        this.events.clear();
        return failures;
    }

    private async bootstrap(): Promise<void> {
        // Ensure root and system directories exist
        this._inc('stat');
        if (!(await this.backend.stat('/'))) {
            this._inc('mkdir'); await this.backend.mkdir('/');
        }
        for (const dirName of SYSTEM_DIRS) {
            this._inc('stat');
            if (!(await this.backend.stat(`/${dirName}`))) {
                this._inc('mkdir'); await this.backend.mkdir(`/${dirName}`);
            }
        }
        // Ensure default system subdirectories exist (idempotent — only creates if missing)
        await this.initDefaultConfig();
    }

    /**
     * Ensure default system subdirectories under /etc exist.
     * Idempotent — does not overwrite existing files or directories.
     * Actual config file initialization is handled by the app layer via
     * ConfigService / ISystemAccess on first write.
     */
    private async initDefaultConfig(): Promise<void> {
        const etcSubdirs = ['/etc/llm'];
        for (const dir of etcSubdirs) {
            await this.ensureDirectoryPath(dir);
        }
    }

    // ── Path Resolution ──

    /** Stat a path (throws if not found) */
    async stat(path: string, options?: OperationOptions): Promise<import('../../protocol').FSNode> {
        checkOperation(options);
        const { backend, localPath, mountPath } = this.resolveStore(path);
        this._inc('stat'); const node = await backend.stat(localPath, options);
        if (!node) throw new FSError('ENOENT', 'not found', 'stat', path);
        return this.mapToSystemNode(node, mountPath);
    }

    /** Stat that returns null on not found */
    async tryStat(path: string, options?: OperationOptions): Promise<import('../../protocol').FSNode | null> {
        const { backend, localPath, mountPath } = this.resolveStore(path);
        const node = await backend.stat(localPath, options);
        return node ? this.mapToSystemNode(node, mountPath) : null;
    }

    /**
     * Type-only stat for capability checks. Prefers the backend's `statType` so a backend whose
     * `stat` fetches metadata over a remote/sidecar round trip can skip it; the reported type is
     * otherwise identical to `stat`.
     */
    async tryStatType(path: string, options?: OperationOptions): Promise<Pick<import('../../protocol').FSNode, 'type'> | null> {
        const { backend, localPath } = this.resolveStore(path);
        if (backend.statType) return backend.statType(localPath, options);
        const node = await backend.stat(localPath, options);
        return node ? { type: node.type } : null;
    }

    // ── Read ──

    async readBySystemPath(systemPath: string): Promise<FileContent> {
        return toString(await this.readContent(systemPath));
    }

    async readContent(path: string, options?: ReadOptions): Promise<ArrayBuffer> {
        try {
            const { backend, localPath } = this.resolveStore(path);
            const node = await this.tryStatType(path, options);
            if (!node) throw new FSError('ENOENT', 'not found', 'read', path);
            if (node.type === 'directory') throw new FSError('EISDIR', 'cannot read directory', 'read', path);
            this._inc('read');
            const data = await backend.read(localPath, { ...options });
            return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        } catch (error) {
            if (error instanceof FSError) throw error;
            const nativeCode = (error as { code?: string } | null)?.code;
            const code = nativeCode === 'EPERM' ? 'EACCES' : nativeCode;
            const known = ['ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR', 'EINVAL', 'ELOOP'] as const;
            throw new FSError(known.find(value => value === code) ?? 'EIO', 'Content read failed', 'read', path,
                error instanceof Error ? error : undefined);
        }
    }

    // ── Write ──

    async writeContent(
        path: string,
        content: FileContent,
        options?: WriteOptions,
    ): Promise<void> {
        const { backend, localPath } = this.resolveStore(path);

        checkOperation(options);
        if (backend.replace) {
            if (options?.mode === 'append' || options?.offset !== undefined || options?.expectedVersion !== undefined || options?.metadata)
                throw new FSCapabilityError('conditional whole-file replacement only');
            if (!options?.ifRevision) throw new FSError('ECONFLICT', 'Read the file before conditional replacement');
            const result = await backend.replace(localPath, new Uint8Array(toBuffer(content)), { kind: 'match', revision: options.ifRevision }, options);
            options.onRevision?.(result.revision); return;
        }

        if (options?.expectedVersion !== undefined) {
            this._inc('stat'); const current = await backend.stat(localPath, options);
            if (!current) throw new FSError('ENOENT', 'not found', 'write', path);
            if (current.version !== options.expectedVersion) {
                throw new FSConflictError(path, options.expectedVersion, current.version);
            }
        }

        const raw = toBuffer(content);
        let buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);

        if (options?.mode === 'append') {
            const existing = await this.readExisting(backend, localPath);
            const merged = new Uint8Array(existing.byteLength + buf.byteLength);
            merged.set(existing, 0);
            merged.set(buf, existing.byteLength);
            buf = merged;
        } else if (options?.offset !== undefined && options.offset > 0) {
            const existing = await this.readExisting(backend, localPath);
            const end = Math.max(existing.byteLength, options.offset + buf.byteLength);
            const merged = new Uint8Array(end);
            merged.set(existing, 0);
            merged.set(buf, options.offset);
            buf = merged;
        }

        this._inc('write'); await backend.write(localPath, buf);
    }

    /** Read existing content as bytes, returning empty when the file does not exist. */
    private async readExisting(backend: IStorageBackend, localPath: string): Promise<Uint8Array> {
        try {
            this._inc('read');
            return new Uint8Array(await backend.read(localPath));
        } catch {
            return new Uint8Array(0);
        }
    }

    // ── Create ──

    async createFile(
        parentPath: string,
        name: string,
        type: import('../../protocol').FSNodeType = 'file',
        content?: FileContent,
        metadata?: Record<string, unknown>,
        opts?: OperationOptions & { overwrite?: boolean; recursive?: boolean; deviceHandlerId?: string },
    ): Promise<import('../../protocol').FSNode> {
        validateFilename(name, this.filenamePattern);

        // Ensure intermediate directories when recursive is requested
        if (opts?.recursive) {
            await this.ensureDirectoryPath(parentPath, opts);
        }

        const { backend, localPath: parentLocal, mountPath } = this.resolveStore(parentPath);
        const fullPath = parentLocal === '/' ? `/${name}` : `${parentLocal}/${name}`;

        if (backend.fileStorage && metadata && Object.keys(metadata).length === 0) metadata = undefined;
        if (backend.fileStorage && (opts?.overwrite || metadata || type === 'device')) throw new FSCapabilityError('file creation options');
        if (!opts?.overwrite) {
            this._inc('stat'); const existing = await backend.stat(fullPath, opts);
            if (existing) throw new FSAlreadyExistsError(name, parentPath);
        }

        if (type === 'directory') {
            this._inc('mkdir'); const node = await backend.mkdir(fullPath, opts);
            if (metadata) { this._inc('metadata'); await backend.updateMetadata(fullPath, metadata); }
            return this.mapToSystemNode(node, mountPath);
        }

        const raw = content ? toBuffer(content) : new Uint8Array(0);
        const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        this._inc('write'); const node = backend.replace ? await backend.replace(fullPath, buf, { kind: 'create-only' }, opts) : await backend.write(fullPath, buf);

        if (type === 'device' && opts?.deviceHandlerId) {
            const deviceMeta = {
                ...(metadata ?? {}),
                [DEVICE_HANDLER_METADATA_KEY]: opts.deviceHandlerId,
            };
            this._inc('metadata'); await backend.updateMetadata(fullPath, deviceMeta);
            // Re-stat so the returned node reflects device type + handler id.
            this._inc('stat'); const finalNode = await backend.stat(fullPath);
            return this.mapToSystemNode(finalNode!, mountPath);
        }

        if (metadata) { this._inc('metadata'); await backend.updateMetadata(fullPath, metadata); }
        return this.mapToSystemNode(node, mountPath);
    }

    async createDirectory(
        parentPath: string,
        name: string,
        metadata?: Record<string, unknown>,
    ): Promise<import('../../protocol').FSNode> {
        return this.createFile(parentPath, name, 'directory', undefined, metadata);
    }

    // ── Delete ──

    async delete(path: string, options?: DeleteOptions): Promise<void> {
        const { backend, localPath } = this.resolveStore(path);
        this._inc('stat'); const node = await backend.stat(localPath, options);
        if (!node) {
            if (options?.force) return;
            throw new FSError('ENOENT', 'not found', 'delete', path);
        }
        await this.assertMutableLayout(path, options);
        this._inc('delete'); await backend.delete(localPath, options);

        // Cascade: delete companion asset dir
        if (!backend.fileStorage && node.type !== 'directory' && options?.assetDirStrategy !== 'keep') {
            const parentDir = P.dirname(localPath);
            const assetDirName = toAssetDirName(nameFromPath(localPath));
            try {
                this._inc('delete'); await backend.delete(`${parentDir}/${assetDirName}`, { recursive: true });
            } catch { /* asset dir may not exist */ }
        }
    }

    /** A persisted pin protects a storage root, its ancestors and its contents. */
    private async assertMutableLayout(path: string, options?: OperationOptions): Promise<void> {
        const stat = async (current: string) => {
            try { return await this.stat(current, options); }
            catch (error) { if (error instanceof FSError && error.code === 'ENOENT') return null; throw error; }
        };
        for (let parent = P.normalize(path); ; parent = P.dirname(parent)) {
            const node = await stat(parent);
            if (node?.metadata.vfsFixedLayout) throw new FSError('EBUSY', 'Fixed storage layout; unpin before offline migration or deletion', 'structure', path);
            if (parent === '/') break;
        }
        await this.assertMutableSubtree(path, stat, options);
    }

    private async assertMutableSubtree(path: string, stat: (path: string) => Promise<FSNode | null>, options?: OperationOptions): Promise<void> {
        const { backend, localPath } = this.resolveStore(path);
        const prefix = P.normalize(path).replace(/\/$/, '') + '/';
        const nestedMount = this._mountRouter?.listMounts().some(mount => mount.mountPath.startsWith(prefix));
        if (backend.fileStorage && !nestedMount) return;
        if (backend.assertMutableSubtree && !nestedMount) return backend.assertMutableSubtree(localPath);
        const visit = async (current: string): Promise<void> => {
            const node = await stat(current);
            if (node?.metadata.vfsFixedLayout) throw new FSError('EBUSY', 'Contains a fixed storage layout', 'structure', path);
            if (node?.type === 'directory') for (const child of await this.listChildren(current, options)) await visit(child.path);
        };
        await visit(path);
    }

    // ── Rename / Move ──

    async rename(path: string, newName: string, options?: OperationOptions): Promise<void> {
        await this.assertMutableLayout(path, options);
        validateFilename(newName, this.filenamePattern);
        const { backend, localPath } = this.resolveStore(path);
        const dir = P.dirname(localPath);
        const newPath = dir === '/' ? `/${newName}` : `${dir}/${newName}`;

        this._inc('stat'); const existing = await backend.stat(newPath, options);
        if (existing) throw new FSAlreadyExistsError(newName, dir);

        this._inc('rename'); await backend.rename(localPath, newPath, options);

        if (backend.fileStorage) return;
        // Rename companion asset dir
        const oldAssetName = toAssetDirName(nameFromPath(localPath));
        const newAssetName = toAssetDirName(newName);
        try {
            this._inc('rename'); await backend.rename(P.join(dir, oldAssetName), P.join(dir, newAssetName));
        } catch { /* no asset dir */ }
    }

    async move(sourcePath: string, targetParentPath: string, options?: OperationOptions): Promise<void> {
        await this.assertMutableLayout(sourcePath, options);
        await this.assertMutableLayout(P.join(targetParentPath, P.basename(sourcePath)), options);
        const { backend: srcBackend, localPath: srcLocal } = this.resolveStore(sourcePath);
        const { backend: dstBackend, localPath: dstLocal } = this.resolveStore(targetParentPath);

        if (srcBackend !== dstBackend) {
            throw new FSError('EXMOUNT', 'cross-mount move not supported by engine; use copy+delete', 'move', sourcePath);
        }

        const name = nameFromPath(srcLocal);
        const newPath = dstLocal === '/' ? `/${name}` : `${dstLocal}/${name}`;

        await srcBackend.rename(srcLocal, newPath, options);

        if (srcBackend.fileStorage) return;
        // Move companion asset dir
        const srcDir = P.dirname(srcLocal);
        const assetDirName = toAssetDirName(name);
        try {
            await srcBackend.rename(P.join(srcDir, assetDirName), P.join(dstLocal, assetDirName));
        } catch { /* no asset dir */ }
    }

    // ── List ──

    async listChildren(path: string, options?: OperationOptions): Promise<import('../../protocol').FSNode[]> {
        checkOperation(options);
        const { backend, localPath, mountPath } = this.resolveStore(path);
        this._inc('list'); const nodes = await backend.list(localPath, options);
        return nodes.map(n => this.mapToSystemNode(n, mountPath));
    }

    async listEntries(path: string, options?: OperationOptions): Promise<DirEntry[]> {
        checkOperation(options);
        const { backend, localPath, mountPath } = this.resolveStore(path);
        this._inc('list');
        const entries = await (backend.listEntries ? backend.listEntries(localPath, options) : backend.list(localPath, options));
        return entries.map(node => ({ path: this.mapToSystemPath(node.path, mountPath), name: node.name,
            type: node.type, modifiedAt: node.modifiedAt, ...('size' in node ? { size: node.size } : {}) }));
    }

    // ── Metadata ──

    async listTagEntries(root: string): Promise<Array<{ path: string; tag: string }>> {
        const mounts = this._mountRouter?.listMounts().map(m => ({ backend: m.backend, mountPath: m.mountPath }))
            ?? [{ backend: this.backend, mountPath: '/' }];
        const entries: Array<{ path: string; tag: string }> = [];
        for (const mount of mounts) {
            if (!P.isUnder(root, mount.mountPath) && !P.isUnder(mount.mountPath, root)) continue;
            if (!mount.backend.listTagEntries) throw new FSCapabilityError('indexed tags', mount.mountPath);
            for (const entry of await mount.backend.listTagEntries()) {
                const path = this.mapToSystemPath(entry.path, mount.mountPath);
                if (!P.isUnder(path, root)) continue;
                const owner = this.resolveStore(path);
                // Backend identity is not enough: the same backend may be mounted
                // more than once, and only the longest-prefix mount owns `path`.
                if (owner.backend === mount.backend && owner.mountPath === mount.mountPath) {
                    entries.push({ path, tag: entry.tag });
                }
            }
        }
        return entries;
    }

    async setTags(path: string, tags: string[]): Promise<void> {
        const { backend, localPath } = this.resolveStore(path);
        await backend.setTags(localPath, tags);
    }

    async updateMetadata(path: string, metadata: Record<string, unknown>): Promise<void> {
        const { backend, localPath } = this.resolveStore(path);
        this._inc('metadata'); await backend.updateMetadata(localPath, metadata);
    }

    // ── Symlink ──

    async createSymlink(parentPath: string, name: string, target: string): Promise<import('../../protocol').FSNode> {
        const { backend, localPath: parentLocal, mountPath } = this.resolveStore(parentPath);
        const fullPath = parentLocal === '/' ? `/${name}` : `${parentLocal}/${name}`;
        if (!backend.symlink) throw new FSCapabilityError('symlinks', 'engine');
        await backend.symlink(fullPath, target);
        this._inc('stat'); const node = await backend.stat(fullPath);
        if (!node) throw new FSError('EIO', 'symlink created but not found', 'symlink', fullPath);
        return this.mapToSystemNode(node, mountPath);
    }

    async readSymlink(path: string): Promise<string> {
        const { backend, localPath } = this.resolveStore(path);
        if (!backend.readlink) throw new FSCapabilityError('symlinks', 'engine');
        return backend.readlink(localPath);
    }

    // ── Asset Dir ──

    async getAssetDirPath(filePath: string): Promise<string | null> {
        const { backend, localPath, mountPath } = this.resolveStore(filePath);
        const parentDir = P.dirname(localPath);
        const name = nameFromPath(localPath);
        const assetDirName = toAssetDirName(name);
        const assetPath = parentDir === '/' ? `/${assetDirName}` : `${parentDir}/${assetDirName}`;
        this._inc('stat'); const exists = await backend.stat(assetPath);
        return exists ? this.mapToSystemPath(assetPath, mountPath) : null;
    }

    async ensureAssetDir(filePath: string): Promise<string> {
        const { backend, localPath, mountPath } = this.resolveStore(filePath);
        const parentDir = P.dirname(localPath);
        const name = nameFromPath(localPath);
        const assetDirName = toAssetDirName(name);
        const assetPath = parentDir === '/' ? `/${assetDirName}` : `${parentDir}/${assetDirName}`;

        this._inc('stat'); const existing = await backend.stat(assetPath);
        if (existing) return this.mapToSystemPath(assetPath, mountPath);

        this._inc('mkdir'); await backend.mkdir(assetPath);
        return this.mapToSystemPath(assetPath, mountPath);
    }

    // ── Search ──

    async search(path: string, query: import('../../protocol').FSSearchQuery): Promise<import('../../protocol').FSNode[]> {
        const { backend, localPath, mountPath } = this.resolveStore(path);
        const unpagedQuery = { ...query, offset: 0, limit: Number.MAX_SAFE_INTEGER };
        let nodes: import('../../protocol').FSNode[];
        if (backend.search) {
            nodes = await backend.search(unpagedQuery);
        } else {
            nodes = [];
            await this._walkAndCollect(backend, '/', unpagedQuery, nodes);
        }
        const scoped = nodes.filter(node => isPathInScope(node.path, localPath));
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 50;
        return scoped
            .slice(offset, offset + limit)
            .map(node => this.mapToSystemNode(node, mountPath));
    }

    private async _walkAndCollect(
        backend: IStorageBackend,
        dirPath: string,
        query: import('../../protocol').FSSearchQuery,
        results: import('../../protocol').FSNode[],
    ): Promise<void> {
        if (query.limit && results.length >= query.limit) return;
        try {
            this._inc('list'); const children = await backend.list(dirPath);
            for (const child of children) {
                if (query.limit && results.length >= query.limit) break;
                if (matchSearch(child, query)) results.push(child);
                if (child.type === 'directory') {
                    await this._walkAndCollect(backend, child.path, query, results);
                }
            }
        } catch { /* skip */ }
    }

    // ── System /etc Operations ──

    /**
     * 以系统身份写入任意路径（仅宿主可用）。
     * 由 ISystemAccess 实现调用，调用方负责传入已拼接的完整路径。
     */
    async writeEtcFile(path: string, content: string): Promise<void> {
        const { backend, localPath } = this.resolveStore(path);
        this._inc('write');
        const buf = new TextEncoder().encode(content);
        await backend.write(localPath, buf);
    }

    /**
     * 以系统身份读取任意路径（仅宿主可用）。
     */
    async readEtcFile(path: string): Promise<string> {
        const { backend, localPath } = this.resolveStore(path);
        try {
            this._inc('read');
            const data = await backend.read(localPath);
            return toString(data.buffer as ArrayBuffer);
        } catch {
            return '';
        }
    }

    /**
     * 列出任意目录下的条目名称。
     */
    async listEtcDir(path: string): Promise<string[]> {
        const { backend, localPath } = this.resolveStore(path);
        this._inc('list');
        const children = await backend.list(localPath);
        return children.map(c => c.name);
    }

    // ── Ensure Directory Path (recursive mkdir) ──

    async ensureDirectoryPath(systemPath: string, options?: OperationOptions): Promise<void> {
        const parts = systemPath.split('/').filter(Boolean);
        let current = '';
        for (const seg of parts) {
            current += '/' + seg;
            const { backend, localPath } = this.resolveStore(current);
            this._inc('stat');
            const exists = backend.statType ? await backend.statType(localPath, options) : await backend.stat(localPath, options);
            if (!exists) {
                this._inc('mkdir'); await backend.mkdir(localPath, options);
            } else if (exists.type !== 'directory') throw new FSError('ENOTDIR', 'Not a directory', 'mkdir', current);
        }
    }

    // ── Walk Tree ──

    async walkTree(
        rootPath: string,
        callback: (node: import('../../protocol').FSNode, depth: number) => boolean | void | 'skip' | Promise<boolean | void | 'skip'>,
        options?: { maxDepth?: number; includeHidden?: boolean; includeAssetDirs?: boolean },
    ): Promise<number> {
        const { backend, localPath } = this.resolveStore(rootPath);
        return this._walkDFS(backend, localPath, callback, 0, options?.maxDepth ?? -1, options);
    }

    private async _walkDFS(
        backend: IStorageBackend,
        path: string,
        callback: (node: import('../../protocol').FSNode, depth: number) => boolean | void | 'skip' | Promise<boolean | void | 'skip'>,
        depth: number,
        maxDepth: number,
        options?: { includeHidden?: boolean; includeAssetDirs?: boolean },
    ): Promise<number> {
        let count = 0;
        this._inc('list'); const children = await backend.list(path === '/' ? '/' : path);
        for (const child of children) {
            if (!options?.includeHidden && child.name.startsWith('.')) continue;
            if (!options?.includeAssetDirs && child.name.startsWith('_')) continue;
            const result = await callback(child, depth);
            count++;
            if (result === false) return count;
            if (result !== 'skip' && child.type === 'directory' && (maxDepth < 0 || depth < maxDepth)) {
                count += await this._walkDFS(backend, child.path, callback, depth + 1, maxDepth, options);
            }
        }
        return count;
    }
}

// ── Helpers ──

function nameFromPath(path: string): string {
    if (path === '/' || path === '') return '';
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
}

function isPathInScope(path: string, rootPath: string): boolean {
    if (rootPath === '/') return true;
    return path === rootPath || path.startsWith(`${rootPath}/`);
}

function matchSearch(node: import('../../protocol').FSNode, query: import('../../protocol').FSSearchQuery): boolean {
    if (query.type) {
        const types = Array.isArray(query.type) ? query.type : [query.type];
        if (!types.includes(node.type)) return false;
    }
    if (query.name?.contains && !node.name.toLowerCase().includes(query.name.contains.toLowerCase())) return false;
    if (query.tags?.all && !query.tags.all.every(t => node.tags.includes(t))) return false;
    if (query.tags?.any && !query.tags.any.some(t => node.tags.includes(t))) return false;
    return true;
}
