/**
 * @file packages/vfs-core/src/interfaces/capabilities/watch.ts
 * @desc 文件监听子接口
 *
 * 通过 IFileSystem.watcher 访问（当 capabilities.watch === true）。
 */

export interface FileChangeEvent {
    type: 'create' | 'modify' | 'delete' | 'rename' | 'metadata';
    path: string;
    oldPath?: string;
    timestamp: number;
}

export interface WatchOptions {
    /** 是否递归监听子目录 @default false */
    recursive?: boolean;
    /** 防抖间隔 (ms) @default 100 */
    debounceMs?: number;
    /** 忽略的文件名模式 */
    ignorePatterns?: string[];
}

export interface Watcher {
    close(): void;
}

export interface IWatchOperations {
    /**
     * 监听路径变更
     *
     * @param path 要监听的文件或目录路径
     * @param callback 变更回调
     * @param options 选项
     * @returns Watcher 实例
     */
    watch(
        path: string,
        callback: (event: FileChangeEvent) => void,
        options?: WatchOptions,
    ): Watcher;
}
