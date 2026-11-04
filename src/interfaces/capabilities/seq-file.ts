/**
 * @file packages/vfs-core/src/interfaces/capabilities/seq-file.ts
 * @desc SeqFile 操作子接口
 *
 * 通过 IFileSystem.meta.seq 访问（当 capabilities.seqFiles === true）。
 *
 * SeqFileEntry 是唯一定义位置，core/types.ts re-export。
 */

import type { RecordQuery, RecordQueryOptions, RecordQueryResult } from '../storage/record-backend';

export interface SeqFileEntry {
    key: string;
    value: string;
    valueType?: 'string' | 'number' | 'boolean' | 'json';
}

export interface SeqCompareAndSetOptions {
    expected: string | null;
    value: string | null;
}

export interface SeqFileReadRequest {
    fileIdOrPath: string;
    key: string;
}

export interface ISeqFileTransaction {
    getEntry(fileIdOrPath: string, key: string): Promise<string | null>;
    getEntries(fileIdOrPath: string, keys: string[]): Promise<Record<string, string>>;
    /**
     * Read one entry from many files in one storage round-trip.
     * Result order matches `requests`; a missing file/key yields `null`.
     */
    getEntriesMany(requests: ReadonlyArray<SeqFileReadRequest>): Promise<Array<string | null>>;
    setEntry(fileIdOrPath: string, key: string, value: string): Promise<void>;
    deleteEntry(fileIdOrPath: string, key: string): Promise<void>;
    compareAndSet(
        fileIdOrPath: string,
        key: string,
        options: SeqCompareAndSetOptions,
    ): Promise<boolean>;
    increment(fileIdOrPath: string, key: string, delta?: number): Promise<number>;
    append(fileIdOrPath: string, prefix: string, value: string): Promise<string>;
    walkEntries(
        fileIdOrPath: string,
        callback: (entry: SeqFileEntry) => boolean | Promise<boolean>,
        options?: { keyPrefix?: string; limit?: number; offset?: number },
    ): Promise<{ total: number; processed: number }>;
}

export interface ISeqFileOperations {
    getEntry(fileIdOrPath: string, key: string): Promise<string | null>;
    getEntries(fileIdOrPath: string, keys: string[]): Promise<Record<string, string>>;
    /**
     * Read one entry from many files in one storage round-trip.
     * Result order matches `requests`; a missing file/key yields `null`.
     */
    getEntriesMany(requests: ReadonlyArray<SeqFileReadRequest>): Promise<Array<string | null>>;
    setEntry(fileIdOrPath: string, key: string, value: string): Promise<void>;
    setEntries(fileIdOrPath: string, entries: Record<string, string>): Promise<void>;
    deleteEntry(fileIdOrPath: string, key: string): Promise<void>;
    hasEntry(fileIdOrPath: string, key: string): Promise<boolean>;

    /**
     * 流式遍历所有条目（替代 getAllEntries）。
     * callback 返回 false 时提前终止。
     */
    walkEntries(
        fileIdOrPath: string,
        callback: (entry: SeqFileEntry) => boolean | Promise<boolean>,
        options?: {
            keyPrefix?: string;
            limit?: number;
            offset?: number;
        },
    ): Promise<{ total: number; processed: number }>;

    /**
     * 查询字段（需要后端支持 IRecordStore）
     * 不支持时抛出 FSCapabilityError。
     */
    queryEntries?(
        fileIdOrPath: string,
        query: RecordQuery,
        options?: RecordQueryOptions,
    ): Promise<RecordQueryResult[]>;

    createIndex?(fileIdOrPath: string, field: string): Promise<void>;
    deleteIndex?(fileIdOrPath: string, field: string): Promise<void>;

    /** Execute operations across SeqFiles on this backend atomically. */
    transaction?<T>(operation: (tx: ISeqFileTransaction) => Promise<T>): Promise<T>;
}
