/**
 * @file packages/vfs-core/src/impl/engine/capabilities.ts
 * @desc 能力探测 — 从 IStorageBackend 的可选能力推导 FSCapabilities，单一真相。
 */

import type { FSCapabilities, IStorageBackend } from '../../protocol';

export interface CapabilityOverrides {
    readonly?: boolean;
    syncable?: boolean;
    deviceFiles?: boolean;
    mount?: boolean;
}

/**
 * 探测后端能力。后端通过可选字段（records/symlink/…）声明支持，
 * 其余为引擎层通用能力（assets/tags/treeWalk/partialRead/…）。
 */
export function detectCapabilities(backend: IStorageBackend, overrides: CapabilityOverrides = {}): FSCapabilities {
    return Object.freeze({
        readonly: overrides.readonly ?? (backend.fileStorage ? !backend.fileStorage.mutations : false),
        search: !!backend.search,
        semanticSearch: false,
        syncable: overrides.syncable ?? false,
        assets: !backend.fileStorage,
        tags: !backend.fileStorage,
        deviceFiles: overrides.deviceFiles ?? false,
        seqFiles: !!backend.records,
        transactionalSeqFiles: !!backend.records?.transaction,
        references: !!backend.records,
        symlinks: !!backend.symlink,
        hardlinks: false,
        partialRead: true,
        partialWrite: !backend.fileStorage,
        treeWalk: true,
        streaming: false,
        watch: false,
        mount: overrides.mount ?? false,
    });
}
