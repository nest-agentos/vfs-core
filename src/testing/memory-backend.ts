/**
 * @file packages/vfs-core/src/impl/backend/memory-backend.ts
 * @desc 内存存储后端 — path-based IStorageBackend（测试和临时存储用）
 *
 * v4.1: 简化为 path-based 统一接口，放弃 IInodeStore/IMetaStore/IContentStore 三层分离。
 */

import type {
    IStorageBackend,
    FSNode,
    FSFileNode,
    FSDirectoryNode,
    FSDeviceNode,
    FSSearchQuery,
    IRecordStore,
    IRecordTransaction,
    RecordFieldRequest,
    RecordValue,
    RecordQuery,
    RecordQueryOptions,
    RecordQueryResult,
    RecordWalkOptions,
} from '../protocol';
import { DEVICE_HANDLER_METADATA_KEY } from '../protocol';

interface Entry {
    type: 'file' | 'directory';
    content: Uint8Array;
    createdAt: number;
    modifiedAt: number;
    version: number;
    tags: string[];
    metadata: Record<string, unknown>;
    icon?: string;
    symlinkTarget?: string;
    extra?: Record<string, unknown>;
}

const ROOT_ENTRY: Entry = Object.freeze({
    type: 'directory' as const,
    content: new Uint8Array(0),
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    version: 1,
    tags: [],
    metadata: {},
});

export class MemoryBackend implements IStorageBackend {
    readonly name = 'memory';
    readonly records = new MemoryRecordStore();
    private data = new Map<string, Entry>();

    async init(): Promise<void> {
        this.data.set('/', { ...ROOT_ENTRY, createdAt: Date.now(), modifiedAt: Date.now() });
    }

    async close(): Promise<void> {
        this.data.clear();
        this.records.clear();
    }

    // ── Structure ──

    async stat(path: string): Promise<FSNode | null> {
        const entry = this.data.get(normalize(path));
        if (!entry) return null;
        return toFSNode(path, entry);
    }

    async list(path: string): Promise<FSNode[]> {
        const parent = normalize(path);
        if (!this.data.has(parent)) return [];
        const prefix = parent === '/' ? '/' : parent + '/';
        const seen = new Set<string>();
        const results: FSNode[] = [];

        for (const [p] of this.data) {
            if (p === parent || !p.startsWith(prefix)) continue;
            const rest = p.slice(prefix.length);
            const segEnd = rest.indexOf('/');
            const seg = segEnd === -1 ? rest : rest.slice(0, segEnd);
            const fullPath = segEnd === -1 ? p : parent + '/' + seg;
            if (seen.has(fullPath)) continue;
            seen.add(fullPath);

            const childEntry = this.data.get(fullPath);
            if (childEntry) {
                results.push(toFSNode(fullPath, childEntry));
            }
        }
        return results;
    }

    async mkdir(path: string): Promise<FSNode> {
        const p = normalize(path);
        if (this.data.has(p)) {
            const existing = this.data.get(p)!;
            return toFSNode(p, existing);
        }
        const entry: Entry = {
            type: 'directory',
            content: new Uint8Array(0),
            createdAt: Date.now(),
            modifiedAt: Date.now(),
            version: 1,
            tags: [],
            metadata: {},
        };
        this.data.set(p, entry);
        return toFSNode(p, entry);
    }

    async delete(path: string, options?: { recursive?: boolean }): Promise<void> {
        const p = normalize(path);
        if (!this.data.has(p)) return;
        const prefix = p === '/' ? '/' : p + '/';

        if (options?.recursive) {
            for (const key of this.data.keys()) {
                if (key.startsWith(prefix)) this.data.delete(key);
            }
        }
        this.data.delete(p);
    }

    async rename(fromPath: string, toPath: string): Promise<void> {
        const from = normalize(fromPath);
        const to = normalize(toPath);
        const entry = this.data.get(from);
        if (!entry) return;
        const fromPrefix = from === '/' ? '/' : from + '/';

        this.data.delete(from);
        this.data.set(to, { ...entry, modifiedAt: Date.now() });

        // Move children
        for (const [p, e] of this.data) {
            if (p.startsWith(fromPrefix)) {
                const childRest = p.slice(fromPrefix.length - 1);
                const newChildPath = to === '/' ? childRest : to + childRest;
                this.data.delete(p);
                this.data.set(newChildPath, e);
            }
        }
    }

    // ── Content ──

    async read(path: string, options?: { offset?: number; length?: number }): Promise<Uint8Array> {
        const entry = this.data.get(normalize(path));
        if (!entry) throw new Error('ENOENT');
        let buf = entry.content;
        if (options?.offset !== undefined) {
            buf = buf.slice(options.offset, options.length ? options.offset + options.length : undefined);
        }
        return buf;
    }

