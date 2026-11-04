/**
 * @file packages/vfslib/src/utils/validation.ts
 * @desc 文件名与路径验证工具
 */

import {
    HIDDEN_FILE_PREFIX,
    ASSET_DIR_PREFIX,
    INTERNAL_DIR_PREFIX,
    DEFAULT_FILENAME_PATTERN,
} from '../protocol';

export function isHiddenName(name: string): boolean {
    return name.startsWith(HIDDEN_FILE_PREFIX);
}

/** 单下划线前缀（assetdir），不含双下划线 */
export function isAssetDirName(name: string): boolean {
    return name.startsWith(ASSET_DIR_PREFIX) && !name.startsWith(INTERNAL_DIR_PREFIX);
}

/** 双下划线前缀（模块内部配置目录，如 __meta/） */
export function isInternalDirName(name: string): boolean {
    return name.startsWith(INTERNAL_DIR_PREFIX);
}

export function isReservedName(name: string): boolean {
    return isHiddenName(name) || isAssetDirName(name) || isInternalDirName(name);
}

export function toAssetDirName(hostName: string): string {
    return ASSET_DIR_PREFIX + hostName;
}

export function fromAssetDirName(name: string): string | null {
    return isAssetDirName(name) ? name.slice(ASSET_DIR_PREFIX.length) : null;
}

export function validateFilename(name: string, pattern: RegExp = DEFAULT_FILENAME_PATTERN): string | null {
    if (!name) return 'filename cannot be empty';
    if (name === '.' || name === '..') return `'${name}' is reserved`;
    if (name.includes('/') || name.includes('\\')) return 'filename cannot contain path separators';
    if (name.length > 255) return 'filename too long';
    if (!pattern.test(name)) return `filename '${name}' contains invalid characters`;
    return null;
}

export function isPath(path: string): boolean {
    return path.startsWith('/');
}
