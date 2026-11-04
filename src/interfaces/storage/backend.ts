/**
 * @file packages/vfs-core/src/interfaces/storage/backend.ts
 * @desc 统一 path-based 存储后端接口
 *
 * v4.1: 废弃 IInodeStore / IMetaStore / IContentStore 三层分离。
 * 后端使用 path 作为主键，统一暴露类 fs.promises API。
 *
 * 可选能力（transaction / symlink / search / records）通过鸭子类型暴露。
 * 不支持的实现将对应属性设为 undefined 或不定义。
 */

import type { OperationOptions } from '../core/operation';
import type { FSNode, FSSearchQuery, DirEntry } from '../core/types';
import type { IRecordStore } from './record-backend';

export interface IStorageBackend {
    readonly name: string;
    readonly fileStorage?: import('./file-storage').FileStorageBackend;

    // ── 结构操作 ──

    /** 获取节点信息 */
    stat(path: string, options?: OperationOptions): Promise<FSNode | null>;

    /**
     * Type-only lookup for capability checks (`FileSystemView.noLinks`). Must derive the type from
     * the same source as `stat`, but a backend whose `stat` pays a remote/sidecar round trip should
     * override this to skip it. Callers fall back to `stat` when absent.
     */
    statType?(path: string, options?: OperationOptions): Promise<Pick<FSNode, 'type'> | null>;

    /** 列出子节点 */
    list(path: string, options?: OperationOptions): Promise<FSNode[]>;
    /** Same children as list, without extended metadata. Fall back to list when absent. */
    listEntries?(path: string, options?: OperationOptions): Promise<DirEntry[]>;

    /** 创建目录 */
    mkdir(path: string, options?: OperationOptions): Promise<FSNode>;

    /** 删除节点 */
    delete(path: string, options?: OperationOptions & { recursive?: boolean }): Promise<void>;

    /**
     * Optional subtree layout guard for structural mutations. Ancestors are still checked
     * by the engine. A projection may delegate protection to the physical mutation it owns,
     * rather than recursively walking display-only children. Throw when the mutation is blocked.
     */
    assertMutableSubtree?(path: string): Promise<void>;

    /** 重命名/移动 */
    rename(fromPath: string, toPath: string, options?: OperationOptions): Promise<void>;

    // ── 内容操作 ──

    /** 读取文件内容 */
    read(path: string, options?: import('../core/options').ReadOptions): Promise<Uint8Array>;

    /** 写入文件内容 */
    write(path: string, content: Uint8Array): Promise<FSNode>;
    replace?(path: string, content: Uint8Array, condition: import('./file-storage').ReplaceCondition, options?: OperationOptions): Promise<FSNode>;

    // ── 元数据 ──

    /** 更新元数据（合并语义） */
    updateMetadata(path: string, metadata: Record<string, unknown>): Promise<void>;

    /** 设置标签（全量替换） */
    setTags(path: string, tags: string[]): Promise<void>;

    /** 获取所有已使用的标签 */
    getAllTags(): Promise<string[]>;

    /** Indexed associations only; must not traverse files or read content. */
    listTagEntries?(): Promise<Array<{ path: string; tag: string }>>;

    // ── 选配能力（不支持的后端返回 undefined） ──

    /** SeqFile K-V 记录存储 */
    records?: IRecordStore;
    /** 全文/标签搜索 */
    search?(query: FSSearchQuery): Promise<FSNode[]>;

    /** 创建符号链接 */
    symlink?(linkPath: string, target: string): Promise<void>;

    /** 读取符号链接目标 */
    readlink?(path: string): Promise<string>;

    /** 事务（tx 复用 IStorageBackend 接口） */
    transaction?<T>(fn: (tx: IStorageBackend) => Promise<T>): Promise<T>;

    // ── 生命周期 ──

    init(options?: OperationOptions): Promise<void>;
    close(): Promise<void>;
}

/** 类型守卫：检查后端是否有记录存储 */
export function hasRecordStore(
    backend: IStorageBackend,
): backend is IStorageBackend & { records: IRecordStore } {
    return backend.records != null;
}
