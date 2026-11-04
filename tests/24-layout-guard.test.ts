import { expect, it, vi } from 'vitest';
import { createVFS, FSError, MemoryBackend } from '../src';

it('keeps ancestor pins and propagates delegated subtree guard failures', async () => {
    const guard = vi.fn(async (_path: string) => {});
    const backend = Object.assign(new MemoryBackend(), { assertMutableSubtree: guard });
    const { manager } = await createVFS({ rootBackend: backend });
    try {
        const fs = await manager.openFileSystem('/');
        await fs.driver.createFile({ parentPath: '/data/guarded', name: 'note', content: 'keep', recursive: true });
        await fs.driver.updateMetadata('/data/guarded', { vfsFixedLayout: true });
        await expect(fs.driver.delete(['/data/guarded/note'])).rejects.toMatchObject({ code: 'EBUSY' });
        expect(guard).not.toHaveBeenCalled();
        await fs.driver.updateMetadata('/data/guarded', { vfsFixedLayout: false });
        guard.mockRejectedValue(new FSError('EBUSY', 'Delegated storage is pinned'));
        await expect(fs.driver.delete(['/data/guarded/note'])).rejects.toMatchObject({ code: 'EBUSY' });
        expect(await fs.driver.exists('/data/guarded/note')).toBe(true);
        expect(guard).toHaveBeenCalledWith('/data/guarded/note');
    } finally { await manager.dispose(); }
});

it('does not delegate across nested mounts and retains the recursive layout guard', async () => {
    const guard = vi.fn(async (_path: string) => {});
    const backend = Object.assign(new MemoryBackend(), { assertMutableSubtree: guard });
    const nested = new MemoryBackend();
    const { manager } = await createVFS({ rootBackend: backend });
    try {
        const fs = await manager.openFileSystem('/');
        await fs.driver.createDirectory({ parentPath: '/data', name: 'parent', recursive: true });
        await fs.driver.createDirectory({ parentPath: '/data/parent', name: 'nested' });
        await manager.mounts.mountBackend('/data/parent/nested', nested);
        await nested.updateMetadata('/', { vfsFixedLayout: true });
        await expect(fs.driver.delete(['/data/parent'], { recursive: true })).rejects.toMatchObject({ code: 'EBUSY' });
        expect(guard).not.toHaveBeenCalled();
        expect(await fs.driver.exists('/data/parent')).toBe(true);
    } finally { await manager.dispose(); }
});
