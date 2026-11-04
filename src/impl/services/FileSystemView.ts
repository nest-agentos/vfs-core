import { checkOperation, FSOperationCancelledError, type OperationOptions } from '../../protocol';
import { withOperation } from '../../utils/operation';
import type {
    IFileSystem, IFileSystemDriver, IFSMetaDriver, FSNode, FSCapabilities, DirEntry, ListOptions,
    FSEvent, FSEventType, FSSearchQuery, FSSearchResult, TreeWalkCallback, TreeWalkOptions,
    SeqFileReadRequest,
} from '../../protocol';
import { FSError, FSCapabilityError } from '../../protocol';
import { FileHandle } from '../file-io/File';
import * as P from '../../utils/path';

/** Only trusted composition code may supply sources. Sources must already be authorized. */
export interface FileSystemMount {
    readonly mountId: string;
    readonly at: string;
    readonly fs: IFileSystem;
    readonly root?: string;
    readonly access: 'ro' | 'rw';
}
export interface FileSystemViewOptions {
    viewId: string;
    revision?: number;
    /** Host files can explicitly disable MindOS tag metadata. */
    tags?: boolean;
    /** Host-owned external directories never expose or persist tag metadata. */
    external?: boolean;
    mounts: readonly FileSystemMount[];
    /** Optional host-defined visible subtrees (ancestors are visible directories). */
    readablePaths?: readonly string[];
}
type Binding = FileSystemMount & { root: string };
type Method = (...args: any[]) => any;
type Methods = Record<string, Method>;

/** Strict POSIX virtual path. No implicit host paths, URL decoding, or parent traversal. */
export function normalizeVirtualPath(path: string): string {
    if (!path.startsWith('/') || /[\\\0]/.test(path) || path.split('/').includes('..')) {
        throw new FSError('EINVAL', 'Expected an absolute virtual path without parent traversal', 'resolve');
    }
    return P.normalize(path);
}

/** Independent mount namespace. Disposing a view never disposes its shared sources. */
export class FileSystemView implements IFileSystem {
    readonly viewId: string;
    readonly revision: number;
    readonly external: boolean;
    readonly capabilities: FSCapabilities;
    readonly driver: IFileSystemDriver;
    readonly meta: IFSMetaDriver;
    private readonly mounts: Binding[];
    private readonly readablePaths?: readonly string[];
    private closed = false;
    private readonly lifetime = new AbortController();
    private active = 0;
    private drain?: () => void;
    private disposing?: Promise<void>;
    private readonly subscriptions = new Set<() => void>();

    constructor(options: FileSystemViewOptions) {
        this.viewId = options.viewId;
        this.revision = options.revision ?? 1;
        this.external = options.external === true;
        if (!this.viewId || !Number.isSafeInteger(this.revision) || this.revision < 0) throw new FSError('EINVAL', 'Invalid view identity or revision');
        this.readablePaths = options.readablePaths?.map(normalizeVirtualPath);
        this.mounts = options.mounts.map(m => ({ ...m, at: normalizeVirtualPath(m.at), root: normalizeVirtualPath(m.root ?? '/') }));
        const ids = new Set<string>();
        for (const m of this.mounts) {
            if (!m.mountId || !['ro', 'rw'].includes(m.access)) throw new FSError('EINVAL', 'Invalid mount descriptor');
            if (ids.has(m.mountId)) throw new FSError('EEXIST', 'Duplicate mount identity');
            ids.add(m.mountId);
            for (const n of this.mounts) {
                if (m === n) continue;
                if (m.fs === n.fs && (m.access === 'rw' || n.access === 'rw') && (P.isUnder(m.root, n.root) || P.isUnder(n.root, m.root))) {
                    throw new FSError('EINVAL', 'Overlapping writable aliases of one source');
                }
                if (m.at === n.at || (m.at !== '/' && P.isUnder(n.at, m.at))) {
                    throw new FSError('EINVAL', 'Duplicate or nested non-root mounts');
                }
            }
        }
        this.mounts.sort((a, b) => b.at.length - a.at.length);
        const first = this.mounts[0]?.fs.capabilities ?? { readonly: true, search: true, semanticSearch: false, syncable: false, assets: false, tags: false, deviceFiles: false, seqFiles: false, references: false, symlinks: false, hardlinks: false, partialRead: false, partialWrite: false, treeWalk: true, streaming: false, watch: false, mount: true };
        this.capabilities = Object.fromEntries(Object.keys(first ?? {}).map(key => [key,
            this.mounts.length > 0 && this.mounts.every(m => Boolean((m.fs.capabilities as any)[key])),
        ])) as unknown as FSCapabilities;
        this.capabilities = Object.freeze({ ...this.capabilities, tags: !this.external && options.tags !== false && this.mounts.some(m => m.fs.capabilities.tags), readonly: this.mounts.every(m => m.access === 'ro' || m.fs.capabilities.readonly), symlinks: false, hardlinks: false, deviceFiles: false, watch: false, semanticSearch: false, search: true, mount: true });
        this.driver = this.makeDriver();
        this.initializeFacade();
        this.meta = {
            assets: this.makeMeta('assets'), tags: this.makeMeta('tags'),
            seq: this.makeMeta('seq'), refs: this.makeMeta('refs'),
        };
    }

