import type { OperationOptions } from '../core/operation';

export interface FileStat {
    kind: 'file' | 'directory' | 'symlink';
    size?: number;
    createdAt?: number;
    modifiedAt?: number;
    revision?: string;
    /**
     * Persistent identity within this source namespace, independent of mount prefixes.
     * Rename preserves it; copy and delete/recreate allocate a new identity.
     * Hosts must combine it with namespace identity when comparing different sources.
     */
    sourceIdentity?: string;
    /** Optional source-owned metadata, persisted beside the remote file tree. */
    metadata?: Record<string, unknown>;
}
export interface FileEntry { name: string; stat: FileStat; }
export interface FilePage { entries: FileEntry[]; nextCursor: string | null; warnings?: string[]; }
export interface FileListOptions extends OperationOptions { cursor?: string; fields?: 'entry' | 'stat'; }
export interface FileReadOptions extends OperationOptions { offset?: number; length?: number; ifRevision?: string; }
export interface FileReadResult { data: Uint8Array; revision?: string; }
export interface FileReader {
    stat(path: string, options?: OperationOptions): Promise<FileStat | null>;
    statType?(path: string, options?: OperationOptions): Promise<Pick<FileStat, 'kind'> | null>;
    list(path: string, options?: FileListOptions): Promise<FilePage>;
    read(path: string, options?: FileReadOptions): Promise<FileReadResult>;
}
export type ReplaceCondition = { kind: 'create-only' } | { kind: 'match'; revision: string };
export interface FileMutations {
    /**
     * Shallow patch: omitted keys remain, supplied values replace whole values (null is a value).
     * Field deletion and revision-conditional updates are not provided by this operation.
     * Concurrent patches use last-write-wins per supplied key; callers cannot assume CAS.
     */
    updateMetadata?(path: string, patch: Record<string, unknown>, options?: OperationOptions): Promise<void>;
    replace(path: string, data: Uint8Array, condition: ReplaceCondition, options?: OperationOptions): Promise<FileStat>;
    mkdir(path: string, options?: OperationOptions): Promise<FileStat>;
    rename(from: string, to: string, options?: OperationOptions): Promise<void>;
    remove(path: string, options?: OperationOptions & { recursive?: boolean }): Promise<void>;
}
/** Source-owned file facts and optional metadata; virtual nodes remain in the VFS adapter. */
export interface FileStorageBackend {
    readonly name: string;
    readonly files: FileReader;
    readonly mutations?: FileMutations;
    init(options?: OperationOptions): Promise<void>;
    close(): Promise<void>;
}
