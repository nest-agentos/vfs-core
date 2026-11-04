/**
 * @file packages/vfs-core/src/interfaces/plugin/plugin.ts
 * @desc 插件系统 — 中间件模式
 *
 * 设计：
 * - 使用 Express/Koa 风格中间件（next() 调用链）
 * - OperationContext 提供受限上下文（不暴露 VFS 内部）
 * - 插件通过 hooks 声明关注的操作类型
 * - 类型化操作名称 — 编译期安全
 *
 * 执行流程：
 * ┌─────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
 * │ Plugin A│───►│ Plugin B │───►│ Plugin C │───►│ Core Op  │
 * │ before  │    │ before   │    │ before   │    │ execute  │
 * │         │◄───│          │◄───│          │◄───│          │
 * │ after   │    │ after    │    │ after    │    │          │
 * └─────────┘    └──────────┘    └──────────┘    └──────────┘
 *
 * 每个中间件可以：
 * - 修改参数（ctx.args）
 * - 短路返回（不调用 next）
 * - 修改返回值（ctx.result）
 * - 抛出错误（中止操作）
 */

import type { FSNode, FileContent, FSNodeMetadata } from '../core/types';

// ═══════════════════════════════════════════════════════════════
// 操作类型
// ═══════════════════════════════════════════════════════════════

export type FSOperationType =
    | 'create'
    | 'read'
    | 'write'
    | 'delete'
    | 'rename'
    | 'move'
    | 'copy'
    | 'updateMetadata'
    | 'symlink'
    | 'hardlink';

// ═══════════════════════════════════════════════════════════════
// 操作上下文（受限，不暴露 VFS 内部）
// ═══════════════════════════════════════════════════════════════

export interface OperationContext {
    /** 操作类型 */
    readonly operation: FSOperationType;

    /** 模块 ID */
    readonly viewId: string;

    /** 操作目标节点（已存在的操作有值） */
    readonly node?: Readonly<FSNode>;

    /** 目标路径 */
    readonly path?: string;

    /**
     * 操作参数（可变，插件可修改）
     *
     * 具体内容取决于 operation:
     *
     * - create:  { name, parentPath, content?, type?, metadata?, tags? }
     * - read:    { encoding? }
     * - write:   { content, expectedVersion?, mode? }
     * - delete:  { assetDirStrategy?, recursive?, referencePolicy? }
     * - rename:  { newName, syncAssetDir? }
     * - move:    { targetParentPath, syncAssetDir? }
     * - copy:    { targetParentPath, newName?, copyAssetDir? }
     * - updateMetadata: { metadata }
     * - symlink: { linkPath, targetPath }
     * - hardlink: { linkPath, targetPath }
     */
    args: Record<string, unknown>;

    /**
     * 操作结果（after 阶段可读/可改）
     *
     * - create → FSNode
     * - read   → FileContent
     * - write  → void
     * - delete → void
     * - rename → void
     * - move   → void
     * - copy   → FSNode
     */
    result?: unknown;

    /**
     * 获取资产目录操作（受限 API）
     *
     * 允许插件在钩子中操作 assetdir 内的状态，
     * 但不暴露完整的 IFileSystem。
     */
    getAssetDir?(ownerIdOrPath: string): Promise<string | null>;
    putAsset?(ownerIdOrPath: string, assetName: string, content: FileContent): Promise<void>;
    getAsset?(ownerIdOrPath: string, assetName: string): Promise<FileContent | null>;
    listAssets?(ownerIdOrPath: string): Promise<string[]>;
    deleteAsset?(ownerIdOrPath: string, assetName: string): Promise<void>;

    /**
     * 元数据读写（受限 API）
     */
    getMetadata?(path: string): Promise<Readonly<FSNodeMetadata> | null>;
    patchMetadata?(path: string, patch: Partial<FSNodeMetadata>): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════
// 中间件
// ═══════════════════════════════════════════════════════════════

/**
 * 中间件 next 函数
 * 调用 next() 将控制权传递给下一个中间件或核心操作。
 * 不调用 next() 则短路返回（跳过后续中间件和核心操作）。
 */
export type MiddlewareNext = () => Promise<void>;

/**
 * 中间件处理函数
 *
 * @example
 * ```ts
 * const auditMiddleware: MiddlewareHandler = async (ctx, next) => {
 *   console.log(`[AUDIT] ${ctx.operation} on ${ctx.path}`);
 *   await next();
 *   console.log(`[AUDIT] ${ctx.operation} completed, result:`, ctx.result);
 * };
 *
 * const versionMiddleware: MiddlewareHandler = async (ctx, next) => {
 *   if (ctx.operation === 'write' && ctx.node) {
 *     // 写入前：快照当前内容到 assetdir
 *     const current = await ctx.getAsset?.(ctx.node.path, '.versions/latest');
 *     if (current) {
 *       const ts = Date.now().toString();
 *       await ctx.putAsset?.(ctx.node.path, `.versions/${ts}`, current);
 *     }
 *   }
 *   await next();
 * };
 * ```
 */
export type MiddlewareHandler = (
    ctx: OperationContext,
    next: MiddlewareNext,
) => Promise<void>;

// ═══════════════════════════════════════════════════════════════
// 插件
// ═══════════════════════════════════════════════════════════════

export interface PluginInfo {
    readonly name: string;
    readonly version?: string;
    readonly description?: string;
}

/**
 * 插件接口
 *
 * 一个插件可以注册多个中间件，每个关联到特定的操作类型。
 * 支持生命周期钩子（init/dispose）。
 *
 * @example
 * ```ts
 * const autoTagPlugin: IPlugin = {
 *   info: { name: 'auto-tag', version: '1.0.0' },
 *   middleware: [
 *     {
 *       operations: ['create', 'write'],
 *       priority: 100,
 *       handler: async (ctx, next) => {
 *         await next();
 *         // 创建/写入后自动根据内容添加标签
 *         if (ctx.result && ctx.node) {
 *           await ctx.patchMetadata?.(ctx.node.path, {
 *             ai_embeddingStatus: 'pending',
 *           });
 *         }
 *       },
 *     },
 *   ],
 * };
 * ```
 */
export interface IPlugin {
    readonly info: PluginInfo;

    /** 中间件声明 */
    readonly middleware: Array<{
        /** 关注的操作类型（空数组或 undefined = 全部操作） */
        operations?: FSOperationType[];
        /** 优先级（越小越先执行） @default 100 */
        priority?: number;
        /** 中间件处理函数 */
        handler: MiddlewareHandler;
    }>;

    /** 插件初始化 */
    init?(): Promise<void>;

    /** 插件销毁 */
    dispose?(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════
// 插件管理器
// ═══════════════════════════════════════════════════════════════

export interface IPluginManager {
    /** 注册插件 */
    register(plugin: IPlugin): void;

    /** 注销插件 */
    unregister(pluginName: string): void;

    /** 检查是否已注册 */
    has(pluginName: string): boolean;

    /** 获取插件信息 */
    getInfo(pluginName: string): PluginInfo | null;

    /** 列出所有已注册插件 */
    list(): PluginInfo[];

    /**
     * 执行中间件链
     *
     * VFS Engine 内部调用。组装该操作类型的所有中间件，
     * 按优先级排序后依次执行。
     *
     * @param operation 操作类型
     * @param ctx 操作上下文
     * @param coreOp 核心操作（中间件链末尾执行）
     */
    execute(
        operation: FSOperationType,
        ctx: OperationContext,
        coreOp: () => Promise<void>,
    ): Promise<void>;
}
