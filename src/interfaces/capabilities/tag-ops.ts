/**
 * @file packages/vfs-core/src/interfaces/capabilities/tag-ops.ts
 * @desc 标签操作子接口
 *
 * 通过 IFileSystem.tags 访问（当 capabilities.tags === true）。
 */

export interface TagDefinition {
    name: string;
    color?: string;
    refCount?: number;
}

export interface ITagOperations {
    /** 获取本模块所有标签定义 */
    getAllTags(): Promise<TagDefinition[]>;

    /** Indexed associations within this view, with view-relative paths. */
    listTagEntries?(): Promise<Array<{ path: string; tag: string }>>;

    /** 设置节点标签（全量替换，空数组清除） */
    setTags(path: string, tags: string[]): Promise<void>;

    /** 添加标签（增量） */
    addTag(path: string, tag: string): Promise<void>;

    /** 移除标签 */
    removeTag(path: string, tag: string): Promise<void>;

    /**
     * 按标签流式遍历节点路径（替代 findByTag）。
     * callback 返回 false 时提前终止。
     */
    walkByTag(
        tag: string,
        callback: (path: string) => boolean | Promise<boolean>,
        options?: { limit?: number; offset?: number },
    ): Promise<{ total: number; processed: number }>;

    /** 更新标签定义（如颜色），不影响节点关联 */
    updateTagDefinition?(
        tagName: string,
        updates: Partial<Omit<TagDefinition, 'name'>>,
    ): Promise<void>;

    /** 流式遍历所有标签定义（可选） */
    walkTags?(
        callback: (tag: TagDefinition) => boolean | Promise<boolean>,
        options?: { prefix?: string; limit?: number },
    ): Promise<number>;

    /** 统计标签总数（可选，避免全量加载） */
    countTags?(): Promise<number>;
}