    openFile(path: string) { this.assertOpen(); return new FileHandle(this, normalizeVirtualPath(path)); }

    discoveryRoot(path: string): string {
        this.assertOpen();
        const target = normalizeVirtualPath(path);
        const mount = this.find(target);
        if (!mount) return '/';
        const inner = mount.fs.discoveryRoot?.(this.sourcePath(mount, target));
        return inner && P.isUnder(inner, mount.root) ? this.virtualPath(mount, inner) : mount.at;
    }

    async capabilitiesAt(path: string, options?: OperationOptions): Promise<FSCapabilities> {
        return this.operation(() => withOperation(options, async scope => {
            const m = this.find(normalizeVirtualPath(path));
            if (!m) return { ...this.capabilities, readonly: true };
            const caps = await m.fs.capabilitiesAt(this.sourcePath(m, path), scope);
            return { ...caps, tags: this.capabilities.tags && caps.tags, symlinks: false, hardlinks: false, deviceFiles: false, watch: false, readonly: m.access === 'ro' || caps.readonly };
        }, this.lifetime.signal));
    }

    dispose(): Promise<void> {
        if (this.disposing) return this.disposing;
        this.closed = true;
        this.lifetime.abort(new FSOperationCancelledError());
        for (const unsubscribe of this.subscriptions) unsubscribe();
        this.subscriptions.clear();
        this.disposing = this.active === 0 ? Promise.resolve() : new Promise(resolve => { this.drain = resolve; });
        return this.disposing;
    }

    private assertOpen() { if (this.closed) throw new FSError('EACCES', 'File view is closed'); }
    private async operation<T>(fn: () => Promise<T>): Promise<T> {
        this.assertOpen();
        this.active++;
        try { return await fn(); } finally { if (--this.active === 0) this.drain?.(); }
    }
    private find(path: string) { return this.mounts.find(m => P.isUnder(path, m.at)); }
    private readable(path: string) { return !this.readablePaths || this.readablePaths.some(root => P.isUnder(path, root)); }
    private visible(path: string) { return path === '/' || !this.readablePaths || this.readablePaths.some(root => P.isUnder(path, root) || P.isUnder(root, path)); }
    private sourcePath(m: Binding, path: string) { return P.join(m.root, P.relative(m.at, normalizeVirtualPath(path))); }
    private virtualPath(m: Binding, path: string): string {
        path = normalizeVirtualPath(path);
        if (!P.isUnder(path, m.root)) throw new FSError('EACCES', 'Source returned a path outside its granted root');
        const virtual = P.join(m.at, P.relative(m.root, path));
        if (!this.visible(virtual)) throw new FSError('EACCES', 'Path is outside the system projection');
        if (this.find(virtual) !== m) throw new FSError('EACCES', 'Path is hidden by another mount');
        return virtual;
    }
    private node(m: Binding, node: FSNode): FSNode {
        const { viewId: _viewId, ...value } = node;
        const path = this.virtualPath(m, node.path);
        if (!this.readable(path)) return { path, parentPath: path === '/' ? null : P.dirname(path), name: P.basename(path), type: 'directory', createdAt: 0, modifiedAt: 0, version: this.revision, tags: [], metadata: {} };
        return { ...value, tags: this.capabilities.tags && m.fs.capabilities.tags ? value.tags : [], path, name: P.basename(path), parentPath: path === '/' ? null : P.dirname(path),
            ...('assetDirPath' in node && node.assetDirPath ? { assetDirPath: this.virtualPath(m, node.assetDirPath) } : {}),
        } as FSNode;
    }
    private synthetic(path: string): FSNode | null {
        if (path !== '/' && !this.mounts.some(m => P.isUnder(m.at, path))) return null;
        return { path, parentPath: path === '/' ? null : P.dirname(path), name: P.basename(path),
            type: 'directory', createdAt: 0, modifiedAt: 0, version: this.revision, tags: [], metadata: {} };
    }
    private binding(path: string, write = false, structural = false): Binding {
        path = normalizeVirtualPath(path);
        if (!this.visible(path)) throw new FSError('EACCES', 'Path is outside the system projection');
        const m = this.find(path);
        if (!m) throw new FSError(write ? 'EROFS' : 'ENOENT', 'No source mounted at this path', undefined, path);
        // Mount names match case-sensitively, like every other virtual route in this view.
        if (structural && this.mounts.some(n => P.isUnder(n.at, path))) throw new FSError('EBUSY', 'Cannot replace a mount or its ancestor', undefined, path);
        if (write && m.access === 'ro') throw new FSError('EROFS', 'Read-only mount', undefined, path);
        return m;
    }
    private async noLinks(m: Binding, path: string, options?: OperationOptions,
        probes?: Map<string, Promise<Pick<FSNode, 'type'> | null>>): Promise<Pick<FSNode, 'type'> | null | undefined> {
        checkOperation(options);
        const source = this.sourcePath(m, path);
        // The prefix walk only needs the node type. Prefer the driver's type-only lookup so a
        // backend whose `getNode` fetches metadata over a remote/sidecar round trip can skip it.
        // Segments are checked concurrently; a backend coalesces those type stats into one host call.
        const driver = m.fs.driver as unknown as { getNodeType?: (p: string) => Promise<Pick<FSNode, 'type'> | null> };
        const segments: string[] = [];
        let current = '/';
        for (const part of source.split('/').filter(Boolean)) {
            current = P.join(current, part);
            segments.push(current);
        }
        const checked = await Promise.all(segments.map(async segment => {
            try {
                let request = probes?.get(segment);
                if (!request) {
                    request = typeof driver.getNodeType === 'function'
                        ? this.invoke(m, driver, 'getNodeType', [segment, options])
                        : this.invoke(m, m.fs.driver, 'getNode', [segment, options]);
                    probes?.set(segment, request);
                }
                return { node: await request };
            } catch (error) {
                // Settle every check: a rejected sibling must not escape as an unhandled rejection.
                return { error };
            }
        }));
        for (const entry of checked) {
            if ('error' in entry) throw entry.error;
            const node = entry.node;
            if (node && node.type !== 'directory' && node.type !== 'file' && node.type !== 'seqfile') {
                throw new FSError('EACCES', 'Links and device nodes require a separate capability');
            }
        }
        const target = checked.at(-1);
        return target && 'node' in target ? target.node ?? null : undefined;
    }
    private async invoke(_m: Binding, api: object, method: string, args: any[]) {
        const fn = (api as Methods)[method];
        if (typeof fn !== 'function') throw new FSCapabilityError(method);
        // Provider errors must not expose its backing paths in a view error, so the
        // message stays generic. The original error rides along as `cause` — without
        // it a read-only or capability failure is indistinguishable from a real I/O fault.
        try { return await fn.apply(api, args); }
        catch (error) {
            if (error instanceof FSOperationCancelledError) throw error;
            if (error instanceof FSError) {
                const wrapped = new FSError(error.code, `Source operation failed: ${method}`, method, undefined, error);
                const receipt = error as FSError & { operationId?: string; outcome?: string };
                if (receipt.operationId) Object.assign(wrapped, { operationId: receipt.operationId, outcome: receipt.outcome });
                throw wrapped;
            }
            throw new FSError('EIO', `Source operation failed: ${method}`, method, undefined,
                error instanceof Error ? error : undefined);
        }
    }

