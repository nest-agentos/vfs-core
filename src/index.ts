/**
 * @file packages/vfs-core/src/index.ts
 * @desc @itookit/vfs-core 统一入口 — VFS 协议 + 引擎 + 事件总线 + 工具
 *
 * 使用方式：
 *   import { createVFS, VFSManager, VFSEngine } from '@itookit/vfs-core';
 *   import { MemoryBackend } from '@itookit/vfs-core';
 *   import type { IVFSManager, IFileSystem, FSNode } from '@itookit/vfs-core';
 *   import { EventBus } from '@itookit/vfs-core';
 */

// ── VFS 协议层 (接口/类型/常量/错误) ──
export * from './protocol';

// ── 事件总线 (通用) ──
export * from './eventbus';

// ── 工厂 ──
export { createVFS } from './impl/factory';
export { copyFileSystemTree } from './impl/services/copy-tree';
export { discoverFiles, createVFSFileDiscoverySource } from './impl/services/file-discovery';
export { DEFAULT_DISCOVERY_EXCLUDES } from './impl/services/file-ignore';
export { FileSystemView, createFileSystemView, normalizeVirtualPath } from './impl/services/FileSystemView';
export type { FileSystemMount, FileSystemViewOptions } from './impl/services/FileSystemView';

// ── 引擎核心 ──
export { VFSEngine } from './impl/engine/vfs-engine';
export { FSEventBus, TransactionEventBuffer } from './impl/event/event-bus';
export { PluginPipeline } from './impl/engine/plugin-pipeline';
export { DeviceRegistry } from './impl/engine/device-registry';

// ── 服务层实现 ──
export { VFSManager } from './impl/services/VFSManager';
export { ConfigService } from './impl/services/ConfigService';

// ── 内置设备 ──
export { nullDevice, zeroDevice, randomDevice } from './impl/devices';

// ── 后端（参考实现，位于 testing/） ──
export { MemoryBackend } from './testing';

// ── File handles ──
export { FileHandle, createFile, MDXFileHandle, createMDXFile } from './impl/file-io';

// ── 工具 ──
export * as pathUtils from './utils/path';
export {
    isHiddenName,
    isAssetDirName,
    isInternalDirName,
    isReservedName,
    toAssetDirName,
    fromAssetDirName,
    validateFilename,
    isPath,
} from './utils/validation';
export { generateId } from './utils/id';
export { toBuffer, toString, toUint8Array } from './utils/encoding';
export { guessMimeType } from './utils/guess-mime-type';
export { pipe, type PipeOptions } from './utils/pipe';
export {
    serialize,
    deserialize,
    decodeContent,
} from './utils/serialization';
export type {
    VFSExportManifest,
    VFSExportFileEntry,
    VFSExportAsset,
    VFSEncodedContent,
    SerializeDeps,
} from './utils/serialization';
export { createFileSystemSource, type FileSystemSourceOwner } from './impl/services/FileSystemSource';

export { exportFileSystem, importFileSystem, type FileSystemArchive } from './impl/services/file-system-archive';

export { operationScope, withOperation } from './utils/operation';
export { FileStorageAdapter } from './impl/services/FileStorageAdapter';
export { FileIgnoreFilter, type FileIgnorePolicy } from './impl/services/file-ignore';

export { transferFileSystemEntry, type TransferEntryOptions } from './impl/services/transfer-entry';
