/**
 * @file packages/vfs-core/src/interfaces/core/options.ts
 * @desc 操作选项
 *
 * 每个操作使用独立选项接口（ISP），
 * 默认值由实现方定义（CoC），此处通过 JSDoc 标注。
 */

import type { OperationOptions } from './operation';

import type { FSNodeType, FSNodeMetadata } from './types';

/**
 * 节点可见性过滤选项（ListOptions / TreeWalkOptions 共用）
 */
export interface VisibilityOptions {
    /** 包含隐藏文件（. 开头）@default false */
    includeHidden?: boolean;
    /** 包含 assetdir（单下划线前缀，如 _note.md/）@default false */
    includeAssetDirs?: boolean;
    /** 包含模块内部配置目录（双下划线前缀，如 __meta/）@default false */
    includeInternalDirs?: boolean;
}

export interface ReadOptions extends OperationOptions {
    ifRevision?: string;
    /** Validator belonging to the returned bytes, never a separate stat result. */
    onRevision?: (revision: string | undefined) => void;
    /** auto preserves SeqFile projection; bytes reads physical content; records reads only the record projection. */
    representation?: 'auto' | 'bytes' | 'records';
    /** 起始偏移（需要 capabilities.partialRead） */
    offset?: number;
    /** 读取长度（需要 capabilities.partialRead） */
    length?: number;
    /**
     * 编码提示
     * - 'utf-8': 返回 string
     * - 'binary': 返回 ArrayBuffer
     * - 'auto': 由实现根据 mimeType/扩展名决定
     * @default 'auto'
     */
    encoding?: 'utf-8' | 'binary' | 'auto';
    /** 设备会话 ID（仅设备文件有效） */
    deviceSessionId?: string;
}

export interface WriteOptions extends OperationOptions {
    ifRevision?: string;
    onRevision?: (revision: string | undefined) => void;
    /** 起始偏移（需要 capabilities.partialWrite） */
    offset?: number;
    /**
     * 写入模式
     * @default 'overwrite'
     */
    mode?: 'overwrite' | 'append';
    /**
     * 乐观锁：期望的版本号
     * 不匹配时抛出 FSConflictError
     * 不传则不检查版本
     */
    expectedVersion?: number;
    /** 设备会话 ID（仅设备文件有效） */
    deviceSessionId?: string;
    /** 同时更新元数据 */
    metadata?: Partial<FSNodeMetadata>;
}

export interface CreateFileOptions extends OperationOptions {
    name: string;
    parentPath: string | null;
    content?: string | ArrayBuffer;
    metadata?: FSNodeMetadata;
    tags?: string[];
    icon?: string;
    /** @default 'file' */
    type?: FSNodeType;
    /**
     * 是否递归创建中间目录
     * @default false
     */
    recursive?: boolean;
    /**
     * 已存在时是否覆盖
     * @default false
     */
    overwrite?: boolean;
}

export interface CreateDirectoryOptions extends OperationOptions {
    name: string;
    parentPath: string | null;
    metadata?: FSNodeMetadata;
    icon?: string;
    /**
     * 是否递归创建中间目录
     * @default false
     */
    recursive?: boolean;
}

export interface DeleteOptions extends OperationOptions {
    /**
     * AssetDir 处理策略
     * - 'remove': 同时删除 assetdir 及其全部内容（默认）
     * - 'orphan': 保留目录但降级为普通目录
     * - 'keep':   完全不处理 assetdir
     * @default 'remove'
     */
    assetDirStrategy?: 'remove' | 'orphan' | 'keep';
    /**
     * 删除目录时是否递归
     * @default false
     */
    recursive?: boolean;
    /**
     * 是否强制删除（忽略不存在等错误）
     * @default false
     */
    force?: boolean;
    /**
     * 引用处理策略
     * - 'clean': 清除所有关联的双向引用（默认）
     * - 'deny':  存在入向引用时拒绝删除
     * - 'ignore': 不处理引用（留下悬空引用）
     * @default 'clean'
     */
    referencePolicy?: 'clean' | 'deny' | 'ignore';
}

export interface RenameOptions extends OperationOptions {
    /**
     * 是否同步重命名 assetdir
     * @default true
     */
    syncAssetDir?: boolean;
}

export interface MoveOptions extends OperationOptions {
    /**
     * 是否同步移动 assetdir
     * @default true
     */
    syncAssetDir?: boolean;
}

export interface CopyOptions extends OperationOptions {
    /**
     * 已存在时是否覆盖
     * @default false
     */
    overwrite?: boolean;
    /**
     * 是否同时复制 assetdir
     * @default true
     */
    copyAssetDir?: boolean;
    /**
     * 是否递归创建中间目录
     * @default false
     */
    recursive?: boolean;
}

export interface ListOptions extends VisibilityOptions, OperationOptions {
    /**
     * 返回字段控制
     * - 'full': 返回完整 FSNode（默认）
     * - 'entry': 仅返回 DirEntry（轻量）
     * @default 'full'
     */
    fields?: 'full' | 'entry';
}

export interface TreeWalkOptions extends VisibilityOptions, OperationOptions {
    /** 遍历顺序 @default 'depth-first' */
    order?: 'breadth-first' | 'depth-first';
    /** 最大深度，rootPath 自身深度为 0；-1 无限制 @default -1 */
    maxDepth?: number;
    /** 起始目录（包含该节点） @default 视图根目录 */
    rootPath?: string;
    /** 类型过滤 */
    typeFilter?: FSNodeType | FSNodeType[];
    /** 最大返回数量 */
    limit?: number;
}

/**
 * 树遍历回调
 * @returns true/void 继续 | false 停止 | 'skip' 跳过子树
 */
export type TreeWalkCallback = (
    node: import('./types').FSNode,
    depth: number,
) => boolean | void | 'skip' | Promise<boolean | void | 'skip'>;