    private makeDriver(): IFileSystemDriver {
        const methods: Methods = {
            getNode: (path: string, options?: OperationOptions) => this.stat(path, options),
            getNodeType: (path: string, options?: OperationOptions) => this.statType(path, options),
            getStats: async () => {
                let fileCount = 0, directoryCount = 0, totalSize = 0, lastModifiedAt = 0;
                await this.walk(node => {
                    if (node.type === 'directory') directoryCount++; else fileCount++;
                    if ('size' in node) totalSize += node.size ?? 0;
                    lastModifiedAt = Math.max(lastModifiedAt, node.modifiedAt);
                });
                return { fileCount, directoryCount, totalSize, lastModifiedAt };
            },
            exists: async (path: string, options?: OperationOptions) => (await this.statType(path, options)) !== null,
            resolvePath: async (path: string, options?: OperationOptions) => await this.statType(path, options) ? normalizeVirtualPath(path) : null,
            getChildren: (path: string, options?: ListOptions) => this.children(path, options),
            search: (query: FSSearchQuery) => this.search(query),
            walkTree: (callback: TreeWalkCallback, options?: TreeWalkOptions) => this.walk(callback, options),
            transaction: (fn: Method) => this.transaction('/', fn),
        };
        for (const method of ['readContent', 'writeContent', 'appendContent', 'updateMetadata', 'createFile', 'createDirectory', 'rename', 'move', 'delete', 'copy']) {
            methods[method] = (...args) => this.driverCall(method, args);
        }
        for (const method of ['symlink', 'hardlink', 'readlink']) methods[method] = async () => { throw new FSCapabilityError(method); };
        return { ...methods, capabilities: this.capabilities, on: this.on.bind(this), onAny: this.onAny.bind(this) } as unknown as IFileSystemDriver;
    }

    private async stat(input: string, options?: OperationOptions): Promise<FSNode | null> {
        const path = normalizeVirtualPath(input);
        if (!this.visible(path)) throw new FSError('EACCES', 'Path is outside the system projection');
        const m = this.find(path);
        if (m) {
            await this.noLinks(m, path, options);
            const value = await this.invoke(m, m.fs.driver, 'getNode', [this.sourcePath(m, path), options]);
            if (value) return this.node(m, value);
        }
        return this.synthetic(path);
    }

