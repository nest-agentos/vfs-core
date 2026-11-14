/**
 * @file packages/vfs-core/src/impl/capabilities/SeqFileOps.ts
 * @desc SeqFile K-V 能力实现。依赖 EnginePort 而非 DirectoryFS 具体类。
 */

import type {
    ISeqFileOperations,
    ISeqFileTransaction,
    ISeqFileReadTransaction,
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
import { FSError, FSCapabilityError, SEQ_FIELD_PREFIX, SEQ_ROW_COMMANDS, SEQ_CONTROL_COMMANDS, type SeqControlCommand } from '../../protocol';
import type { EnginePort } from './EnginePort';
import {seqRowOperation} from './seq-row-operation';
import {seqKeyPage} from './seq-key-page';

export {SEQ_FIELD_PREFIX} from '../../protocol';
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
    get keyPages(): boolean {return this.records.keyPages === true;}
    readonly changed = new Set<string>();
    readonly changes: import('../../protocol').SeqRecordChange[] = [];
    constructor(
        private readonly fs: EnginePort,
        private readonly records: IRecordTransaction,
    ) {}

    private path(path: string): string { return this.fs.toRealPath(path); }

    async ioctl(path: string, command: SeqControlCommand, input?: unknown): Promise<unknown> {
        if (command === 'seq.keys.page.v1') return seqKeyPage(this.records,this.path(path),input);
        if (!Object.hasOwn(SEQ_ROW_COMMANDS,command) || this.records.structuredRows !== true || !this.records.rowControl) throw new FSCapabilityError('structuredSeqFiles');
        const real = this.path(path), result = await this.records.rowControl(real,command,input);
        if (SEQ_ROW_COMMANDS[command] === 'write') this.changed.add(real);
        return result;
    }

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
        this.changes.push({ path: this.path(path), key, type: 'set' });
    }

    async deleteEntry(path: string, key: string): Promise<void> {
        await this.records.deleteRecordField(this.path(path), seqField(key));
        this.changed.add(this.path(path));
        this.changes.push({ path: this.path(path), key, type: 'delete' });
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
        options?: { keyPrefix?: string; limit?: number; offset?: number; order?: 'key'; after?: string },
    ): Promise<{ total: number; processed: number }> {
        return this.records.walkRecordFields(
            this.path(path),
            (key, value) => callback({ key: seqKey(key), value: stringifyRecordValue(value) }),
            { prefix: seqField(options?.keyPrefix ?? ''),
                order: options?.order,
                after: options?.after === undefined ? undefined : seqField(options.after), limit: options?.limit, offset: options?.offset },
        );
    }
}

export class SeqFileOps implements ISeqFileOperations {
    get keyPages(): boolean {return this.records.keyPages === true;}
    constructor(
        private readonly fs: EnginePort,
        private readonly records: IRecordStore,
    ) {}

    private async path(path: string, fast = false): Promise<string> {
        return fast && this.fs.resolveRecordPath ? this.fs.resolveRecordPath(path) : (await this.fs.resolveNode(path)).realPath;
    }
    private async readPath<T>(path: string, run: (records: IRecordTransaction, real: string) => Promise<T>): Promise<T> {
        const snapshot = this.records.readTransaction;
        if (this.records.pathsInTransaction && snapshot)
            return snapshot.call(this.records,async (records: IRecordTransaction) => run(records,await this.path(path,true))) as Promise<T>;
        const real = await this.path(path);
        return snapshot ? snapshot.call(this.records,(records: IRecordTransaction) => run(records,real)) as Promise<T> : run(this.records,real);
    }
    private async writePath<T>(path: string, run: (records: IRecordTransaction, real: string) => Promise<T>): Promise<T> {
        const transaction = this.records.transaction;
        if (this.records.pathsInTransaction && transaction)
            return transaction.call(this.records,async (records: IRecordTransaction) => run(records,await this.path(path,true))) as Promise<T>;
        const real = await this.path(path);
        return transaction ? transaction.call(this.records,(records: IRecordTransaction) => run(records,real)) as Promise<T> : run(this.records,real);
    }

    ioctl(path: string, command: SeqControlCommand, input?: unknown): Promise<unknown> {
        return seqRowOperation(this.fs,path,command,() => this.control(path,command,input));
    }
    private async control(path: string, command: SeqControlCommand, input?: unknown): Promise<unknown> {
        if (command === 'seq.keys.page.v1') return this.readPath(path,(records,real) => seqKeyPage(records,real,input));
        if (!Object.hasOwn(SEQ_ROW_COMMANDS,command) || this.records.structuredRows !== true || !this.records.rowControl) throw new FSCapabilityError('structuredSeqFiles');
        const write = SEQ_ROW_COMMANDS[command] === 'write';
        const transaction = write ? this.records.transaction : this.records.readTransaction;
        if (!transaction) throw new FSCapabilityError('structuredSeqFiles');
        let changed: string | undefined;
        const run = async (tx: IRecordTransaction, real: string) => {
            if (!tx.rowControl) throw new FSCapabilityError('structuredSeqFiles');
            changed = real;
            return tx.rowControl(real,command,input);
        };
        const result = await (write ? this.writePath(path,run) : this.readPath(path,run));
        if (write) this.emitCommitted([changed!],[]);
        return result;
    }

    async getEntry(path: string, key: string): Promise<string | null> {
        const value = await this.readPath(path,(records,real) => records.getRecordField(real,seqField(key)));
        return value === undefined ? null : stringifyRecordValue(value);
    }

