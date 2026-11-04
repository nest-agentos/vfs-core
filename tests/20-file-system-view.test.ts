import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVFS, createFileSystemSource, createFileSystemView, MemoryBackend, type FileSystemView } from '../src';
import { setupVFS } from './helpers';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function source() { const vfs = await setupVFS(); cleanup.push(vfs.dispose); return vfs.fs; }
function view(...args: Parameters<typeof createFileSystemView>): FileSystemView {
    const fs = createFileSystemView(...args); cleanup.push(() => fs.dispose()); return fs;
}

describe('independent file system views', () => {
    it('reports synthetic parents read-only while a mounted destination remains writable', async () => {
        const fs = await source();
        const app = view({ viewId: 'mixed', mounts: [{ mountId: 'work', at: '/nested/work', fs, access: 'rw' }] });
        expect((await app.capabilitiesAt('/')).readonly).toBe(true);
        expect((await app.capabilitiesAt('/nested')).readonly).toBe(true);
        expect((await app.capabilitiesAt('/nested/work')).readonly).toBe(false);
        await expect(app.driver.createFile({ name: 'blocked.md' })).rejects.toMatchObject({ code: 'EROFS' });
        await expect(app.driver.createFile({ parentPath: '/nested/work', name: 'allowed.md' })).resolves.toMatchObject({ name: 'allowed.md' });
    });
    it('disables tag reads and writes for external host sources', async () => {
        const backend = new MemoryBackend();
        await backend.init();
        await backend.write('/host.md', new Uint8Array());
        await backend.setTags('/host.md', ['legacy']);
        const owner = await createFileSystemSource({ backend, viewId: 'host' });
        cleanup.push(() => owner.dispose());
        expect(owner.fs.external).toBe(true);
        expect(owner.fs.capabilities.tags).toBe(false);
        expect((await owner.fs.capabilitiesAt('/host.md')).tags).toBe(false);
        expect((await owner.fs.driver.getNode('/host.md'))?.tags).toEqual([]);
        expect(await owner.fs.meta.tags.getAllTags()).toEqual([]);
        await expect(owner.fs.meta.tags.setTags('/host.md', ['new'])).rejects.toThrow();
    });
    it('queries the tag index of a whole-source view without traversing files', async () => {
        const fs = await source();
        await fs.driver.createFile({ name: 'tagged.md', content: 'test' });
        await fs.meta.tags.setTags('/tagged.md', ['work']);
        const app = view({ viewId: 'root', mounts: [{ mountId: 'root', at: '/', fs, access: 'ro' }] });
        const children = vi.spyOn(fs.driver, 'getChildren').mockRejectedValue(new Error('Must not scan'));
        expect(await app.meta.tags.getAllTags()).toContainEqual({ name: 'work', refCount: 1 });
        const paths: string[] = [];
        await app.meta.tags.walkByTag('work', path => { paths.push(path); return true; });
        expect(paths).toEqual(['/tagged.md']);
        expect(children).not.toHaveBeenCalled();
    });

    it('does not expose source-wide tags through a restricted subdirectory view', async () => {
        const fs = await source();
        await fs.driver.createDirectory({ name: 'visible' });
        await fs.driver.createFile({ name: 'secret.md', content: 'hidden' });
        await fs.meta.tags.setTags('/secret.md', ['secret']);
        const app = view({ viewId: 'restricted', mounts: [{ mountId: 'subdir', at: '/', root: '/visible', fs, access: 'ro' }] });
        expect(await app.meta.tags.getAllTags()).toEqual([]);
    });

    it('owns explicit directory views and revokes derived handles when the host closes', async () => {
        const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
        cleanup.push(() => manager.dispose());
        const [a, b] = await Promise.all([
            manager.openFileSystem('/home/admin'), manager.openFileSystem('/home//admin/'),
        ]);
        expect(a).toBe(b);
        await a.driver.createFile({ name: 'note.md', content: 'saved' });
        const app = view({ viewId: 'reader', mounts: [{ mountId: 'home', at: '/', fs: a, access: 'ro' }] });
        const file = app.openFile('/note.md');
        expect(new TextDecoder().decode(await file.read() as ArrayBuffer)).toBe('saved');
        await manager.dispose();
        await expect(file.read()).rejects.toMatchObject({ code: 'EACCES' });
        await expect(a.driver.exists('/note.md')).rejects.toMatchObject({ code: 'EACCES' });
        await expect(manager.openFileSystem('/')).rejects.toMatchObject({ code: 'EACCES' });
    });

    it('opens an independent backend without creating system directories in it', async () => {
        const backend = new MemoryBackend();
        const closeBackend = vi.spyOn(backend, 'close');
        const owner = await createFileSystemSource({ backend, viewId: 'host-project' });
        cleanup.push(() => owner.dispose());
        await owner.fs.driver.createFile({ name: 'report.md', parentPath: '/', content: 'report' });
        expect((await owner.fs.driver.getChildren('/')).map(n => n.name)).toEqual(['report.md']);
        for (const path of ['/etc', '/dev', '/module']) expect(await backend.stat(path)).toBeNull();
        const app = view({ viewId: 'app', mounts: [{ mountId: 'host', at: '/workspace', fs: owner.fs, access: 'ro' }] });
        expect(await app.driver.readContent('/workspace/report.md', { encoding: 'utf-8' })).toBe('report');
        await app.dispose();
        expect(await owner.fs.driver.exists('/report.md')).toBe(true);
        await owner.dispose();
        await owner.dispose();
        expect(closeBackend).toHaveBeenCalledTimes(1);
        await expect(owner.fs.driver.exists('/report.md')).rejects.toMatchObject({ code: 'EACCES' });
    });
    it('composes synthetic parents and keeps identical paths in separate views independent', async () => {
        const a = await source(), b = await source();
        await a.driver.createFile({ name: 'report.md', content: 'A' });
        await b.driver.createFile({ name: 'report.md', content: 'B' });
        const fs = view({ viewId: 'app', mounts: [
            { mountId: 'a', at: '/sessions/a', fs: a, access: 'rw' },
            { mountId: 'b', at: '/sessions/b', fs: b, access: 'ro' },
        ] });
        expect((await fs.driver.getChildren('/')).map(n => n.path)).toEqual(['/sessions']);
        expect((await fs.driver.getChildren('/sessions')).map(n => n.path)).toEqual(['/sessions/a', '/sessions/b']);
        expect(await fs.driver.readContent('/sessions/a/report.md', { encoding: 'utf-8' })).toBe('A');
        expect(await fs.driver.readContent('/sessions/b/report.md', { encoding: 'utf-8' })).toBe('B');
        await expect(fs.driver.writeContent('/sessions/b/report.md', 'bad')).rejects.toMatchObject({ code: 'EROFS' });
        await expect(fs.driver.readContent('/report.md')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('routes assets and SeqFiles to their owner source and blocks metadata writes on ro mounts', async () => {
        const a = await source(), b = await source();
        for (const fs of [a, b]) await fs.driver.createFile({ name: 'state.seq', type: 'seqfile' });
        const fs = view({ viewId: 'app', mounts: [
            { mountId: 'a', at: '/a', fs: a, access: 'rw' },
            { mountId: 'b', at: '/b', fs: b, access: 'ro' },
        ] });
        await fs.meta.seq!.setEntry('/a/state.seq', 'key', 'one');
        expect(await a.meta.seq!.getEntry('/state.seq', 'key')).toBe('one');
        expect(await b.meta.seq!.getEntry('/state.seq', 'key')).toBeNull();
        await fs.openFile('/a/state.seq').asset('note.txt').write('asset');
        expect(await fs.openFile('/a/state.seq').asset('note.txt').readText()).toBe('asset');
        await expect(fs.meta.seq!.setEntry('/b/state.seq', 'key', 'bad')).rejects.toMatchObject({ code: 'EROFS' });
        await expect(fs.openFile('/b/state.seq').asset('note.txt').write('bad')).rejects.toMatchObject({ code: 'EROFS' });
        await expect(fs.meta.tags.addTag('/b/state.seq', 'bad')).rejects.toMatchObject({ code: 'EROFS' });
    });

    it('invalidates existing file and asset handles without closing shared sources', async () => {
        const sourceFS = await source();
        await sourceFS.driver.createFile({ name: 'file.md', content: 'ok' });
        const fs = view({ viewId: 'app', mounts: [{ mountId: 'root', at: '/', fs: sourceFS, access: 'rw' }] });
        const file = fs.openFile('/file.md');
        await file.asset('x').write('x');
        expect(await file.asset('x').exists()).toBe(true);
        await fs.dispose();
        await expect(file.read()).rejects.toMatchObject({ code: 'EACCES' });
        await expect(file.asset('x').exists()).rejects.toMatchObject({ code: 'EACCES' });
        expect(await sourceFS.driver.exists('/file.md')).toBe(true);
    });

    it('preserves mount shadowing and forbids structural operations across mount boundaries', async () => {
        const a = await source(), b = await source();
        await a.driver.createDirectory({ name: 'ref' });
        await a.driver.createFile({ name: 'hidden.md', parentPath: '/ref', content: 'secret' });
        await b.driver.createFile({ name: 'visible.md' });
        const fs = view({ viewId: 'app', mounts: [
            { mountId: 'root', at: '/', fs: a, access: 'rw' },
            { mountId: 'ref', at: '/ref', fs: b, access: 'rw' },
        ] });
        expect((await fs.driver.getChildren('/ref')).map(n => n.name)).toEqual(['visible.md']);
        expect(await fs.driver.exists('/ref/hidden.md')).toBe(false);
        expect((await fs.driver.search({ name: { exact: 'hidden.md' } })).nodes).toEqual([]);
        await expect(fs.driver.delete(['/ref'], { recursive: true })).rejects.toMatchObject({ code: 'EBUSY' });
        await expect(fs.driver.move(['/ref/visible.md'], '/')).rejects.toMatchObject({ code: 'EXMOUNT' });
    });


    it('rejects traversal and subtree escape, including asset names', async () => {
        const sourceFS = await source();
        await sourceFS.driver.createDirectory({ name: 'allowed' });
        await sourceFS.driver.createFile({ name: 'file.md', parentPath: '/allowed' });
        const fs = view({ viewId: 'app', mounts: [{ mountId: 'root', at: '/', root: '/allowed', fs: sourceFS, access: 'rw' }] });
        await expect(fs.driver.readContent('/../file.md')).rejects.toMatchObject({ code: 'EINVAL' });
        await expect(fs.meta.assets.putAsset('/file.md', '../escape', 'bad')).rejects.toMatchObject({ code: 'EINVAL' });
        await expect(fs.driver.createFile({ name: '../escape' })).rejects.toMatchObject({ code: 'EINVAL' });
        expect(await sourceFS.driver.exists('/escape')).toBe(false);
    });

    it('updates file handle paths after rename/move and sees assets added through another handle', async () => {
        const fs = await source();
        await fs.driver.createFile({ name: 'a.md' });
        await fs.driver.createDirectory({ name: 'dir' });
        const first = fs.openFile('/a.md'), second = fs.openFile('/a.md');
        expect(await first.listAssets()).toEqual([]);
        await second.asset('x').write('x');
        expect(await first.asset('x').exists()).toBe(true);
        await first.rename('b.md');
        expect(first.path).toBe('/b.md');
        await first.move('/dir');
        expect(first.path).toBe('/dir/b.md');
        expect(await first.asset('x').readText()).toBe('x');
    });

    it('drains admitted operations and rejects new calls while closing', async () => {
        const sourceFS = await source();
        await sourceFS.driver.createFile({ name: 'a.md', parentPath: '/', content: 'a' });
        let entered!: () => void, finish!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const pending = new Promise<void>(resolve => { finish = resolve; });
        vi.spyOn(sourceFS.driver, 'readContent').mockImplementation(async () => { entered(); await pending; return 'a'; });
        const fs = view({ viewId: 'drain', mounts: [{ mountId: 'root', at: '/', fs: sourceFS, access: 'rw' }] });
        const read = fs.driver.readContent('/a.md');
        await started;
        let drained = false;
        const close = fs.dispose().then(() => { drained = true; });
        await expect(fs.driver.readContent('/a.md')).rejects.toMatchObject({ code: 'EACCES' });
        expect(drained).toBe(false);
        finish();
        expect(await read).toBe('a');
        await close;
        expect(drained).toBe(true);
    });

    it('searches only projected paths and globally orders mounted results', async () => {
        const a = await source(), b = await source();
        await a.driver.createFile({ name: 'z.md', parentPath: '/allowed', content: 'visible', recursive: true });
        await a.driver.createFile({ name: 'secret.md', parentPath: '/', content: 'secret' });
        await b.driver.createFile({ name: 'a.md', parentPath: '/', content: 'visible' });
        const providerSearch = vi.spyOn(a.driver, 'search');
        const fs = view({ viewId: 'search', mounts: [
            { mountId: 'a', at: '/a', root: '/allowed', fs: a, access: 'ro' },
            { mountId: 'b', at: '/b', fs: b, access: 'ro' },
        ] });
        const result = await fs.driver.search({ type: 'file', text: 'visible', orderBy: 'name', limit: 1 });
        expect(result.nodes.map(n => n.path)).toEqual(['/b/a.md']);
        expect(result.total).toBe(2);
        expect(result.hasMore).toBe(true);
        expect(providerSearch).not.toHaveBeenCalled();
    });

    it('rejects escaped transaction handles and assets outside an owner-only projection', async () => {
        const sourceFS = await source();
        await sourceFS.driver.createFile({ name: 'state.seq', parentPath: '/', type: 'seqfile' });
        const fs = view({ viewId: 'transaction', mounts: [{ mountId: 'root', at: '/', fs: sourceFS, access: 'rw' }] });
        let escaped: any;
        await fs.seqTransaction('/state.seq', async tx => { escaped = tx; await tx.setEntry('/state.seq', 'a', 'ok'); });
        await expect(escaped.setEntry('/state.seq', 'a', 'bad')).rejects.toMatchObject({ code: 'EACCES' });
        await sourceFS.meta.assets.putAsset('/state.seq', 'secret', 'secret');
        const restricted = view({ viewId: 'projection', readablePaths: ['/state.seq'], mounts: [{ mountId: 'root', at: '/', fs: sourceFS, access: 'ro' }] });
        await expect(restricted.meta.assets.getAsset('/state.seq', 'secret')).rejects.toMatchObject({ code: 'EACCES' });
    });
});

describe('view error causes', () => {
    it('keeps the provider error as cause so read-only failures stay diagnosable', async () => {
        const fs = await source();
        await fs.driver.createFile({ name: 'note.md', content: 'x' });
        // Nested views mirror the real chain: session-browser view → session files view.
        const inner = view({ viewId: 'inner', mounts: [{ mountId: 'root', at: '/', fs, access: 'ro' }] });
        const app = view({ viewId: 'outer', mounts: [{ mountId: 'root', at: '/', fs: inner, access: 'rw' }] });

        const failure = await app.driver.delete(['/note.md']).catch(error => error as { code?: string; cause?: { code?: string; message?: string } });

        expect(failure.code).toBe('EROFS');
        expect(failure.cause?.code).toBe('EROFS');
        expect(failure.cause?.message).toContain('Read-only mount');
    });
});