    /**
     * Type-only `stat` for capability checks. Validates the path on its mount exactly like `stat`,
     * but never asks for metadata; a nested view therefore keeps a prefix walk metadata-free.
     */
    private async statType(input: string, options?: OperationOptions): Promise<Pick<FSNode, 'type'> | null> {
        const path = normalizeVirtualPath(input);
        if (!this.visible(path)) throw new FSError('EACCES', 'Path is outside the system projection');
        const m = this.find(path);
        if (m) {
            const sourceType = await this.mountedType(m, path, options);
            if (sourceType) return sourceType;
        }
        const synthetic = this.synthetic(path);
        return synthetic ? { type: synthetic.type } : null;
    }

    private async mountedType(m: Binding, path: string, options?: OperationOptions): Promise<Pick<FSNode, 'type'> | null> {
        const checked = await this.noLinks(m, path, options);
        if (checked) return { type: checked.type };
        if (checked === null) return null;
        const source = this.sourcePath(m, path);
        const driver = m.fs.driver as unknown as { getNodeType?: (p: string) => Promise<Pick<FSNode, 'type'> | null> };
        const node = typeof driver.getNodeType === 'function'
            ? await this.invoke(m, driver, 'getNodeType', [source, options])
            : await this.invoke(m, m.fs.driver, 'getNode', [source, options]);
        return node ? { type: node.type } : null;
    }
    private entry(m: Binding, node: DirEntry): DirEntry {
        const path = this.virtualPath(m, node.path);
        return this.readable(path) ? { path, name: P.basename(path), type: node.type,
            modifiedAt: node.modifiedAt, ...('size' in node ? { size: node.size } : {}) }
            : { path, name: P.basename(path), type: 'directory', modifiedAt: 0 };
    }

    private async children(input: string, options?: ListOptions): Promise<Array<FSNode | DirEntry>> {
        const path = normalizeVirtualPath(input);
        if (!this.visible(path)) throw new FSError('EACCES', 'Path is outside the system projection');
        const m = this.find(path);
        const sourceType = m ? await this.mountedType(m, path, options) : null;
        const synthetic = sourceType ? null : this.synthetic(path);
        const parent = sourceType ?? (synthetic ? { type: synthetic.type } : null);
        if (!parent) throw new FSError('ENOENT', 'Directory not found', 'list', path);
        if (parent.type !== 'directory') throw new FSError('ENOTDIR', 'Not a directory', 'list', path);
        const entries = new Map<string, FSNode | DirEntry>();
        if (m && sourceType) {
            const nodes: Array<FSNode | DirEntry> = await this.invoke(m, m.fs.driver, 'getChildren', [this.sourcePath(m, path), options]);
            for (const n of nodes) {
                if (!P.isUnder(n.path, m.root) || P.dirname(n.path) !== this.sourcePath(m, path)) throw new FSError('EACCES', 'Invalid source listing');
                const vp = P.join(m.at, P.relative(m.root, n.path));
                if (this.visible(vp) && this.find(vp) === m) entries.set(n.name,
                    options?.fields === 'entry' ? this.entry(m, n) : this.node(m, n as FSNode));
            }
        }
        for (const mount of this.mounts) {
            if (mount.at === path || !P.isUnder(mount.at, path)) continue;
            const name = P.relative(path, mount.at).split('/')[0];
            const child = await this.stat(P.join(path, name), options);
            if (child) entries.set(name, options?.fields === 'entry'
                ? { path: child.path, name: child.name, type: child.type, modifiedAt: child.modifiedAt,
                    ...('size' in child ? { size: child.size } : {}) } : child);
        }
        return [...entries.values()];
    }

    private async driverCall(method: string, input: any[], api?: object, expected?: Binding): Promise<any> {
        const args = [...input];
        const options = method === 'readContent' ? args[1] : method === 'writeContent' ? args[2]
            : method === 'createFile' || method === 'createDirectory' ? args[0] : method === 'delete' ? args[1] : ['rename', 'move'].includes(method) ? args[2] : undefined;
        checkOperation(options);
        let paths: string[];
        const create = method === 'createFile' || method === 'createDirectory';
        if (create) {
            const name = args[0].name;
            if (typeof name !== 'string' || !name || name.includes('/') || /[\\\0]/.test(name) || name === '.' || name === '..') throw new FSError('EINVAL', 'Invalid name');
            paths = [P.join(normalizeVirtualPath(args[0].parentPath ?? '/'), name)];
        } else paths = Array.isArray(args[0]) ? args[0].map(normalizeVirtualPath) : [normalizeVirtualPath(args[0])];
        if (paths.some(path => !this.readable(path))) throw new FSError('EACCES', 'Projection ancestors are navigation only');
        const write = method !== 'readContent';
        const structural = ['rename', 'move', 'delete', 'copy'].includes(method) || create;
        const m = this.binding(paths[0], write, structural);
        if (expected && m !== expected) throw new FSError('EXMOUNT', 'Transaction crossed a mount');
        for (const path of paths) {
            if (this.binding(path, write, structural) !== m) throw new FSError('EXMOUNT', 'Operation crossed a mount');
            await this.noLinks(m, path, options);
        }
        if (method === 'move' || method === 'copy') {
            const target = normalizeVirtualPath(args[1] ?? '/');
            if (this.binding(target, true) !== m) throw new FSError('EXMOUNT', 'Cross-mount move/copy requires an explicit copy operation');
            if (method === 'copy' && args[2] !== undefined && (typeof args[2] !== 'string' || !args[2] || args[2].includes('/') || /[\\\0]/.test(args[2]) || ['.', '..'].includes(args[2]))) throw new FSError('EINVAL', 'Invalid copy name');
            for (const path of paths) {
                const destination = P.join(target, args[2] && method === 'copy' ? args[2] : P.basename(path));
                if (this.binding(destination, true, true) !== m) throw new FSError('EXMOUNT', 'Destination crossed a mount');
                await this.noLinks(m, destination, options);
            }
            if (method === 'copy' && (await this.stat(paths[0]))?.type === 'directory') throw new FSCapabilityError('Recursive copy requires a view-aware copy operation');
            await this.noLinks(m, target, options);
            args[1] = this.sourcePath(m, target);
        }
        if (method === 'rename') {
            if (typeof args[1] !== 'string' || !args[1] || args[1].includes('/') || /[\\\0]/.test(args[1]) || args[1] === '.' || args[1] === '..') throw new FSError('EINVAL', 'Invalid name');
            this.binding(P.join(P.dirname(paths[0]), args[1]), true, true);
        }
        args[0] = create ? { ...args[0], parentPath: this.sourcePath(m, normalizeVirtualPath(args[0].parentPath ?? '/')) }
            : Array.isArray(args[0]) ? paths.map(p => this.sourcePath(m, p)) : this.sourcePath(m, paths[0]);
        const result = await this.invoke(m, api ?? m.fs.driver, method, args);
        return result && typeof result === 'object' && 'path' in result ? this.node(m, result) : result;
    }

