import { describe, it, expect } from 'vitest';
import { createFileSystemSource, createFileSystemView, FileStorageAdapter, FSError,
    FSOperationCancelledError, checkOperation, type FileStorageBackend } from '../src';

function source(read: FileStorageBackend['files']['read']) {
    return createFileSystemSource({ backend: new FileStorageAdapter({
        name: 'remote', init: async () => {}, close: async () => {},
        files: { stat: async path => ({ kind: path ? 'file' : 'directory' }),
            list: async () => ({ entries: [], nextCursor: null }), read },
    }), viewId: 'remote', access: 'ro' });
}

describe('operation lifetime', () => {
    it('does not start an already cancelled read', async () => {
        let calls = 0;
        const owner = await source(async () => { calls++; return { data: new Uint8Array() }; });
        const controller = new AbortController(); controller.abort();
        await expect(owner.fs.driver.readContent('/file', { signal: controller.signal })).rejects.toMatchObject({ code: 'ECANCELLED' });
        expect(calls).toBe(0); await owner.dispose();
    });

    it('cancels a nested view without closing its shared source', async () => {
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        const owner = await source(async (_path, options) => {
            checkOperation(options); started();
            await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort',
                () => reject(new FSOperationCancelledError()), { once: true }));
            return { data: new Uint8Array() };
        });
        const view = createFileSystemView({ viewId: 'child', mounts: [{ mountId: 'r', at: '/remote', fs: owner.fs, access: 'ro' }] });
        const reading = expect(view.driver.readContent('/remote/file')).rejects.toMatchObject({ code: 'ECANCELLED' });
        await ready; await view.dispose(); await reading;
        expect(await owner.fs.driver.getNode('/file')).not.toBeNull(); await owner.dispose();
    });

    it('preserves timeout and source errors instead of returning missing', async () => {
        const owner = await source(async (_path, options) => {
            await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort',
                () => { try { checkOperation(options); } catch (e) { reject(e); } }, { once: true }));
            return { data: new Uint8Array() };
        });
        await expect(owner.fs.driver.readContent('/file', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
        await owner.dispose();
        const broken = await source(async () => { throw new FSError('EACCES', 'Denied'); });
        await expect(broken.fs.driver.readContent('/file')).rejects.toMatchObject({ code: 'EACCES' });
        expect(broken.fs.capabilities.tags).toBe(false); expect(broken.fs.capabilities.readonly).toBe(true);
        await broken.dispose();
    });
});
