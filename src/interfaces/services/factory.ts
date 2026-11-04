/**
 * @file packages/vfs-core/src/interfaces/services/factory.ts
 * @desc VFS 工厂
 *
 * 面向不同运行环境提供统一的 VFS 实例创建方式。
 */

import type { IVFSManager } from './vfs-manager';
import type { IConfigService } from './config-service';
import type { IStorageBackend } from '../storage/backend';
import type { IDeviceDriver } from '../device/device';
import type { IPlugin } from '../plugin/plugin';
import type { MountOptions } from '../mount/mount';

export interface VFSFactoryOptions {
    /**
     * 根存储后端
     *
     * 此后端挂载到 "/"，是所有路径的默认存储。
     */
    rootBackend: IStorageBackend;

    /**
     * 额外挂载点
     *
     * 初始化时自动挂载的非根存储后端。
     *
     * @example
     * ```ts
     * additionalMounts: [
     *   { path: '/archive', backend: s3Backend, options: { syncable: true } },
     *   { path: '/tmp', backend: memoryBackend, options: { readonly: false } },
     * ]
     * ```
     */
    additionalMounts?: Array<{
        path: string;
        backend: IStorageBackend;
        options?: MountOptions;
    }>;

    /** 内置设备驱动 */
    devices?: IDeviceDriver[];

    /** 内置插件 */
    plugins?: IPlugin[];

    /**
     * 初始配置（仅首次创建时写入，已有数据不覆盖）
     */
    initialConfigs?: Record<string, Record<string, string>>;

    /**
     * 文件名验证正则（默认禁止 . 和 _ 开头）
     * @default /^[^._][^/\\]*$/
     */
    filenamePattern?: RegExp;
}

export interface BrowserVFSOptions extends VFSFactoryOptions {
    /** @default 'indexeddb' */
    storageAdapter?: 'indexeddb' | 'opfs';
    dbName?: string;
    dbVersion?: number;
}

export interface ElectronVFSOptions extends VFSFactoryOptions {
    rootDir: string;
    enableWatch?: boolean;
}

export interface ServerVFSOptions extends VFSFactoryOptions {
    /** 数据库连接字符串（PostgreSQL / SQLite） */
    connectionString?: string;
}

/**
 * 工厂返回值：VFSManager + ConfigService
 *
 * 分离返回，消费方按需注入 DI 容器。
 */
export interface VFSInstance {
    manager: IVFSManager;
    config: IConfigService;
}

/**
 * 工厂函数签名
 *
 * 各平台导出各自的实现：
 * - electron: createVFS({ rootBackend: new SQLiteBackend(...) })
 * - browser:  createVFS({ rootBackend: new IndexedDBBackend(...) })
 * - server:   createVFS({ rootBackend: new PostgresBackend(...) })
 */
export type VFSFactory<T extends VFSFactoryOptions = VFSFactoryOptions> = (
    options: T,
) => Promise<VFSInstance>;
