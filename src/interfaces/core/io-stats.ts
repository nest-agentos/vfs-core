/**
 * @file packages/vfs-core/src/interfaces/core/io-stats.ts
 * @desc Public engine operation counters shared with IVFSManager.
 */

/** Operations instrumented by the engine; these are not exhaustive backend or IPC counts. */
export const IO_OPERATIONS = [
    'stat', 'list', 'read', 'write', 'mkdir',
    'delete', 'rename', 'metadata', 'search',
] as const;

export type IOOperation = typeof IO_OPERATIONS[number];
