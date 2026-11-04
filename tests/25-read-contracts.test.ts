import { expect, it, vi } from 'vitest';
import { createFileSystemView, MemoryBackend } from '../src';
import { setupVFS } from './helpers';

it('separates physical bytes from record projections without relying on filename extensions', async () => {
    const vfs = await setupVFS();
    try {
        await vfs.fs.driver.createFile({ name: 'data.json', content: '{"source":"file"}' });
        await vfs.fs.meta.seq!.setEntry('/data.json', 'key', 'value');
        const read = (representation: 'auto' | 'bytes' | 'records') => vfs.fs.driver.readContent('/data.json', { representation, encoding: 'utf-8' });
        expect(await read('auto')).toBe('key=value');
        expect(await read('records')).toBe('key=value');
        expect(await read('bytes')).toBe('{"source":"file"}');
        await vfs.fs.meta.seq!.deleteEntry('/data.json', 'key');
        expect(await read('records')).toBe('');
        expect(await read('auto')).toBe('{"source":"file"}');
        await expect(vfs.fs.driver.readContent('/', { representation: 'records' })).rejects.toMatchObject({ code: 'EISDIR' });
    } finally { await vfs.dispose(); }
});

it.each(['EACCES', 'ENOENT', 'EIO'])('propagates %s read failures instead of returning an empty file', async code => {
    const backend = new MemoryBackend(), vfs = await setupVFS(backend);
    try {
        await vfs.fs.driver.createFile({ name: 'data', content: '' });
        const cause = Object.assign(new Error('read failed'), { code });
        vi.spyOn(backend, 'read').mockRejectedValue(cause);
        await expect(vfs.fs.driver.readContent('/data', { representation: 'bytes' })).rejects.toMatchObject({ code, cause: { cause } });
        await expect(vfs.manager.readBySystemPath('/data/test/data')).rejects.toMatchObject({ code, cause });
    } finally { await vfs.dispose(); }
});

it('returns only the requested Uint8Array view, including for system reads', async () => {
    const backend = new MemoryBackend(), vfs = await setupVFS(backend);
    try {
        await vfs.fs.driver.createFile({ name: 'data' });
        vi.spyOn(backend, 'read').mockResolvedValue(new TextEncoder().encode('secretOKsecret').subarray(6, 8));
        expect(await vfs.fs.driver.readContent('/data', { representation: 'bytes', encoding: 'utf-8' })).toBe('OK');
        expect(await vfs.manager.readBySystemPath('/data/test/data')).toBe('OK');
    } finally { await vfs.dispose(); }
});

it('preserves nested mount ownership, hidden filtering and entry shape with a legacy list backend', async () => {
    const vfs = await setupVFS();
    await vfs.fs.driver.createFile({ name: 'visible', content: 'x' });
    await vfs.fs.driver.createFile({ name: '.hidden' });
    const view = createFileSystemView({ viewId: 'list', mounts: [
        { mountId: 'root', at: '/', root: '/', fs: vfs.fs, access: 'ro' },
        { mountId: 'nested', at: '/virtual/nested', root: '/', fs: vfs.fs, access: 'ro' },
    ] });
    try {
        const entries = await view.driver.getChildren('/', { fields: 'entry' });
        expect(entries.map(entry => entry.name).sort()).toEqual(['virtual', 'visible']);
        expect(entries.every(entry => !('metadata' in entry) && !('tags' in entry))).toBe(true);
        expect((await view.driver.getChildren('/virtual/nested', { fields: 'entry', includeHidden: true })).map(entry => entry.path))
            .toEqual(expect.arrayContaining(['/virtual/nested/.hidden', '/virtual/nested/visible']));
    } finally { await view.dispose(); await vfs.dispose(); }
});