    /** Explicit scope is required when the view has more than one mount. */
    async transaction<T>(scopePath: string, fn: (tx: any) => Promise<T>): Promise<T> {
        return this.operation(async () => {
            const m = this.binding(scopePath, true);
            if (this.mounts.some(n => n !== m && P.isUnder(n.at, scopePath))) throw new FSError('EXMOUNT', 'Transaction scope contains other mounts');
            if (!m.fs.capabilities.atomicFileTransactions) throw new FSCapabilityError('transactions');
            return m.fs.driver.transaction(tx => fn(new Proxy({}, { get: (_, key: string) => (...args: any[]) => {
                if (key === 'getNode') return this.statInTransaction(m, tx, args[0], args[1]);
                return this.driverCall(key, args, tx, m);
            } })));
        });
    }
    private async statInTransaction(m: Binding, tx: object, path: string, options?: OperationOptions) {
        if (this.binding(path) !== m) throw new FSError('EXMOUNT', 'Transaction crossed a mount');
        await this.noLinks(m, path, options);
        const node = await this.invoke(m, tx, 'getNode', [this.sourcePath(m, path), options]);
        return node ? this.node(m, node) : null;
    }

    private async indexedTags(): Promise<Array<{ path: string; tag: string }>> {
        if (!this.capabilities.tags) return [];
        const entries: Array<{ path: string; tag: string }> = [];
        for (const mount of this.mounts) {
            if (!mount.fs.capabilities.tags) continue;
            if (!mount.fs.meta.tags.listTagEntries) throw new FSCapabilityError('indexed tags');
            for (const entry of await mount.fs.meta.tags.listTagEntries()) {
                if (!P.isUnder(entry.path, mount.root)) continue;
                const path = P.join(mount.at, P.relative(mount.root, entry.path));
                if (this.readable(path) && this.find(path) === mount) entries.push({ path, tag: entry.tag });
            }
        }
        return entries;
    }

