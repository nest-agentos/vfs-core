/**
 * @file packages/vfs-core/src/impl/capabilities/SeqFileOps.ts
 * @desc SeqFile K-V 能力实现。依赖 EnginePort 而非 DirectoryFS 具体类。
 */

import type {
    ISeqFileOperations,
    ISeqFileTransaction,
    SeqFileEntry,
    SeqFileReadRequest,
    RecordQuery,
    RecordQueryOptions,
    RecordQueryResult,
    RecordValue,
    IRecordStore,
    IRecordTransaction,
    SeqCompareAndSetOptions,
} from '../../protocol';
import { FSError, FSCapabilityError } from '../../protocol';
import type { EnginePort } from './EnginePort';

export const SEQ_FIELD_PREFIX = '__vfs_seq__:';
const SEQ_COUNTER_PREFIX = '__vfs_seq_counter__:';

export function stringifyRecordValue(value: RecordValue): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function seqField(key: string): string {
    return SEQ_FIELD_PREFIX + key;
}

export function seqKey(field: string): string {
    return field.slice(SEQ_FIELD_PREFIX.length);
}

async function readEntries(records: IRecordTransaction, path: string, keys: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(keys)];
    if (!unique.length) return {};
    const values = records.getRecordFields
        ? await records.getRecordFields(path, unique.map(seqField))
        : Object.fromEntries(await Promise.all(unique.map(async key =>
            [seqField(key), await records.getRecordField(path, seqField(key))])));
    return Object.fromEntries(unique.flatMap(key => {
        const value = values[seqField(key)];
        return value === undefined ? [] : [[key, stringifyRecordValue(value)]];
    }));
}

/** 后端在路径不存在时抛 ENOENT；批量读把它降级为 null。 */
function isMissingRecord(error: unknown): boolean {
    return error instanceof FSError && error.code === 'ENOENT';
}

async function readFallback(
    records: IRecordTransaction,
    pending: ReadonlyArray<{ path: string; field: string }>,
): Promise<Array<RecordValue | undefined>> {
    const values: Array<RecordValue | undefined> = [];
    for (const entry of pending) {
        try {
            values.push(await records.getRecordField(entry.path, entry.field));
        } catch (error) {
            if (!isMissingRecord(error)) throw error;
            values.push(undefined);
        }
    }
    return values;
}

/**
 * 多路径单轮读取：优先后端批量能力，未实现时退化为逐条读取。
 * `paths[i] === null` 表示路径自身缺失，结果为 null。
 */
async function readEntriesMany(
    records: IRecordTransaction,
    paths: ReadonlyArray<string | null>,
    keys: ReadonlyArray<string>,
): Promise<Array<string | null>> {
    const results: Array<string | null> = new Array(paths.length).fill(null);
    const pending = paths.flatMap((path, index) =>
        path === null ? [] : [{ index, path, field: seqField(keys[index]!) }]);
    if (!pending.length) return results;
    const values = records.getRecordFieldsMany
        ? await records.getRecordFieldsMany(pending.map(entry => ({ path: entry.path, field: entry.field })))
        : await readFallback(records, pending);
    pending.forEach((entry, position) => {
        const value = values[position];
        if (value !== undefined) results[entry.index] = stringifyRecordValue(value);
    });
    return results;
}

class SeqTransaction implements ISeqFileTransaction {
    readonly changed = new Set<string>();
    constructor(
        private readonly fs: EnginePort,
        private readonly records: IRecordTransaction,
    ) {}

    private path(path: string): string { return this.fs.toRealPath(path); }

    async getEntry(path: string, key: string): Promise<string | null> {
        const value = await this.records.getRecordField(this.path(path), seqField(key));
        return value === undefined ? null : stringifyRecordValue(value);
    }

    async getEntries(path: string, keys: string[]): Promise<Record<string, string>> {
        return readEntries(this.records, this.path(path), keys);
    }

    async getEntriesMany(requests: ReadonlyArray<SeqFileReadRequest>): Promise<Array<string | null>> {
        if (!requests.length) return [];
        const paths = requests.map(request => this.path(request.fileIdOrPath));
        return readEntriesMany(this.records, paths, requests.map(request => request.key));
    }

    async setEntry(path: string, key: string, value: string): Promise<void> {
        await this.records.setRecordField(this.path(path), seqField(key), value);
        this.changed.add(this.path(path));
    }

    async deleteEntry(path: string, key: string): Promise<void> {
        await this.records.deleteRecordField(this.path(path), seqField(key));
        this.changed.add(this.path(path));
    }

    async compareAndSet(
        path: string,
        key: string,
        options: SeqCompareAndSetOptions,
    ): Promise<boolean> {
        const current = await this.getEntry(path, key);
        if (current !== options.expected) return false;
        if (options.value === null) await this.deleteEntry(path, key);
        else await this.setEntry(path, key, options.value);
        return true;
    }

    async increment(path: string, key: string, delta = 1): Promise<number> {
        const current = Number(await this.getEntry(path, key) ?? '0');
        if (!Number.isSafeInteger(current) || !Number.isSafeInteger(delta)) {
            throw new FSError('EINVAL', 'SeqFile counter must be a safe integer', 'increment', key);
        }
        const next = current + delta;
        if (!Number.isSafeInteger(next)) throw new FSError('EINVAL', 'SeqFile counter overflow', 'increment', key);
        await this.setEntry(path, key, String(next));
        return next;
    }

