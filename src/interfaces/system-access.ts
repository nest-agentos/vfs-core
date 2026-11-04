/**
 * @file packages/vfs-core/src/interfaces/system-access.ts
 * @desc 系统级 /etc 访问接口 — 替代原有的 systemFS: IFileSystem 注入
 *
 * 设备驱动通过 DeviceContext.systemAccess 获取此接口，
 * 以系统身份读写 /etc 下的配置（含隐藏文件），无需经过模块文件系统。
 */

export interface ISystemAccess {
    /**
     * 以系统身份读取 /etc 下的文件（含隐藏文件）。
     * @param relativePath 相对于 /etc 的路径，如 ".credentials" 或 "public/config.json"
     *                      允许带前导 /，内部自动规范化
     */
    readEtc(relativePath: string): Promise<string>;

    /**
     * 以系统身份写入 /etc 下的文件。
     * @param relativePath 相对于 /etc 的路径
     * @param content 写入内容
     */
    writeEtc(relativePath: string, content: string): Promise<void>;

    /**
     * 列出 /etc 目录内容（含隐藏文件）。
     * @param relativePath 相对于 /etc 的子目录路径，默认 /
     */
    listEtc(relativePath?: string): Promise<string[]>;

    /**
     * 删除 /etc 下的文件或目录。
     * @param relativePath 相对于 /etc 的路径
     */
    deleteEtc(relativePath: string): Promise<void>;
}
