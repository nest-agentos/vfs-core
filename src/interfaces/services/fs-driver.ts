/**
 * @file packages/vfs-core/src/interfaces/services/fs-driver.ts
 * @desc 文件视图的操作接口
 *
 * IFSDriver 是 IFile 的底层依赖，已内部完成：
 *   - 在所属文件视图内解析绝对路径
 *   - 路径解析、权限控制、事件发射
 *
 * 搜索语义：search() 不返回 assetdir 内部节点；
 *   当内部节点匹配时，返回其宿主文件节点（去重）。
 *
 * 必选能力（后端不支持时抛 FSCapabilityError，而非静默忽略）：
 *   - transaction()
 *   - symlink() / readlink() / hardlink()
 */

import type { OperationOptions } from '../core/operation';

import type {
    FSNode,
    DirEntry,
    FSSearchQuery,
    FSSearchResult,
    FSCapabilities,
    FileSystemStats,
    FileContent,
} from '../core/types';
import type {
    ReadOptions,
    WriteOptions,
    CreateFileOptions,
    CreateDirectoryOptions,
    DeleteOptions,
    RenameOptions,
    MoveOptions,
    CopyOptions,
    ListOptions,
    TreeWalkOptions,
    TreeWalkCallback,
} from '../core/options';
import type { FSEventEmitter } from '../core/events';

// ═══════════════════════════════════════════════════════════════
// 事务
// ═══════════════════════════════════════════════════════════════

/**
 * 事务操作接口
 *
 * 与 IFSDriver 核心写入方法签名一致。
 * 事务内的事件在 commit 后重放；数据回滚能力由具体 backend 决定。
 */
export interface IFSDriverTransaction {
    getNode(path: string, options?: OperationOptions): Promise<FSNode | null>;
    readContent(path: string, options: ReadOptions & { encoding: 'utf-8' }): Promise<string>;
    readContent(path: string, options: ReadOptions & { encoding: 'binary' }): Promise<ArrayBuffer>;
    readContent(path: string, options?: ReadOptions): Promise<FileContent>;
    createFile(options: CreateFileOptions): Promise<FSNode>;
    createDirectory(options: CreateDirectoryOptions): Promise<FSNode>;
    writeContent(
        path: string,
        content: FileContent,
        options?: WriteOptions,
    ): Promise<void>;
    rename(
        path: string,
        newName: string,
        options?: RenameOptions,
    ): Promise<void>;
    move(
        paths: string[],
        targetParentPath: string | null,
        options?: MoveOptions,
    ): Promise<void>;
    delete(paths: string[], options?: DeleteOptions): Promise<void>;
    updateMetadata(
        path: string,
        metadata: Record<string, unknown>,
    ): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════
// 核心接口
// ═══════════════════════════════════════════════════════════════

export interface IFSDriver extends FSEventEmitter {
    /** 能力声明 */
    readonly capabilities: FSCapabilities;

    // ── 读取 ────────────────────────────────────────────────────

    /**
     * 获取节点详情
     * @param path 节点路径
     */
    getNode(path: string, options?: OperationOptions): Promise<FSNode | null>;

    /**
     * Type-only node lookup for capability checks (`FileSystemView.noLinks`): same source as
     * `getNode`, but allowed to skip metadata. Callers fall back to `getNode` when absent.
     */
    getNodeType?(path: string, options?: OperationOptions): Promise<Pick<FSNode, 'type'> | null>;

    /** 获取直接子节点 */
    getChildren(
        path: string,
        options?: ListOptions & { fields?: 'full' },
    ): Promise<FSNode[]>;
    getChildren(
        path: string,
        options: ListOptions & { fields: 'entry' },
    ): Promise<DirEntry[]>;
    getChildren(
        path: string,
        options?: ListOptions,
    ): Promise<FSNode[] | DirEntry[]>;

