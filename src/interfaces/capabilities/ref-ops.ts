/**
 * @file packages/vfs-core/src/interfaces/capabilities/ref-ops.ts
 * @desc 双向引用操作子接口
 *
 * 通过 IFileSystem.refs 访问（当 capabilities.references === true）。
 */

import type { RefType, Reference } from '../core/types';

export interface RefQueryOptions {
    refTypes?: RefType[];
    limit?: number;
    offset?: number;
}

export interface IRefOperations {
    /** 添加引用 */
    addRef(
        sourcePath: string,
        targetPath: string,
        refType: RefType,
        extra?: Record<string, unknown>,
    ): Promise<void>;

    /** 移除引用 */
    removeRef(
        sourcePath: string,
        targetPath: string,
        refType: RefType,
    ): Promise<void>;

    /**
     * 流式遍历正向引用（替代 getOutgoing）。
     * callback 返回 false 时提前终止。
     * 返回实际处理数量。
     */
    walkOutgoing(
        path: string,
        callback: (ref: Reference) => boolean | Promise<boolean>,
        opts?: RefQueryOptions,
    ): Promise<number>;

    /**
     * 流式遍历反向引用（替代 getIncoming）。
     * callback 返回 false 时提前终止。
     * 返回实际处理数量。
     */
    walkIncoming(
        path: string,
        callback: (ref: Reference) => boolean | Promise<boolean>,
        opts?: RefQueryOptions,
    ): Promise<number>;

    /** 检查引用是否存在 */
    hasRef(
        sourcePath: string,
        targetPath: string,
        refType: RefType,
    ): Promise<boolean>;

    /**
     * 全量同步正向引用
     * 替换 source 的所有出向引用为新列表。
     * 用于内容解析后批量更新。
     */
    syncOutgoing(
        sourcePath: string,
        refs: Array<{
            targetPath: string;
            refType: RefType;
            extra?: Record<string, unknown>;
        }>,
    ): Promise<void>;
}
