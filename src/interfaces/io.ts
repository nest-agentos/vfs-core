/**
 * @file packages/vfs-core/src/interfaces/io.ts
 * @desc 通用 IO 流 — 文件与设备的公共读/写/流语义。
 *
 * 统一 fs io (IFile)、llm/tty io (IDeviceHandle) 的最小公约数。
 * 只约定"可读写",不承诺寻址/元数据/会话等高级语义(由各实现扩展)。
 */

import type { FileContent } from './core/types';

/**
 * 最小 IO 流。文件与设备都能承载此语义：
 * - `IFile`(文件句柄):read/write + 元数据 + assets
 * - `IDeviceHandle`(LLM/TTY 会话):read/write + readStream + close
 */
export interface IIOStream {
    /** 读取一次输出 */
    read(): Promise<FileContent>;
    /** 写入数据 */
    write(content: FileContent): Promise<void>;
    /** 流式读取(支持则提供) */
    readStream?(): AsyncIterable<string | ArrayBuffer>;
    /** 关闭流(设备关闭会话;文件可选) */
    close?(): Promise<void>;
}