    /** 读取文件内容 */
    readContent(
        path: string,
        options: ReadOptions & { encoding: 'utf-8' },
    ): Promise<string>;
    readContent(
        path: string,
        options: ReadOptions & { encoding: 'binary' },
    ): Promise<ArrayBuffer>;
    readContent(path: string, options?: ReadOptions): Promise<FileContent>;

    /** 解析路径，确认节点存在 @returns 存在返回 path，不存在返回 null */
    resolvePath(path: string, options?: OperationOptions): Promise<string | null>;

    /** 检查路径是否存在 */
    exists(path: string, options?: OperationOptions): Promise<boolean>;

    /** 遍历节点树 */
    walkTree?(callback: TreeWalkCallback, options?: TreeWalkOptions): Promise<number>;

    /**
     * 搜索当前视图内节点。
     * assetdir 内部节点不出现在结果中，命中时映射为宿主文件节点。
     */
    search(query: FSSearchQuery): Promise<FSSearchResult>;

    /** 视图统计信息 */
    getStats?(): Promise<FileSystemStats>;

    // ── 写入 ────────────────────────────────────────────────────

    /**
     * 创建文件
     * @throws FSReservedNameError 文件名不符合当前名称规则
     * @emits node:created
     */
    createFile(options: CreateFileOptions): Promise<FSNode>;

    /**
     * 创建目录
     * @throws FSReservedNameError 目录名不符合当前名称规则
     * @emits node:created
     */
    createDirectory(options: CreateDirectoryOptions): Promise<FSNode>;

    /**
     * 写入文件内容
     * @emits node:updated
     */
    writeContent(
        path: string,
        content: FileContent,
        options?: WriteOptions,
    ): Promise<void>;

    /**
     * 追加内容
     * @emits node:updated
     */
    appendContent(path: string, content: FileContent): Promise<void>;

    /**
     * 重命名（assetdir 默认跟随）
     * @emits node:renamed
     */
    rename(
        path: string,
        newName: string,
        options?: RenameOptions,
    ): Promise<void>;

    /**
     * 移动节点（assetdir 默认跟随）
     * @emits node:moved
     */
    move(
        paths: string[],
        targetParentPath: string | null,
        options?: MoveOptions,
    ): Promise<void>;

    /**
     * 删除节点（级联删除子节点和 assetdir）
     * @emits node:deleted
     */
    delete(paths: string[], options?: DeleteOptions): Promise<void>;

    /**
     * 更新元数据（合并模式）
     * @emits node:updated
     */
    updateMetadata(
        path: string,
        metadata: Record<string, unknown>,
    ): Promise<void>;

    // ── 复制 ────────────────────────────────────────────────────

    /** 深度复制节点（含子节点和 assetdir） */
    copy?(
        sourcePath: string,
        targetParentPath: string | null,
        newName?: string,
        options?: CopyOptions,
    ): Promise<FSNode>;

    // ── 链接（必选，不支持时抛 FSCapabilityError）────────────────

    /** 创建符号链接 */
    symlink(linkPath: string, targetPath: string): Promise<FSNode>;

    /** 读取符号链接目标（不解析，返回原始路径） */
    readlink(path: string): Promise<string>;

    /** 创建硬链接 */
    hardlink(linkPath: string, targetPath: string): Promise<FSNode>;

    // ── 事务（必选，不支持时抛 FSCapabilityError）────────────────

    /**
     * 在事务中执行多个操作。
     * 事件在 commit 后统一重放（带 fromTransaction 标记），rollback 时丢弃事件。
     *
     * 注意：文件级操作的数据原子性取决于后端 backend.transaction 是否提供隔离，
     * 本层不伪造回滚（Memory/IndexedDB 后端为透传实现）。SeqFile 记录级原子性
     * 由 meta.seq.transaction（IRecordStore.transaction）提供。
     *
     * @example
     * await driver.transaction(async (tx) => {
     *   const f = await tx.createFile({ name: 'a.md', parentPath: null });
     *   await tx.writeContent(f.path, 'hello');
     * });
     */
    transaction<T>(fn: (tx: IFSDriverTransaction) => Promise<T>): Promise<T>;
}
