/**
 * @file packages/vfs-core/src/impl/capabilities/EnginePort.ts
 * @desc 能力类依赖的最小引擎端口（状态 + 路径 + 事件）。
 *
 * 由 DirectoryContext 实现。能力类只依赖此接口，可单测、可替换。
 */

import type {
    IStorageBackend,
    FSNode,
    FSEventType,
    FSEventPayloadMap,
    FileContent,
    FSNodeType,
    ReadOptions,
    DeleteOptions,
} from '../../protocol';

/** Operations used by capabilities; does not depend on a concrete engine implementation. */
export interface CapabilityEngine {
    listTagEntries(root: string): Promise<Array<{ path: string; tag: string }>>;
    setTags(path: string, tags: string[]): Promise<void>;
    ensureAssetDir(path: string): Promise<string>;
    getAssetDirPath(path: string): Promise<string | null>;
    listChildren(path: string): Promise<FSNode[]>;
    readContent(path: string, options?: ReadOptions): Promise<ArrayBuffer>;
    delete(path: string, options?: DeleteOptions): Promise<void>;
    createFile(parent: string, name: string, type?: FSNodeType, content?: FileContent,
        metadata?: Record<string, unknown>, options?: { overwrite?: boolean; recursive?: boolean; deviceHandlerId?: string }): Promise<FSNode>;
}

export interface EnginePort {
    readonly viewId: string;
    readonly engine: CapabilityEngine;
    readonly backend: IStorageBackend;
    toRealPath(path: string): string;
    toVirtualPath(path: string): string;
    toVirtualNode(node: FSNode): FSNode;
    resolveNode(path: string): Promise<{ node: FSNode; realPath: string }>;
    emit<E extends FSEventType>(type: E, payload: FSEventPayloadMap[E]): void;
}
