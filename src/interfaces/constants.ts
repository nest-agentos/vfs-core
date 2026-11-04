/**
 * @file packages/vfs-core/src/interfaces/constants.ts
 * @desc 全局常量
 */

/** 系统配置目录路径（rootfs 内置，始终存在，不可卸载） */
export const ETC_DIR = '/etc';

/** 系统保留目录 */
export const SYSTEM_DIRS = ['etc', 'dev'] as const;

/** AssetDir 名称前缀（单下划线，如 _note.md/） */
export const ASSET_DIR_PREFIX = '_';

/** 模块内部配置目录前缀（双下划线，如 __meta/）*/
export const INTERNAL_DIR_PREFIX = '__';

/** 隐藏文件前缀 */
export const HIDDEN_FILE_PREFIX = '.';

/** Symlink 解析最大深度 */
export const DEFAULT_MAX_SYMLINK_DEPTH = 40;

/**
 * 默认文件名校验正则
 * - 单 `_` 前缀（assetdir）：禁止用户创建，由系统代码直接写入 inode
 * - 双 `__` 前缀（模块内部配置目录 __config/）：允许，但默认不列出
 * - `.` 前缀（隐藏文件）：由文件视图检查访问范围，此处不拦截
 */
export const DEFAULT_FILENAME_PATTERN = /^(?!_(?!_))[^/\\][^/\\]*$/;

/** 默认搜索返回数量 */
export const DEFAULT_SEARCH_LIMIT = 50;

/**
 * Reserved metadata key storing a device node's driver handler id.
 * Backends materialize FSDeviceNode by reading this key from node metadata.
 */
export const DEVICE_HANDLER_METADATA_KEY = '__vfs_device_handler';