    async write(path: string, content: Uint8Array): Promise<FSNode> {
        const p = normalize(path);
        const existing = this.data.get(p);
        const entry: Entry = {
            type: existing?.type ?? 'file',
            content: new Uint8Array(content),
            createdAt: existing?.createdAt ?? Date.now(),
            modifiedAt: Date.now(),
            version: (existing?.version ?? 0) + 1,
            tags: existing?.tags ?? [],
            metadata: existing?.metadata ?? {},
            icon: existing?.icon,
            symlinkTarget: existing?.symlinkTarget,
            extra: existing?.extra,
        };
        this.data.set(p, entry);
        return toFSNode(p, entry);
    }

    // ── Metadata ──

    async updateMetadata(path: string, metadata: Record<string, unknown>): Promise<void> {
        const entry = this.data.get(normalize(path));
        if (!entry) return;
        entry.metadata = { ...entry.metadata, ...metadata };
        entry.modifiedAt = Date.now();
    }

    async setTags(path: string, tags: string[]): Promise<void> {
        const entry = this.data.get(normalize(path));
        if (!entry) return;
        entry.tags = tags;
        entry.modifiedAt = Date.now();
    }

    async getAllTags(): Promise<string[]> {
        const seen = new Set<string>();
        for (const entry of this.data.values()) {
            for (const t of entry.tags) seen.add(t);
        }
        return [...seen];
    }

    async listTagEntries(): Promise<Array<{ path: string; tag: string }>> {
        return [...this.data.entries()].flatMap(([path, entry]) => [...new Set(entry.tags)].map(tag => ({ path, tag })));
    }

    // ── Search ──

    async search(query: FSSearchQuery): Promise<FSNode[]> {
        const results: FSNode[] = [];
        for (const [path, entry] of this.data) {
            const node = toFSNode(path, entry);
            if (matchesSearch(node, entry, query)) results.push(node);
        }
        if (query.orderBy) {
            const dir = query.orderDirection === 'desc' ? -1 : 1;
            results.sort((a, b) => {
                const av = searchOrderValue(a, query.orderBy!);
                const bv = searchOrderValue(b, query.orderBy!);
                if (av === bv) return 0;
                return (av < bv ? -1 : 1) * dir;
            });
        }
        const offset = query.offset ?? 0;
        const limit = query.limit ?? 50;
        return results.slice(offset, offset + limit);
    }

    // ── Transaction ──

    async transaction<T>(fn: (tx: IStorageBackend) => Promise<T>): Promise<T> {
        return fn(this); // Memory backend: no isolation
    }
}

class MemoryRecordStore implements IRecordStore, IRecordTransaction {
    private fields = new Map<string, Map<string, RecordValue>>();
    private tail: Promise<void> = Promise.resolve();

    clear(): void { this.fields.clear(); }

    async getRecordField(path: string, field: string): Promise<RecordValue | undefined> {
        return structuredClone(this.fields.get(path)?.get(field));
    }

    async getRecordFields(path: string, fields: string[]): Promise<Record<string, RecordValue>> {
        const row = this.fields.get(path), result: Record<string, RecordValue> = {};
        for (const field of new Set(fields)) {
            const value = row?.get(field);
            if (value !== undefined) result[field] = structuredClone(value);
        }
        return result;
    }

    async getRecordFieldsMany(requests: ReadonlyArray<RecordFieldRequest>): Promise<Array<RecordValue | undefined>> {
        return requests.map(request => structuredClone(this.fields.get(request.path)?.get(request.field)));
    }

    async setRecordField(path: string, field: string, value: RecordValue): Promise<void> {
        const row = this.fields.get(path) ?? new Map<string, RecordValue>();
        row.set(field, structuredClone(value));
        this.fields.set(path, row);
    }

    async deleteRecordField(path: string, field: string): Promise<void> {
        this.fields.get(path)?.delete(field);
    }

    async setAllRecordFields(path: string, fields: Record<string, RecordValue>): Promise<void> {
        this.fields.set(path, new Map(Object.entries(structuredClone(fields))));
    }

    async clearRecordFields(path: string): Promise<void> { this.fields.delete(path); }
    async createRecordIndex(): Promise<void> {}
    async deleteRecordIndex(): Promise<void> {}

    async queryRecordFields(
        path: string,
        query: RecordQuery,
        options?: RecordQueryOptions,
    ): Promise<RecordQueryResult[]> {
        const value = this.fields.get(path)?.get(query.field);
        if (value === undefined || !matchesRecord(value, query)) return [];
        const rows = [{ field: query.field, value: structuredClone(value) }];
        return rows.slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? rows.length));
    }

    async walkRecordFields(
        path: string,
        callback: (field: string, value: RecordValue) => boolean | Promise<boolean>,
        options?: RecordWalkOptions,
    ): Promise<{ total: number; processed: number }> {
        const prefix = options?.prefix ?? '';
        const rows = [...(this.fields.get(path)?.entries() ?? [])]
            .filter(([field]) => field.startsWith(prefix))
            .sort(([left], [right]) => left.localeCompare(right));
        let processed = 0;
        const offset = options?.offset ?? 0;
        const limit = options?.limit ?? Number.POSITIVE_INFINITY;
        for (const [field, value] of rows.slice(offset)) {
            if (processed >= limit || !(await callback(field, structuredClone(value)))) break;
            processed++;
        }
        return { total: rows.length, processed };
    }

    async walkRecordFieldNames(
        path: string,
        callback: (field: string) => boolean | Promise<boolean>,
        options?: { prefix?: string; limit?: number },
    ): Promise<number> {
        let processed = 0;
        await this.walkRecordFields(path, async field => {
            if (!(await callback(field))) return false;
            processed++;
            return true;
        }, options);
        return processed;
    }

    transaction<T>(operation: (tx: IRecordTransaction) => Promise<T>): Promise<T> {
        const run = async (): Promise<T> => {
            const original = this.fields;
            this.fields = cloneFields(original);
            try {
                return await operation(this);
            } catch (error) {
                this.fields = original;
                throw error;
            }
        };
        const result = this.tail.then(run, run);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
}

