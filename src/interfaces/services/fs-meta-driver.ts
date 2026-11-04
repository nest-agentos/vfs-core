/**
 * @file packages/vfs-core/src/interfaces/services/fs-meta-driver.ts
 * @desc VFS 扩展元信息驱动接口
 *
 * IFSMetaDriver 封装了普通文件系统以外的 VFS 特性：
 *   - assetdir（文件伴生目录，存放附件和内部文件）
 *   - 标签（用户分类过滤）
 *   - SeqFile（K-V 序列文件，用于配置、SRS 数据等）
 *   - 双向引用（文档间链接追踪）
 *   - 文件监听（可选）
 *
 * 实现保证：
 *   - 文件无 assetdir 时，assets.* 方法返回合理默认值（空数组、null），不抛异常
 *   - 文件无标签时，tags.* 方法返回合理默认值
 *   - seq / refs 为可选能力，取决于后端是否支持（FSCapabilities.seqFiles / references）
 *   - watcher 为可选能力
 */

import type { IAssetOperations } from '../capabilities/asset-ops';
import type { ITagOperations } from '../capabilities/tag-ops';
import type { ISeqFileOperations } from '../capabilities/seq-file';
import type { IRefOperations } from '../capabilities/ref-ops';
import type { IWatchOperations } from '../capabilities/watch';

export interface IFSMetaDriver {
    /**
     * AssetDir 操作。
     * 文件无 assetdir 时返回合理默认值（空数组、null），不抛异常。
     */
    readonly assets: IAssetOperations;

    /**
     * 标签操作。
     * 文件无标签时返回合理默认值（空数组）。
     */
    readonly tags: ITagOperations;

    /** SeqFile K-V 操作（capabilities.seqFiles === true 时存在） */
    readonly seq?: ISeqFileOperations;

    /** 双向引用操作（capabilities.references === true 时存在） */
    readonly refs?: IRefOperations;

    /** 文件监听（capabilities.watch === true 时存在） */
    readonly watcher?: IWatchOperations;
}