    async getEntries(path: string, keys: string[]): Promise<Record<string, string>> {
        if (!keys.length) return {};
        if (!this.records.readTransaction) throw new FSError('ECAPABILITY', 'Record backend requires readTransaction for batch snapshots');
        return this.readPath(path,(records,real) => readEntries(records,real,keys));
    }

    /** 逐路径解析；节点不存在（ENOENT）时记为 null 而非抛错。 */
    private async resolveMany(requests: ReadonlyArray<SeqFileReadRequest>, fast = false): Promise<Array<string | null>> {
        const cache = new Map<string, Promise<string | null>>();
        for (const request of requests) {
            if (!cache.has(request.fileIdOrPath)) {
                cache.set(request.fileIdOrPath,this.path(request.fileIdOrPath,fast).catch(error => {
                    if (!isMissingRecord(error)) throw error;
                    return null;
                }));
            }
        }
        return Promise.all(requests.map(request => cache.get(request.fileIdOrPath)!));
    }

    async getEntriesMany(requests: ReadonlyArray<SeqFileReadRequest>): Promise<Array<string | null>> {
        if (!requests.length) return [];
        const keys = requests.map(request => request.key);
        if (!this.records.readTransaction) throw new FSError('ECAPABILITY', 'Record backend requires readTransaction for batch snapshots');
        if (this.records.pathsInTransaction) return this.records.readTransaction(async records =>
            readEntriesMany(records,await this.resolveMany(requests,true),keys));
        const paths = await this.resolveMany(requests);
        return this.records.readTransaction(records => readEntriesMany(records,paths,keys));
    }

    async setEntry(path: string, key: string, value: string): Promise<void> {
        const realPath = await this.writePath(path,async (records,real) => {await records.setRecordField(real,seqField(key),value); return real;});
        this.emitCommitted([realPath], [{ path: realPath, key, type: 'set' }]);
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
        const realPath = await this.writePath(path,async (records,real) => {await records.deleteRecordField(real,seqField(key)); return real;});
        this.emitCommitted([realPath], [{ path: realPath, key, type: 'delete' }]);
    }

    async hasEntry(path: string, key: string): Promise<boolean> {
        return (await this.readPath(path,(records,real) => records.getRecordField(real,seqField(key)))) !== undefined;
    }

    async walkEntries(
        path: string,
        callback: (entry: SeqFileEntry) => boolean | Promise<boolean>,
        options?: { keyPrefix?: string; limit?: number; offset?: number; order?: 'key'; after?: string },
    ): Promise<{ total: number; processed: number }> {
        const entries: SeqFileEntry[] = [];
        const visit = (key: string, value: RecordValue) => ({key:seqKey(key),value:stringifyRecordValue(value)});
        const fields = {prefix:seqField(options?.keyPrefix ?? ''),order:options?.order,
            after:options?.after === undefined ? undefined : seqField(options.after),limit:options?.limit,offset:options?.offset};
        if (this.records.pathsInTransaction) {
            const page = await this.readPath(path,(records,real) => records.walkRecordFields(real,(key,value) => {
                entries.push(visit(key,value)); return true;
            },fields));
            let processed = 0;
            for (const entry of entries) {if (await callback(entry) === false) break; processed++;}
            return {total:page.total,processed};
        }
        return this.records.walkRecordFields(
            await this.path(path),
            (key,value) => callback(visit(key,value)),fields);
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

    private emitCommitted(paths: string[], changes: import('../../protocol').SeqRecordChange[]): void {
        if (paths.length) this.fs.emit('seq:committed', { paths: paths.map(path => this.fs.toVirtualPath(path)),
            changes: changes.map(change => ({ ...change, path: this.fs.toVirtualPath(change.path) })) });
    }
    readTransaction<T>(operation: (tx: ISeqFileReadTransaction) => Promise<T>): Promise<T> {
        if (!this.records.readTransaction) throw new FSCapabilityError('seq.readTransaction');
        return this.records.readTransaction(async records => {
            const tx = new SeqTransaction(this.fs,records);
            let active = true;
            const guard = <A extends unknown[],R>(run:(...args:A) => Promise<R>) => async (...args:A):Promise<R> => {
                if (!active) throw new FSError('EACCES','Read transaction is closed');
                return run(...args);
            };
            const read: ISeqFileReadTransaction = {
                keyPages:this.records.keyPages === true,
                getEntry:guard(tx.getEntry.bind(tx)),getEntries:guard(tx.getEntries.bind(tx)),getEntriesMany:guard(tx.getEntriesMany.bind(tx)),walkEntries:guard(tx.walkEntries.bind(tx)),
                ioctl:guard(async (path: string,command: Exclude<SeqControlCommand,'seq.rows.define.v1'>,input?: unknown) => {
                    if (SEQ_CONTROL_COMMANDS[command as SeqControlCommand] === 'write') throw new FSError('EROFS','Read transaction cannot modify schema','seq.rows');
                    return tx.ioctl(path,command,input);
                }),
            };
            try {return await operation(read);} finally {active = false;}
        });
    }

    async transaction<T>(operation: (tx: ISeqFileTransaction) => Promise<T>): Promise<T> {
        if (!this.records.transaction) {
            throw new FSCapabilityError('transactionalSeqFiles', this.fs.viewId);
        }
        let changed: string[] = [];
        let changes: import('../../protocol').SeqRecordChange[] = [];
        const result = await this.records.transaction(async records => {
            const tx = new SeqTransaction(this.fs, records);
            const value = await operation(tx);
            changed = [...tx.changed];
            changes = tx.changes;
            return value;
        });
        this.emitCommitted(changed, changes);
        return result;
    }
}
