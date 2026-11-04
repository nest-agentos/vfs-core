import type { OperationOptions } from '../../protocol';
/**
 * @file packages/vfs-core/src/impl/services/DirectoryContext.ts
 * @desc 模块共享上下文 — 状态 + 路径映射 + 事件发射 + SeqFile 序列化。
 *
 * DirectoryFS（薄外观）与 DirectoryDriver（IFSDriver 实现）共享此上下文，
 * 避免二者互相回环依赖。
 */

import type {
    FSNode,
    FSCapabilities,
    FSEventType,
    FSEventPayloadMap,
    IStorageBackend,
    ISystemAccess,
    IRecordStore,
} from '../../protocol';
import { FSError, FSNotFoundError } from '../../protocol';

import { VFSEngine } from '../engine/vfs-engine';
import { detectCapabilities } from '../engine/capabilities';
import { ScopedView } from './ScopedView';
import { FSEventBus } from '../event/event-bus';
import { PluginPipeline } from '../engine/plugin-pipeline';
import { DeviceRegistry } from '../engine/device-registry';
import { isPath } from '../../utils/validation';
import { seqKey, stringifyRecordValue, SEQ_FIELD_PREFIX } from '../capabilities/SeqFileOps';
import type { EnginePort } from '../capabilities/EnginePort';
import { mapRecordPaths } from '../capabilities/PathMappedRecordStore';
import type { IEventEmitter } from '../../eventbus';

export interface DirectoryFSDeps {
    viewId: string;
    engine: VFSEngine;
    eventBus: FSEventBus;
    plugins: PluginPipeline;
    devices: DeviceRegistry;
    mountId?: string;
    /** ISystemAccess for /etc operations, injected into DeviceContext for device drivers. */
    systemAccess?: ISystemAccess;
    /** Override the root real path (used by the etc pseudo-module). */
    rootRealPath: string;
}

export class DirectoryContext implements EnginePort {
    readonly viewId: string;
    readonly capabilities: FSCapabilities;
    readonly engine: VFSEngine;
    readonly bus: FSEventBus;
    readonly devices: DeviceRegistry;
    readonly scope: ScopedView;
    readonly mountId: string;
    readonly moduleBackend: IStorageBackend;
    readonly records?: IRecordStore;
    readonly systemAccess?: ISystemAccess;
    readonly plugins: PluginPipeline;

    initialized = false;
    /** Points to the active event target — bus normally, EventBuffer during a transaction. */
    private _emitTarget: IEventEmitter<FSEventPayloadMap>;

    constructor(deps: DirectoryFSDeps) {
        this.viewId = deps.viewId;
        this.engine = deps.engine;
        this.bus = deps.eventBus;
        this._emitTarget = deps.eventBus;
        this.devices = deps.devices;
        this.plugins = deps.plugins;
        this.scope = new ScopedView(deps.rootRealPath);
        this.mountId = deps.mountId ?? 'mount_0';
        this.systemAccess = deps.systemAccess;
        this.moduleBackend = deps.engine.getBackendForPath(deps.rootRealPath);
        const records = this.moduleBackend.records;
        this.records = records
            ? mapRecordPaths(records, path => this.engine.recordLocation(path, this.moduleBackend).localPath) : records;
        this.capabilities = detectCapabilities(this.moduleBackend, { deviceFiles: true });
    }

    get backend(): IStorageBackend { return this.moduleBackend; }

    /** Convert a system path to this module's virtual namespace. */
    toVirtualPath(path: string): string { return this.scope.toVirtualPath(path); }

    /** Map a system-path FSNode to a module-virtual-path FSNode. */
    toVirtualNode(node: FSNode): FSNode {
        const mapPath = (p: string | null) => p ? this.scope.toVirtualPath(p) : null;
        return {
            ...node,
            path: mapPath(node.path)!,
            parentPath: node.path === this.scope.root ? null : mapPath(node.parentPath),
        };
    }

    /** Convert a virtual path to a system-real path. */
    toRealPath(path: string): string {
        if (isPath(path)) {
            return this.scope.toRealPath(path);
        }
        throw new FSError('EINVAL', 'path-based engine requires paths, not IDs', 'resolve', path);
    }

    /** Stat + return { node, realPath }. Throws if not found. */
    async resolveNode(path: string, options?: OperationOptions): Promise<{ node: FSNode; realPath: string }> {
        const realPath = this.toRealPath(path);
        const node = await this.engine.stat(realPath, options);
        if (!node) throw new FSNotFoundError(path);
        return { node, realPath };
    }

    /** Trusted directory adapter; composed view enforces read/write grants. */
    assertWritable(_realPath: string): void {}

    /** Emit a namespaced event. */
    emit<E extends FSEventType>(type: E, payload: FSEventPayloadMap[E]): void {
        this._emitTarget.emit(type, payload, { viewId: this.viewId, mountId: this.mountId });
    }

    /**
     * Run a function with a temporary event target (e.g. a transaction buffer),
     * restoring the previous target afterwards. Re-entrant / LIFO-safe.
     */
    async withEventTarget<T>(target: IEventEmitter<FSEventPayloadMap>, fn: () => Promise<T>): Promise<T> {
        const prev = this._emitTarget;
        this._emitTarget = target;
        try {
            return await fn();
        } finally {
            this._emitTarget = prev;
        }
    }

    recordsForPath(realPath: string): IRecordStore | undefined {
        const backend = this.engine.getBackendForPath(realPath);
        if (backend === this.moduleBackend) return this.records;
        const records = backend.records;
        return records
            ? mapRecordPaths(records, path => this.engine.recordLocation(path, backend).localPath)
            : records;
    }

    /** Serialize a SeqFile's record fields into "key=value" lines (null when empty). */
    async serializeSeqFile(path: string, records: IRecordStore): Promise<string | null> {
        const lines: string[] = [];
        try {
            const result = await records.walkRecordFields(path, (field, value) => {
                lines.push(seqKey(field) + '=' + stringifyRecordValue(value));
                return true;
            }, { prefix: SEQ_FIELD_PREFIX });
            return result.total > 0 ? lines.join('\n') : null;
        } catch (error) {
            if (isMissingRecordIndexError(error)) return null;
            throw error;
        }
    }
}

function isMissingRecordIndexError(error: unknown): boolean {
    return error instanceof Error && error.name === 'NotFoundError';
}