    private makeMeta(group: 'assets' | 'tags' | 'seq' | 'refs'): any {
        return new Proxy({}, { get: (_, method: string) => (...args: any[]) => this.operation(async () => {
            if (group === 'tags' && method === 'listTagEntries') return this.indexedTags();
            if (group === 'tags' && method === 'getAllTags') {
                const counts = new Map<string, number>();
                for (const { tag } of await this.indexedTags()) counts.set(tag, (counts.get(tag) ?? 0) + 1);
                return [...counts].map(([name, refCount]) => ({ name, refCount }));
            }
            if (group === 'tags' && method === 'walkByTag') {
                const matches = (await this.indexedTags()).filter(entry => entry.tag === args[0]).map(entry => entry.path).sort();
                let processed = 0;
                for (const path of matches.slice(args[2]?.offset ?? 0, args[2]?.limit === undefined ? undefined : (args[2]?.offset ?? 0) + args[2].limit)) {
                    processed++; if (await args[1](path) === false) break;
                }
                return { total: matches.length, processed };
            }
            if (group === 'tags' && !this.capabilities.tags) throw new FSCapabilityError('tags');
            if (group === 'seq' && method === 'transaction') {
                if (this.mounts.length !== 1) throw new FSCapabilityError('Use seqTransaction(scopePath, fn) for multiple mounts');
                return this.seqTransaction(this.mounts[0].at, args[0]);
            }
            if (group === 'tags' && !['setTags', 'addTag', 'removeTag'].includes(method)) throw new FSCapabilityError(method);
            return this.metaCall(group, method, args);
        }) });
    }
    /**
     * 多路径 seq 读：逐条把虚拟路径映射到挂载源路径后，交给挂载后端一次读取。
     * 与单路径读相同的挂载/可见性校验，避免批量接口绕过视图边界。
     */
    private async seqEntriesMany(
        requests: ReadonlyArray<SeqFileReadRequest>,
        api: object | undefined,
        expected: Binding | undefined,
    ): Promise<Array<string | null>> {
        if (!requests.length) return [];
        const mapped: Array<{ fileIdOrPath: string; key: string }> = [];
        const paths: string[] = [];
        let owner: Binding | undefined = expected;
        for (const request of requests) {
            const path = normalizeVirtualPath(request.fileIdOrPath);
            if (!this.readable(path)) throw new FSError('EACCES', 'Projection ancestors are navigation only');
            const mount = this.binding(path, false);
            if (owner && owner !== mount) throw new FSError('EXMOUNT', 'Record transaction crossed a mount');
            owner = mount;
            if (!api) paths.push(path);
            mapped.push({ fileIdOrPath: this.sourcePath(mount, path), key: request.key });
        }
        if (paths.length) {
            const probes = new Map<string, Promise<Pick<FSNode, 'type'> | null>>();
            const checked = await Promise.allSettled(paths.map(path => this.noLinks(owner!, path, undefined, probes)));
            const failed = checked.find(result => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
        }
        const target = (api ?? owner?.fs.meta?.seq) as { getEntriesMany?: unknown } | undefined;
        if (!target?.getEntriesMany) throw new FSCapabilityError('seq.getEntriesMany');
        return this.invoke(owner!, target, 'getEntriesMany', [mapped]);
    }
    private async metaCall(group: string, method: string, input: any[], api?: object, expected?: Binding): Promise<any> {
        if (group === 'tags' && !this.capabilities.tags) throw new FSCapabilityError('tags');
        const allowed: Record<string, readonly string[]> = {
            assets: ['getAssetDirPath', 'ensureAssetDir', 'putAsset', 'getAsset', 'deleteAsset', 'listAssets', 'removeAssetDir', 'hasAssetDir', 'validateAssetDir', 'repairAssetDir'],
            tags: ['setTags', 'addTag', 'removeTag'],
            seq: ['getEntry', 'getEntries', 'getEntriesMany', 'setEntry', 'setEntries', 'deleteEntry', 'hasEntry', 'walkEntries', 'queryEntries', 'createIndex', 'deleteIndex', 'compareAndSet', 'increment', 'append'],
            refs: ['addRef', 'removeRef', 'hasRef', 'walkOutgoing', 'walkIncoming', 'syncOutgoing'],
        };
        if (!allowed[group]?.includes(method)) throw new FSCapabilityError(method);
        if (group === 'seq' && method === 'getEntriesMany') {
            return this.seqEntriesMany(input[0] ?? [], api, expected);
        }
        const args = [...input];
        const options = method === 'readContent' ? args[1] : method === 'writeContent' ? args[2]
            : method === 'createFile' || method === 'createDirectory' ? args[0] : method === 'delete' ? args[1] : ['rename', 'move'].includes(method) ? args[2] : undefined;
        checkOperation(options);
        const write = !/^(get|has|list|walk|query|validate)/.test(method);
        const path = normalizeVirtualPath(args[0]);
        if (!this.readable(path)) throw new FSError('EACCES', 'Projection ancestors are navigation only');
        const m = this.binding(path, write);
        if (expected && expected !== m) throw new FSError('EXMOUNT', 'Record transaction crossed a mount');
        // IndexedDB transactions auto-commit while unrelated node IO is awaited.
        // Record transactions only accept sources without link traversal; their
        // callback performs synchronous path/mount checks and record IO alone.
        if (!api) await this.noLinks(m, path);
        const target = api ?? (m.fs.meta as any)[group];
        if (!target) throw new FSCapabilityError(group);
        args[0] = this.sourcePath(m, path);
        let ownerAssetPath: string | undefined;
        if (group === 'assets') {
            const directory = await this.invoke(m, target, 'getAssetDirPath', [args[0]]);
            if (directory) {
                const assetPath = ownerAssetPath = this.virtualPath(m, directory);
                if (!this.readable(assetPath)) throw new FSError('EACCES', 'Asset directory is outside the projection');
                await this.noLinks(m, assetPath);
            } else if (write) {
                // Asset providers may create a companion sibling. Its prospective path
                // must also fit inside the mount before allowing a side effect.
                const assetPath = ownerAssetPath = P.join(P.dirname(path), '_' + P.basename(path));
                if (!this.readable(assetPath) || this.binding(assetPath, true) !== m) throw new FSError('EACCES', 'Asset directory is outside the projection');
            }
        }
        if (group === 'assets' && ['putAsset', 'getAsset', 'deleteAsset'].includes(method)) {
            if (typeof args[1] !== 'string' || !args[1] || args[1].startsWith('/')) throw new FSError('EINVAL', 'Invalid asset name');
            normalizeVirtualPath('/' + args[1]);
            if (ownerAssetPath) {
                const asset = P.join(ownerAssetPath, args[1]);
                if (!this.readable(asset) || this.binding(asset, write) !== m) throw new FSError('EACCES', 'Asset is outside its mount');
                await this.noLinks(m, asset);
            }
        }
        if (group === 'refs') {
            if (['addRef', 'removeRef', 'hasRef'].includes(method)) {
                const second = normalizeVirtualPath(args[1]);
                if (this.binding(second, write) !== m) throw new FSError('EXMOUNT', 'References must stay within one mount');
                args[1] = this.sourcePath(m, second);
            } else if (method === 'walkOutgoing' || method === 'walkIncoming') {
                const callback = args[1];
                args[1] = (ref: any) => {
                    try { return callback({ ...ref, sourcePath: this.virtualPath(m, ref.sourcePath), targetPath: this.virtualPath(m, ref.targetPath) }); }
                    catch (error) { if (error instanceof FSError && error.code === 'EACCES') return true; throw error; }
                };
            } else if (method === 'syncOutgoing') {
                args[1] = args[1].map((ref: any) => {
                    if (this.binding(ref.targetPath, true) !== m) throw new FSError('EXMOUNT', 'Reference crossed a mount');
                    return { ...ref, targetPath: this.sourcePath(m, ref.targetPath) };
                });
            }
        }
        if (method === 'removeAssetDir' && ownerAssetPath) this.binding(ownerAssetPath, true, true);
        const result = await this.invoke(m, target, method, args);
        if (group === 'assets') {
            if (method === 'putAsset') return this.node(m, result);
            if (method === 'getAssetDirPath' || method === 'ensureAssetDir') return result ? this.virtualPath(m, result) : result;
        }
        return result;
    }
    async seqTransaction<T>(scopePath: string, fn: (tx: any) => Promise<T>): Promise<T> {
        return this.operation(async () => {
            const m = this.binding(scopePath, true);
            if (m.fs.capabilities.symlinks) throw new FSCapabilityError('linkSafeRecordTransactions');
            const seq = m.fs.meta.seq;
            if (!seq?.transaction) throw new FSCapabilityError('seq.transaction');
            return seq.transaction(async tx => {
                let active = true;
                try {
                    return await fn(new Proxy({}, { get: (_, key: string) => (...args: any[]) => {
                        if (!active) return Promise.reject(new FSError('EACCES', 'Record transaction is closed'));
                        return this.metaCall('seq', key, args, tx, m);
                    } }));
                } finally { active = false; }
            });
        });
    }

    private async walk(callback: TreeWalkCallback, options: TreeWalkOptions = {}): Promise<number> {
        const root = normalizeVirtualPath(options.rootPath ?? '/');
        const queue: Array<[string, number]> = [[root, 0]];
        let processed = 0;
        while (queue.length) {
            const [path, depth] = queue.shift()!;
            checkOperation(options);
            const node = await this.stat(path, options);
            if (!node) continue;
            const types = options.typeFilter ? [options.typeFilter].flat() : undefined;
            let result: Awaited<ReturnType<TreeWalkCallback>> = undefined;
            if (!types || types.includes(node.type)) {
                if (options.limit !== undefined && processed >= options.limit) break;
                processed++; result = await callback(node, depth);
                if (result === false) break;
            }
            if (result === 'skip' || node.type !== 'directory' || (options.maxDepth !== undefined && options.maxDepth >= 0 && depth >= options.maxDepth)) continue;
            const children = (await this.children(path, options)).map(n => [n.path, depth + 1] as [string, number]);
            if (options.order === 'breadth-first') queue.push(...children); else queue.unshift(...children);
        }
        return processed;
    }
    private async search(query: FSSearchQuery): Promise<FSSearchResult> {
        if (query.vector || query.semanticText || query.minScore !== undefined) throw new FSCapabilityError('semanticSearch');
        const offset = query.offset ?? 0, limit = query.limit ?? 50;
        if (![offset, limit].every(n => Number.isSafeInteger(n) && n >= 0)) throw new FSError('EINVAL', 'Invalid search pagination');
        const nodes: FSNode[] = [];
        let visited = 0;
        // Walk the namespace itself: provider-wide searches can read outside granted roots.
        await this.walk(async node => {
            if (++visited > 10000) throw new FSError('EIO', 'Search traversal limit exceeded');
            if (node.path === '/') return;
            const types = query.type ? [query.type].flat() : undefined;
            if (types && !types.includes(node.type)) return;
            const name = node.name.toLowerCase();
            const q = query.name;
            if (q?.exact !== undefined && name !== q.exact.toLowerCase()) return;
            if (q?.contains !== undefined && !name.includes(q.contains.toLowerCase())) return;
            if (q?.startsWith !== undefined && !name.startsWith(q.startsWith.toLowerCase())) return;
            if (q?.endsWith !== undefined && !name.endsWith(q.endsWith.toLowerCase())) return;
            if (q?.pattern) {
                const pattern = q.pattern.split('').map(c => c === '*' ? '.*' : c === '?' ? '.' : /[a-z0-9_-]/i.test(c) ? c : '\\' + c).join('');
                if (!new RegExp('^' + pattern + '$', 'i').test(node.name)) return;
            }
            if (query.tags?.all && !query.tags.all.every(t => node.tags.includes(t))) return;
            if (query.tags?.any && !query.tags.any.some(t => node.tags.includes(t))) return;
            if (query.tags?.none?.some(t => node.tags.includes(t))) return;
            if (query.metadata && !Object.entries(query.metadata).every(([key, value]) => Object.is(node.metadata[key], value))) return;
            if (query.modifiedAfter !== undefined && node.modifiedAt <= query.modifiedAfter) return;
            if (query.modifiedBefore !== undefined && node.modifiedAt >= query.modifiedBefore) return;
            if (query.referencedBy && !await this.hasAnyReference(query.referencedBy, node.path)) return;
            if (query.references && !await this.hasAnyReference(node.path, query.references)) return;
            if (query.text) {
                if (node.type !== 'file' || !this.readable(node.path)) return;
                const text = await this.driverCall('readContent', [node.path, { encoding: 'utf-8', signal: query.signal, timeoutMs: query.timeoutMs }]);
                if (!text.toLowerCase().includes(query.text.toLowerCase())) return;
            }
            nodes.push(node);
        }, { signal: query.signal, timeoutMs: query.timeoutMs, includeHidden: true, includeInternalDirs: true, includeAssetDirs: true });
        const order = query.orderBy;
        nodes.sort((a, b) => {
            const av = order ? (order === 'name' ? a.name.toLowerCase() : order === 'size' ? ('size' in a ? a.size : 0) : a[order]) : a.path;
            const bv = order ? (order === 'name' ? b.name.toLowerCase() : order === 'size' ? ('size' in b ? b.size : 0) : b[order]) : b.path;
            return (av < bv ? -1 : av > bv ? 1 : a.path.localeCompare(b.path)) * (query.orderDirection === 'desc' ? -1 : 1);
        });
        return { nodes: nodes.slice(offset, offset + limit), total: nodes.length, hasMore: nodes.length > offset + limit };
    }

    private async hasAnyReference(from: string, to: string): Promise<boolean> {
        if (!this.find(normalizeVirtualPath(from)) || !this.find(normalizeVirtualPath(to))) return false;
        if (this.binding(from) !== this.binding(to)) return false;
        let found = false;
        await this.metaCall('refs', 'walkOutgoing', [from, (ref: { targetPath: string }) => {
            if (ref.targetPath === to) found = true;
            return !found;
        }]);
        return found;
    }

    on<E extends FSEventType>(type: E, callback: (event: FSEvent<E>) => void): () => void {
        return this.onAny(event => { if (event.type === type) callback(event as FSEvent<E>); });
    }
    onAny(callback: (event: FSEvent) => void): () => void {
        this.assertOpen();
        const off = this.mounts.map(m => m.fs.onAny?.(event => {
            if (this.closed) return;
            if (!event.type.startsWith('node:') && event.type !== 'seq:committed') return;
            try {
                const payload = this.eventPayload(m, event.payload);
                callback({ type: event.type, timestamp: event.timestamp, fromTransaction: event.fromTransaction,
                    payload, mountId: m.mountId, viewId: this.viewId, revision: this.revision });
            } catch (error) { if (!(error instanceof FSError)) throw error; }
        })).filter((fn): fn is () => void => Boolean(fn));
        const unsubscribe = () => { for (const fn of off) fn(); this.subscriptions.delete(unsubscribe); };
        this.subscriptions.add(unsubscribe);
        return unsubscribe;
    }
    private eventPayload(m: Binding, value: any, key = ''): any {
        if (typeof value === 'string' && /paths?$/i.test(key)) return this.virtualPath(m, value);
        if (Array.isArray(value)) return value.map(v => this.eventPayload(m, v, key));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.eventPayload(m, v, k)]));
        return value;
    }

    /** All public driver entry points, including cached metadata, pass the lifetime gate. */
    private initializeFacade(): this {
        for (const key of Object.keys(this.driver)) {
            if (key === 'on' || key === 'onAny' || typeof (this.driver as any)[key] !== 'function') continue;
            const method = (this.driver as any)[key];
            (this.driver as any)[key] = (...args: any[]) => this.operation(() => {
                const index = ['createFile', 'createDirectory', 'search'].includes(key) ? 0 : ['writeContent', 'rename', 'move'].includes(key) ? 2
                    : ['getNode', 'getNodeType', 'exists', 'resolvePath', 'getChildren', 'readContent', 'walkTree', 'delete'].includes(key) ? 1 : -1;
                if (index < 0) return method(...args);
                return withOperation(args[index], options => {
                    args[index] = { ...args[index], ...options };
                    return method(...args);
                }, this.lifetime.signal);
            });
        }
        return this;
    }
}

export function createFileSystemView(options: FileSystemViewOptions): FileSystemView {
    return new FileSystemView(options);
}
