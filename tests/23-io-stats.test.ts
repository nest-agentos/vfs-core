import { describe, expect, it, vi } from 'vitest';
import { createVFS, createFileSystemView, MemoryBackend } from '../src';
import { IO_OPERATIONS } from '../src/protocol';
import { freshMem, setupVFS } from './helpers';

describe('VFS IO statistics', () => {
    it('checks shared path prefixes once for a batch of SeqFile reads', async () => {
        const backend = new MemoryBackend();
        const { manager } = await createVFS({ rootBackend: backend });
        const base = await manager.openFileSystem('/');
        const typeProbe = vi.spyOn(base.driver, 'getNodeType');
        const view = createFileSystemView({ viewId: 'batch-prefixes', mounts: [
            { mountId: 'root', at: '/', root: '/', fs: base, access: 'ro' },
        ] });
        try {
            await base.driver.createFile({ name: 'one.seq', parentPath: '/folder', type: 'seqfile', recursive: true });
            await base.driver.createFile({ name: 'two.seq', parentPath: '/folder', type: 'seqfile' });
            await base.meta.seq!.setEntry('/folder/one.seq', 'state', 'one');
            await base.meta.seq!.setEntry('/folder/two.seq', 'state', 'two');
            typeProbe.mockClear();
            expect(await view.meta.seq!.getEntriesMany([
                { fileIdOrPath: '/folder/one.seq', key: 'state' },
                { fileIdOrPath: '/folder/two.seq', key: 'state' },
                { fileIdOrPath: '/folder/one.seq', key: 'missing' },
            ])).toEqual(['one', 'two', null]);
            expect(typeProbe.mock.calls.filter(([path]) => path === '/folder')).toHaveLength(1);
            expect(typeProbe.mock.calls.filter(([path]) => path === '/folder/one.seq')).toHaveLength(1);
            expect(typeProbe.mock.calls.filter(([path]) => path === '/folder/two.seq')).toHaveLength(1);
        } finally { await view.dispose(); await manager.dispose(); }
    });

    it('uses type-only probes through nested views without caching existence or losing virtual parents', async () => {
        const backend = new MemoryBackend(), stat = backend.stat.bind(backend);
        const statType = async (path: string) => { const node = await stat(path); return node ? { type: node.type } : null; };
        const vfs = await setupVFS(Object.assign(backend, { statType }));
        const view = createFileSystemView({ viewId: 'probe', mounts: [
            { mountId: 'root', at: '/', root: '/', fs: vfs.fs, access: 'ro' },
            { mountId: 'nested', at: '/virtual/nested', root: '/', fs: vfs.fs, access: 'ro' },
        ] });
        try {
            await vfs.fs.driver.createFile({ name: 'note.txt', content: 'hello' });
            const fullStat = vi.spyOn(backend, 'stat');
            expect(await view.driver.exists('/note.txt')).toBe(true);
            expect(await view.driver.resolvePath('/note.txt')).toBe('/note.txt');
            expect(await view.driver.readContent('/note.txt', { encoding: 'utf-8' })).toBe('hello');
            expect(await view.driver.exists('/virtual')).toBe(true);
            expect(await view.driver.getNodeType!('/virtual')).toEqual({ type: 'directory' });
            expect(fullStat).not.toHaveBeenCalled();
            await backend.delete('/data/test/note.txt');
            expect(await view.driver.exists('/note.txt')).toBe(false);
            expect(await view.driver.resolvePath('/note.txt')).toBeNull();
            await expect(view.driver.readContent('/note.txt')).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(view.driver.exists('/../escape')).rejects.toMatchObject({ code: 'EINVAL' });
        } finally { await view.dispose(); await vfs.dispose(); }
    });
    it('checks directory prefixes through type-only IO while still rejecting non-directory ancestors', async () => {
        const backend = new MemoryBackend(), stat = backend.stat.bind(backend);
        const statType = vi.fn(async (path: string) => {
            const node = await stat(path); return node ? { type: node.type } : null;
        });
        const { manager } = await createVFS({ rootBackend: Object.assign(backend, { statType }) });
        try {
            await backend.mkdir('/data/startup/deep');
            const fullStat = vi.spyOn(backend, 'stat');
            statType.mockClear();
            await manager.openFileSystem('/data/startup/deep');
            expect(statType.mock.calls.map(([path]) => path)).toEqual(['/data', '/data/startup', '/data/startup/deep']);
            expect(fullStat.mock.calls.some(([path]) => path === '/data' || path === '/data/startup')).toBe(false);
            await backend.delete('/data/startup', { recursive: true });
            await backend.write('/data/startup', new Uint8Array());
            await expect(manager.openFileSystem('/data/startup/blocked')).rejects.toMatchObject({ code: 'ENOTDIR' });
        } finally { await manager.dispose(); }
    });
    it('checks a target once at the backend through deeply nested views', async () => {
        const backend = new MemoryBackend(), stat = backend.stat.bind(backend);
        const statType = vi.fn(async (path: string) => {
            const node = await stat(path); return node ? { type: node.type } : null;
        });
        const { manager } = await createVFS({ rootBackend: Object.assign(backend, { statType }) });
        const views = [], base = await manager.openFileSystem('/');
        let current = base;
        try {
            await base.driver.createFile({ name: 'AGENT.md', parentPath: '/_agent', recursive: true });
            for (let depth = 0; depth < 4; depth++) {
                current = createFileSystemView({ viewId: `nested-${depth}`, mounts: [
                    { mountId: 'source', at: '/', root: '/', fs: current, access: 'ro' },
                ] });
                views.push(current);
            }
            statType.mockClear();
            expect(await current.driver.getNodeType!('/_agent/AGENT.md')).toEqual({ type: 'file' });
            expect(statType.mock.calls.filter(([path]) => path === '/_agent/AGENT.md')).toHaveLength(1);
            statType.mockClear();
            expect(await current.driver.getNodeType!('/_agent/missing.md')).toBeNull();
            expect(statType.mock.calls.filter(([path]) => path === '/_agent/missing.md')).toHaveLength(1);
            statType.mockClear();
            expect(await current.driver.getNodeType!('/')).toEqual({ type: 'directory' });
            expect(statType).toHaveBeenCalledTimes(1);
        } finally {
            for (const view of views.reverse()) await view.dispose();
            await manager.dispose();
        }
    });
    it('exposes a public snapshot of backend operations and resets on demand', async () => {
        const vfs = await setupVFS(freshMem());
        try {
            // Hosts previously reached into the engine (`(vfs as any)._engine.ioStats`)
            // to attribute redundant work; this is the supported entry point.
            expect(Object.keys(vfs.manager.ioStats).sort()).toEqual([...IO_OPERATIONS].sort());

            await vfs.fs.driver.createFile({ name: 'note.md', parentPath: '/', content: 'hello' });
            await vfs.fs.driver.readContent('/note.md', { encoding: 'utf-8' });
            expect(vfs.manager.ioStats.write).toBeGreaterThan(0);
            expect(vfs.manager.ioStats.stat).toBeGreaterThan(0);

            const snapshot = vfs.manager.ioStats;
            (snapshot as Record<string, number>).stat = 0;
            expect(vfs.manager.ioStats.stat).toBeGreaterThan(0);

            vfs.manager.resetIOStats();
            expect(vfs.manager.ioStats).toMatchObject({ stat: 0, list: 0, read: 0, write: 0 });
        } finally {
            await vfs.dispose();
        }
    });
});
