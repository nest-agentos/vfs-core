/**
 * @file packages/vfs-core/src/interfaces/capabilities/asset-ops.ts
 * @desc AssetDir 操作子接口
 *
 * 通过 IFileSystem.assets 访问（当 capabilities.assets === true）。
 *
 * 命名约定：文件 "report.md" → assetdir "_report.md/"
 *
 * 生命周期：
 * - 首次 putAsset 时自动创建 assetdir
 * - 宿主文件删除时默认级联删除
 * - 宿主文件重命名时 assetdir 跟随重命名
 */

import type { FSNode, FileContent } from '../core/types';

export interface IAssetOperations {
    /**
     * 写入资产（assetdir 不存在则自动创建）
     *
     * @param ownerPath 宿主文件（必须是 file 或 seqfile）
     * @param assetName 资产文件名
     * @param content 内容
     * @throws FSError('EISDIR') owner 是目录
     */
    putAsset(
        ownerPath: string,
        assetName: string,
        content: FileContent,
    ): Promise<FSNode>;

    /** 读取资产 @returns 不存在返回 null */
    getAsset(ownerPath: string, assetName: string): Promise<FileContent | null>;

    /** 获取 assetdir 路径 @returns 不存在返回 null */
    getAssetDirPath(ownerPath: string): Promise<string | null>;

    /** 确保 assetdir 存在（幂等） @returns assetdir 路径 */
    ensureAssetDir(ownerPath: string): Promise<string>;

    /** 列出资产文件名 */
    listAssets(ownerPath: string, includeHidden?: boolean): Promise<string[]>;

    /** 删除单个资产 */
    deleteAsset(ownerPath: string, assetName: string): Promise<void>;

    /** 删除整个 assetdir */
    removeAssetDir(ownerPath: string, removeContent?: boolean): Promise<void>;

    /** 检查 assetdir 是否存在 */
    hasAssetDir(ownerPath: string): Promise<boolean>;

    /**
     * 校验 assetdir 完整性
     * @returns 问题列表（空数组表示正常）
     */
    validateAssetDir?(ownerPath: string): Promise<string[]>;

    /** 修复 assetdir（重建关联等） */
    repairAssetDir?(ownerPath: string): Promise<void>;
}
