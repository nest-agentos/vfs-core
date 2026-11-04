/**
 * @file packages/vfs-core/src/utils/pipe.ts
 * @desc 流管道 — 从源 IO 流复制到目标 IO 流。
 *
 * 支持文件 (IFile) 与设备 (IDeviceHandle) 之间的任意衔接：
 *   LLM → 文件 (聊天持久化)、文件 → TTY (展示)、TTY → LLM (交互循环)。
 */

import type { IIOStream } from '../interfaces/io';
import type { FileContent } from '../interfaces/core/types';

export interface PipeOptions {
    /** 是否在读取完成后关闭源流 */
    closeSource?: boolean;
    /** 是否在写入完成后关闭目标流 */
    closeTarget?: boolean;
    /** 每块数据写入后的回调(可用于进度/日志) */
    onChunk?: (chunk: FileContent) => void | Promise<void>;
}

/**
 * 将源流的内容全部复制到目标流。
 * 源流优先使用 readStream() 流式读取;否则回退到一次 read()。
 */
export async function pipe(
    source: IIOStream,
    target: IIOStream,
    options: PipeOptions = {},
): Promise<void> {
    try {
        if (source.readStream) {
            for await (const chunk of source.readStream()) {
                await target.write(chunk);
                await options.onChunk?.(chunk);
            }
        } else {
            const content = await source.read();
            await target.write(content);
            await options.onChunk?.(content);
        }
    } finally {
        if (options.closeSource) await source.close?.();
        if (options.closeTarget) await target.close?.();
    }
}