    async append(path: string, prefix: string, value: string): Promise<string> {
        const sequence = await this.increment(path, SEQ_COUNTER_PREFIX + prefix);
        const key = prefix + String(sequence).padStart(16, '0');
        await this.setEntry(path, key, value);
        return key;
    }

    async walkEntries(
        path: string,
        callback: (entry: SeqFileEntry) => boolean | Promise<boolean>,
        options?: { keyPrefix?: string; limit?: number; offset?: number },
    ): Promise<{ total: number; processed: number }> {
        return this.records.walkRecordFields(
            this.path(path),
            (key, value) => callback({ key: seqKey(key), value: stringifyRecordValue(value) }),
            { prefix: seqField(options?.keyPrefix ?? ''), limit: options?.limit, offset: options?.offset },
        );
    }
}

export class SeqFileOps implements ISeqFileOperations {
    constructor(
        private readonly fs: EnginePort,
        private readonly records: IRecordStore,
    ) {}

    private async path(path: string): Promise<string> {
        return (await this.fs.resolveNode(path)).realPath;
    }

    async getEntry(path: string, key: string): Promise<string | null> {
        const value = await this.records.getRecordField(await this.path(path), seqField(key));
        return value === undefined ? null : stringifyRecordValue(value);
    }

    async getEntries(path: string, keys: string[]): Promise<Record<string, string>> {
        if (!keys.length) return {};
        const realPath = await this.path(path);
        const read = (records: IRecordTransaction) => readEntries(records, realPath, keys);
        return this.records.transaction ? this.records.transaction(read) : read(this.records);
    }

    /** 逐路径解析；节点不存在（ENOENT）时记为 null 而非抛错。 */
    private async resolveMany(requests: ReadonlyArray<SeqFileReadRequest>): Promise<Array<string | null>> {
        const cache = new Map<string, string | null>();
        const paths: Array<string | null> = [];
        for (const request of requests) {
            if (!cache.has(request.fileIdOrPath)) {
                try {
                    cache.set(request.fileIdOrPath, await this.path(request.fileIdOrPath));
                } catch (error) {
                    if (!isMissingRecord(error)) throw error;
                    cache.set(request.fileIdOrPath, null);
                }
            }
            paths.push(cache.get(request.fileIdOrPath) ?? null);
        }
        return paths;
    }

    async getEntriesMany(requests: ReadonlyArray<SeqFileReadRequest>): Promise<Array<string | null>> {
        if (!requests.length) return [];
        const paths = await this.resolveMany(requests);
        const keys = requests.map(request => request.key);
        const read = (records: IRecordTransaction) => readEntriesMany(records, paths, keys);
        return this.records.transaction ? this.records.transaction(read) : read(this.records);
    }

    async setEntry(path: string, key: string, value: string): Promise<void> {
        const realPath = await this.path(path);
        await this.records.setRecordField(realPath, seqField(key), value);
        this.emitCommitted([realPath]);
    }

    async setEntries(path: string, entries: Record<string, string>): Promise<void> {
        if (!this.records.transaction) {
            throw new FSCapabilityError('transactionalSeqFiles', this.fs.viewId);
        }
        await this.transaction(async tx => {
            for (const [key, value] of Object.entries(entries)) await tx.setEntry(path, key, value);
        });
    }

    async deleteEntry(path: string, key: string): Promise<void> {
        const realPath = await this.path(path);
        await this.records.deleteRecordField(realPath, seqField(key));
        this.emitCommitted([realPath]);
    }

    async hasEntry(path: string, key: string): Promise<boolean> {
        return (await this.records.getRecordField(await this.path(path), seqField(key))) !== undefined;
    }

    async walkEntries(
        path: string,
        callback: (entry: SeqFileEntry) => boolean | Promise<boolean>,
        options?: { keyPrefix?: string; limit?: number; offset?: number },
    ): Promise<{ total: number; processed: number }> {
        return this.records.walkRecordFields(
            await this.path(path),
            (key, value) => callback({
                key: seqKey(key),
                value: stringifyRecordValue(value),
            }),
            {
                prefix: seqField(options?.keyPrefix ?? ''),
                limit: options?.limit,
                offset: options?.offset,
            },
        );
    }

    async queryEntries(
        path: string,
        query: RecordQuery,
        options?: RecordQueryOptions,
    ): Promise<RecordQueryResult[]> {
        const results = await this.records.queryRecordFields(
            await this.path(path),
            { ...query, field: seqField(query.field) },
            options,
        );
        return results.map(result => ({ ...result, field: seqKey(result.field) }));
    }

    async createIndex(path: string, field: string): Promise<void> {
        await this.records.createRecordIndex(await this.path(path), seqField(field));
    }

    async deleteIndex(path: string, field: string): Promise<void> {
        await this.records.deleteRecordIndex(await this.path(path), seqField(field));
    }

    private emitCommitted(paths: string[]): void {
        if (paths.length) this.fs.emit('seq:committed', { paths: paths.map(path => this.fs.toVirtualPath(path)) });
    }

    async transaction<T>(operation: (tx: ISeqFileTransaction) => Promise<T>): Promise<T> {
        if (!this.records.transaction) {
            throw new FSCapabilityError('transactionalSeqFiles', this.fs.viewId);
        }
        let changed: string[] = [];
        const result = await this.records.transaction(async records => {
            const tx = new SeqTransaction(this.fs, records);
            const value = await operation(tx);
            changed = [...tx.changed];
            return value;
        });
        this.emitCommitted(changed);
        return result;
    }
}
