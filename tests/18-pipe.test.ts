/**
 * pipe(): 从源 IIOStream 复制到目标 IIOStream。
 * 验证文件作为目标的写入,以及流式源的逐块读取。
 */
import { describe, it, expect } from 'vitest';
import { setupVFS, type TestVFS } from './helpers';
import { pipe, type IIOStream } from '@itookit/vfs-core';

/** 内存实现 IIOStream,用于验证 pipe 行为。 */
function makeMemoryStream(initial: string): IIOStream {
    let buffer = initial;
    const writes: Array<string | ArrayBuffer | Uint8Array> = [];
    return {
        read: async () => buffer,
        write: async (content) => { writes.push(content); buffer += typeof content === 'string' ? content : ''; },
        readStream: async function* () {
            // yield per character to exercise chunking
            for (const ch of buffer) yield ch;
        },
        close: async () => {},
    };
}

describe('pipe (IIOStream)', () => {
    let vfs: TestVFS;
    beforeEach(async () => { vfs = await setupVFS(); });
    afterEach(async () => { await vfs.dispose(); });

    it('copies a file as target via IFile', async () => {
        const { fs } = vfs;
        const node = await fs.driver.createFile({ name: 'out.txt', parentPath: null, content: '' });
        const file = fs.openFile(node.path);
        // Single-block source (no readStream) → single write() to the file.
        const src: IIOStream = { read: async () => 'hello', write: async () => {} };

        await pipe(src, file);
        const result = await file.read();
        // FileHandle may return a string or an ArrayBuffer depending on storage.
        const text = typeof result === 'string' ? result : new TextDecoder().decode(result);
        expect(text).toBe('hello');
    });

    it('streams source chunks into target', async () => {
        const chunks: string[] = [];
        const target = makeMemoryStream('');
        const src = makeMemoryStream('hello');

        await pipe(src, target, { onChunk: (c) => { if (typeof c === 'string') chunks.push(c); } });

        expect(chunks.join('')).toBe('hello');
    });

    it('closes target when closeTarget is set', async () => {
        let closed = false;
        const target: IIOStream = {
            read: async () => '',
            write: async () => {},
            close: async () => { closed = true; },
        };
        const src = makeMemoryStream('x');
        await pipe(src, target, { closeTarget: true });
        expect(closed).toBe(true);
    });

    it('falls back to read() when source has no readStream', async () => {
        const target = makeMemoryStream('');
        const src: IIOStream = { read: async () => 'whole-content', write: async () => {} };
        await pipe(src, target);
        expect(await target.read()).toBe('whole-content');
    });
});
