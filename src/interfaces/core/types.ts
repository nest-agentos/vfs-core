import type { OperationOptions } from './operation';
/**
 * @file packages/vfs-core/src/interfaces/core/types.ts
 * @desc VFS 基础类型定义
 *
 * 设计原则：
 * - FSNode 使用判别联合，编译器自动收窄类型专属字段
 * - FSCapabilities 保留 boolean 结构，IDE 补全友好，OCP 扩展
 * - 时间统一使用 number (ms epoch)，跨平台序列化友好
 * - FSNode 是不可变快照 — 所有字段 readonly
 */

// ═══════════════════════════════════════════════════════════════
// 节点类型
// ═══════════════════════════════════════════════════════════════

export type FSNodeBaseType = 'file' | 'directory';
export type FSNodeExtendedType = 'seqfile' | 'device' | 'symlink';
export type FSNodeType = FSNodeBaseType | FSNodeExtendedType;

// ═══════════════════════════════════════════════════════════════
// 元数据约定
// ═══════════════════════════════════════════════════════════════

/**
 * 节点元数据
 *
 * 继承 Record<string, unknown> 保持自由扩展，
 * 同时为已知的 AI 相关字段提供类型提示。
 */
export interface FSNodeMetadata extends Record<string, unknown> {
    /** The directory and its descendants have a fixed storage layout. Structural moves/deletes require explicit unpinning. */
    vfsFixedLayout?: boolean;
    /** AI Agent ID */
    ai_defaultAgent?: string;
    /** System prompt */
    ai_systemPrompt?: string;
    /** Initial prompt */
    ai_initialPrompt?: string;
    /** 向量嵌入状态 */
    ai_embeddingStatus?: 'pending' | 'processing' | 'done' | 'error';
}

// ═══════════════════════════════════════════════════════════════
// FSNode 判别联合（全部 readonly）
// ═══════════════════════════════════════════════════════════════

interface FSNodeBase {
    readonly parentPath: string | null;
    readonly name: string;
    readonly type: FSNodeType;
    readonly createdAt: number;
    readonly modifiedAt: number;
    readonly path: string;
    readonly version: number;
    readonly revision?: string;
    readonly tags: readonly string[];
    readonly metadata: Readonly<FSNodeMetadata>;
    readonly viewId?: string;
    readonly icon?: string;
    readonly mimeType?: string;
}

export interface FSFileNode extends FSNodeBase {
    readonly type: 'file';
    readonly size: number;
    readonly contentHash?: string;
    readonly assetDirPath?: string;
}

export interface FSDirectoryNode extends FSNodeBase {
    readonly type: 'directory';
    readonly childCount?: number;
}

export interface FSSeqFileNode extends FSNodeBase {
    readonly type: 'seqfile';
    readonly entryCount?: number;
    readonly assetDirPath?: string;
}

export interface FSDeviceNode extends FSNodeBase {
    readonly type: 'device';
    readonly deviceHandlerId: string;
}

export interface FSSymlinkNode extends FSNodeBase {
    readonly type: 'symlink';
    readonly symlinkTarget: string;
}

/**
 * 完整节点类型（判别联合）
 *
 * @example
 * ```ts
 * if (node.type === 'device') {
 *   node.deviceHandlerId; // string ✓
 * }
 * if (node.type === 'file') {
 *   node.size; // number ✓
 * }
 * ```
 */
export type FSNode =
    | FSFileNode
    | FSDirectoryNode
    | FSSeqFileNode
    | FSDeviceNode
    | FSSymlinkNode;

// ═══════════════════════════════════════════════════════════════
// 目录条目（轻量，列目录用）
// ═══════════════════════════════════════════════════════════════

export interface DirEntry {
    readonly path: string;
    readonly name: string;
    readonly type: FSNodeType;
    readonly size?: number;
    readonly modifiedAt: number;
}

// ═══════════════════════════════════════════════════════════════
// 引用类型
// ═══════════════════════════════════════════════════════════════

export type RefType = 'mention' | 'depend' | 'related' | 'embed';

export interface Reference {
    readonly sourcePath: string;
    readonly targetPath: string;
    readonly refType: RefType;
    readonly createdAt: number;
    readonly extra?: Readonly<Record<string, unknown>>;
}

// ═══════════════════════════════════════════════════════════════
// 文件内容类型
// ═══════════════════════════════════════════════════════════════

export type FileContent = string | ArrayBuffer | Uint8Array;

// ═══════════════════════════════════════════════════════════════
// 搜索（结构化查询）
// ═══════════════════════════════════════════════════════════════

export interface FSSearchQuery extends OperationOptions {
    /** 文件名匹配 */
    name?: {
        exact?: string;
        contains?: string;
        startsWith?: string;
        endsWith?: string;
        /** glob 模式 */
        pattern?: string;
    };
    /** 全文内容搜索 */
    text?: string;
    /** 节点类型过滤 */
    type?: FSNodeType | FSNodeType[];
    /** 标签过滤 */
    tags?: {
        /** 必须包含全部（AND） */
        all?: string[];
        /** 包含任一（OR） */
        any?: string[];
        /** 不包含（NOT） */
        none?: string[];
    };
    /** 元数据过滤 */
    metadata?: Record<string, unknown>;
    /** 修改时间范围 */
    modifiedAfter?: number;
    modifiedBefore?: number;
    /** 引用关系过滤 */
    referencedBy?: string;
    references?: string;
    /** 最大返回数量 @default 50 */
    limit?: number;
    /** 偏移 @default 0 */
    offset?: number;
    /** 排序 */
    orderBy?: 'name' | 'modifiedAt' | 'createdAt' | 'size';
    orderDirection?: 'asc' | 'desc';
    /** 向量近邻搜索（需要 capabilities.semanticSearch） */
    vector?: number[];
    semanticText?: string;
    minScore?: number;
}

export interface FSSearchResult {
    readonly nodes: readonly FSNode[];
    readonly total?: number;
    readonly hasMore: boolean;
}

// ═══════════════════════════════════════════════════════════════
// 能力声明
// ═══════════════════════════════════════════════════════════════

/**
 * 能力声明
 *
 * 布尔结构，IDE 补全友好。
 * 新增能力只需添加字段，已有实现默认 false（OCP）。
 */
export interface FSCapabilities {
    /** True only when file mutations can actually be rolled back atomically. */
    readonly atomicFileTransactions?: boolean;
    readonly readonly: boolean;
    readonly search: boolean;
    readonly semanticSearch: boolean;
    readonly syncable: boolean;
    readonly assets: boolean;
    readonly tags: boolean;
    readonly deviceFiles: boolean;
    readonly seqFiles: boolean;
    readonly transactionalSeqFiles?: boolean;
    readonly references: boolean;
    readonly symlinks: boolean;
    readonly hardlinks: boolean;
    readonly partialRead: boolean;
    readonly partialWrite: boolean;
    readonly treeWalk: boolean;
    readonly streaming: boolean;
    readonly watch: boolean;
    readonly mount: boolean;
}

// ═══════════════════════════════════════════════════════════════
// 统计
// ═══════════════════════════════════════════════════════════════

export interface FileSystemStats {
    readonly fileCount: number;
    readonly directoryCount: number;
    readonly totalSize: number;
    readonly lastModifiedAt: number;
    readonly typeBreakdown?: Readonly<Partial<Record<FSNodeType, number>>>;
}
