import { afterEach, expect, it, vi } from 'vitest';
import { createFileSystemSource, createFileSystemView, MemoryBackend, transferFileSystemEntry } from '../src';
const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); });
async function setup() {
    const owner = await createFileSystemSource({ backend: new MemoryBackend(), viewId: 'transfer-test', internal: true });
    close.push(() => owner.dispose()); return owner.fs;
}
it('copies a directory between stores with records, binary assets and tags, then moves another file', async () => {
    const from = await setup(), to = await setup();
    await from.driver.createFile({ name: 'note.md', parentPath: '/notes', content: 'hello', recursive: true, tags: ['tag'] });
    await from.meta.seq!.setEntry('/notes/note.md', 'message', 'record');
    await from.meta.tags.setTags('/notes/note.md', ['tag']);
    await from.meta.assets.putAsset('/notes/note.md', 'image.bin', new Uint8Array([0, 255, 42]).buffer);
    await transferFileSystemEntry(from, '/notes', to, '/');
    expect(await to.driver.readContent('/notes/note.md', { encoding: 'utf-8' })).toBe(await from.driver.readContent('/notes/note.md', { encoding: 'utf-8' }));
    expect(await to.meta.seq!.getEntry('/notes/note.md', 'message')).toBe('record');
    expect((await to.driver.getNode('/notes/note.md'))?.tags).toEqual(['tag']);
    expect(new Uint8Array(await to.meta.assets.getAsset('/notes/note.md', 'image.bin') as ArrayBuffer)).toEqual(new Uint8Array([0, 255, 42]));
    expect(await from.driver.exists('/notes')).toBe(true);
    await from.driver.createFile({ name: 'move.md', parentPath: '/', content: 'move' });
    await transferFileSystemEntry(from, '/move.md', to, '/', { move: true });
    expect(await from.driver.exists('/move.md')).toBe(false);
    expect(await to.driver.readContent('/move.md', { encoding: 'utf-8' })).toBe('move');
});
it('allows copying a readable readonly source and rejects moving it or writing to a readonly target', async () => {
    const source = await setup(), target = await setup();
    await source.driver.createFile({ name: 'a.md', parentPath: '/', content: 'a' });
    const ro = createFileSystemView({ viewId: 'readonly', mounts: [{ mountId: 'source', at: '/', fs: source, access: 'ro' }] });
    close.push(() => ro.dispose());
    await transferFileSystemEntry(ro, '/a.md', target, '/');
    await expect(transferFileSystemEntry(ro, '/a.md', target, '/', { move: true, newName: 'moved.md' })).rejects.toMatchObject({ code: 'EROFS' });
    await expect(transferFileSystemEntry(source, '/a.md', ro, '/', { newName: 'copy.md' })).rejects.toMatchObject({ code: 'EROFS' });
    expect(await source.driver.exists('/a.md')).toBe(true);
});
it('keeps both existing files on collision and preserves the source if destination writing fails', async () => {
    const source = await setup(), target = await setup();
    await source.driver.createFile({ name: 'a.md', parentPath: '/', content: 'source' });
    await target.driver.createFile({ name: 'a.md', parentPath: '/', content: 'target' });
    await expect(transferFileSystemEntry(source, '/a.md', target, '/', { move: true })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await target.driver.readContent('/a.md', { encoding: 'utf-8' })).toBe('target');
    vi.spyOn(target.driver, 'createFile').mockRejectedValue(new Error('disk full'));
    await expect(transferFileSystemEntry(source, '/a.md', target, '/', { move: true, newName: 'b.md' })).rejects.toThrow('disk full');
    expect(await source.driver.readContent('/a.md', { encoding: 'utf-8' })).toBe('source');
});
it('retains a source edited during transfer and rejects copying a directory into itself', async () => {
    const source = await setup(), target = await setup();
    await source.driver.createFile({ name: 'a.md', parentPath: '/notes', content: 'old', recursive: true });
    await expect(transferFileSystemEntry(source, '/notes', source, '/notes')).rejects.toMatchObject({ code: 'EINVAL' });
    const create = target.driver.createFile.bind(target.driver);
    vi.spyOn(target.driver, 'createFile').mockImplementation(async options => {
        const result = await create(options); await source.driver.writeContent('/notes/a.md', 'new'); return result;
    });
    await expect(transferFileSystemEntry(source, '/notes/a.md', target, '/', { move: true })).rejects.toMatchObject({ code: 'ECONFLICT' });
    expect(await source.driver.readContent('/notes/a.md', { encoding: 'utf-8' })).toBe('new');
});
