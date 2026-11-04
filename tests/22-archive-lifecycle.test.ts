import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVFS, exportFileSystem, importFileSystem, MemoryBackend } from '../src';
import { setupVFS } from './helpers';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe('filesystem archive', () => {
    it('round trips binary content, hidden assets, metadata, references and sequence counters', async () => {
        const source = await setupVFS(), target = await setupVFS();
        cleanup.push(source.dispose, target.dispose);
        const fs = source.fs;
        await fs.driver.createFile({ name: 'image.bin', parentPath: '/', content: new Uint8Array([0, 255, 128, 10]).buffer });
        await fs.driver.createFile({ name: 'events.seq', parentPath: '/', type: 'seqfile' });
        await fs.meta.seq!.transaction!(tx => tx.append('/events.seq', 'event/', 'first'));
        await fs.openFile('/events.seq').asset('hidden.txt').write('attachment');
        await fs.driver.updateMetadata('/image.bin', { title: 'Binary' });
        await fs.meta.tags.setTags('/image.bin', ['picture']);
        await fs.meta.refs!.syncOutgoing('/events.seq', [{ targetPath: '/image.bin', refType: 'embed' }]);
        const archive = JSON.parse(JSON.stringify(await exportFileSystem(fs)));
        await importFileSystem(target.fs, archive);
        expect(new Uint8Array(await target.fs.driver.readContent('/image.bin', { encoding: 'binary' }))).toEqual(new Uint8Array([0, 255, 128, 10]));
        expect(await target.fs.openFile('/events.seq').asset('hidden.txt').readText()).toBe('attachment');
        expect((await target.fs.driver.getNode('/image.bin'))?.metadata.title).toBe('Binary');
        expect((await target.fs.driver.getNode('/image.bin'))?.tags).toEqual(['picture']);
        expect(await target.fs.meta.seq!.transaction!(tx => tx.append('/events.seq', 'event/', 'second'))).toBe('event/0000000000000002');
        const refs: string[] = [];
        await target.fs.meta.refs!.walkOutgoing('/events.seq', ref => { refs.push(ref.targetPath); return true; });
        expect(refs).toEqual(['/image.bin']);
    });

    it('rejects malformed content before changing any destination file', async () => {
        const source = await setupVFS(), target = await setupVFS();
        cleanup.push(source.dispose, target.dispose);
        await source.fs.driver.createFile({ name: 'keep.txt', parentPath: '/', content: 'replacement' });
        await source.fs.driver.createFile({ name: 'bad.txt', parentPath: '/', content: 'bad' });
        await target.fs.driver.createFile({ name: 'keep.txt', parentPath: '/', content: 'original' });
        const archive = await exportFileSystem(source.fs);
        archive.entries.find(entry => entry.node.path === '/bad.txt')!.bytes = '!invalid base64!';
        await expect(importFileSystem(target.fs, archive)).rejects.toThrow();
        expect(await target.fs.driver.readContent('/keep.txt', { encoding: 'utf-8' })).toBe('original');
        expect(await target.fs.driver.exists('/bad.txt')).toBe(false);
    });
});

describe('host startup ownership', () => {
    it('closes the root backend after partial initialization failure', async () => {
        const root = new MemoryBackend();
        vi.spyOn(root, 'mkdir').mockRejectedValue(new Error('bootstrap failed'));
        const close = vi.spyOn(root, 'close');
        await expect(createVFS({ rootBackend: root })).rejects.toThrow('bootstrap failed');
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('closes initialized and failing mount backends if startup cannot finish', async () => {
        const root = new MemoryBackend(), first = new MemoryBackend(), bad = new MemoryBackend();
        const closeRoot = vi.spyOn(root, 'close'), closeFirst = vi.spyOn(first, 'close'), closeBad = vi.spyOn(bad, 'close');
        vi.spyOn(bad, 'stat').mockRejectedValue(new Error('mount failed'));
        await expect(createVFS({ rootBackend: root, additionalMounts: [{ path: '/first', backend: first }, { path: '/bad', backend: bad }] })).rejects.toThrow('mount failed');
        expect(closeRoot).toHaveBeenCalledTimes(1);
        expect(closeFirst).toHaveBeenCalledTimes(1);
        expect(closeBad).toHaveBeenCalledTimes(1);
    });

    it('shares concurrent disposal and closes other backends even when one close fails', async () => {
        const root = new MemoryBackend(), extra = new MemoryBackend();
        const { manager } = await createVFS({ rootBackend: root, additionalMounts: [{ path: '/extra', backend: extra }] });
        const closeRoot = vi.spyOn(root, 'close').mockRejectedValue(new Error('close failed'));
        const closeExtra = vi.spyOn(extra, 'close');
        const first = manager.dispose(), second = manager.dispose();
        expect(first).toBe(second);
        await expect(first).rejects.toThrow('cleanup failed');
        expect(closeRoot).toHaveBeenCalledTimes(1);
        expect(closeExtra).toHaveBeenCalledTimes(1);
    });
});