function cloneFields(source: Map<string, Map<string, RecordValue>>): Map<string, Map<string, RecordValue>> {
    return new Map([...source].map(([path, fields]) => [
        path,
        new Map([...fields].map(([key, value]) => [key, structuredClone(value)])),
    ]));
}

function matchesRecord(value: RecordValue, query: RecordQuery): boolean {
    const expected = query.value;
    switch (query.operator) {
        case '=': return value === expected;
        case '!=': return value !== expected;
        case '<': return typeof value === 'number' && typeof expected === 'number' && value < expected;
        case '<=': return typeof value === 'number' && typeof expected === 'number' && value <= expected;
        case '>': return typeof value === 'number' && typeof expected === 'number' && value > expected;
        case '>=': return typeof value === 'number' && typeof expected === 'number' && value >= expected;
        case 'in': return Array.isArray(expected) && expected.includes(value);
        case 'contains': return typeof value === 'string' && typeof expected === 'string'
            ? value.includes(expected)
            : Array.isArray(value) && value.includes(expected);
    }
}

// ── Helpers ──

function normalize(path: string): string {
    if (path === '' || path === '/') return '/';
    return '/' + path.split('/').filter(Boolean).join('/');
}

function toFSNode(path: string, entry: Entry): FSNode {
    const name = path === '/' ? '' : path.split('/').pop()!;
    const parentPath = path === '/' ? null : path.substring(0, path.lastIndexOf('/')) || '/';
    const base = {
        parentPath,
        name,
        path,
        createdAt: entry.createdAt,
        modifiedAt: entry.modifiedAt,
        version: entry.version,
        tags: entry.tags,
        metadata: entry.metadata,
        icon: entry.icon,
    };

    if (entry.type === 'directory') {
        return { ...base, type: 'directory' } as FSDirectoryNode;
    }

    const deviceHandlerId = entry.metadata[DEVICE_HANDLER_METADATA_KEY];
    if (typeof deviceHandlerId === 'string' && deviceHandlerId.length > 0) {
        return { ...base, type: 'device', deviceHandlerId } as FSDeviceNode;
    }

    const fileBase = {
        ...base,
        type: 'file' as const,
        size: entry.content.byteLength,
        contentHash: undefined,
        assetDirPath: undefined,
    };

    if (entry.symlinkTarget) {
        return { ...fileBase, type: 'symlink' as const, symlinkTarget: entry.symlinkTarget } as FSNode;
    }

    return fileBase as FSFileNode;
}

function matchesSearch(node: FSNode, entry: Entry, q: FSSearchQuery): boolean {
    if (q.type) {
        const types = Array.isArray(q.type) ? q.type : [q.type];
        if (!types.includes(node.type)) return false;
    }
    if (q.name) {
        const name = node.name.toLowerCase();
        if (q.name.exact && name !== q.name.exact.toLowerCase()) return false;
        if (q.name.contains && !name.includes(q.name.contains.toLowerCase())) return false;
        if (q.name.startsWith && !name.startsWith(q.name.startsWith.toLowerCase())) return false;
        if (q.name.endsWith && !name.endsWith(q.name.endsWith.toLowerCase())) return false;
    }
    if (q.tags) {
        if (q.tags.all && !q.tags.all.every(t => node.tags.includes(t))) return false;
        if (q.tags.any && !q.tags.any.some(t => node.tags.includes(t))) return false;
        if (q.tags.none && q.tags.none.some(t => node.tags.includes(t))) return false;
    }
    if (q.metadata && !Object.entries(q.metadata).every(([k, v]) => Object.is(node.metadata[k], v))) return false;
    if (q.modifiedAfter !== undefined && node.modifiedAt <= q.modifiedAfter) return false;
    if (q.modifiedBefore !== undefined && node.modifiedAt >= q.modifiedBefore) return false;
    if (q.text && node.type === 'file') {
        const content = new TextDecoder().decode(entry.content).toLowerCase();
        if (!content.includes(q.text.toLowerCase())) return false;
    }
    return true;
}

function searchOrderValue(node: FSNode, orderBy: NonNullable<FSSearchQuery['orderBy']>): string | number {
    if (orderBy === 'name') return node.name.toLowerCase();
    if (orderBy === 'size') return node.type === 'file' ? node.size : 0;
    return node[orderBy];
}
