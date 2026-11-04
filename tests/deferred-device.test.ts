import { describe, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, type IDeviceDriver } from '../src';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe('deferred device namespace', () => {
    it('keeps ordinary reads available, shares preparation, and waits before path lookup', async () => {
        const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
        const gate = deferred();
        const ready = vi.fn(async () => {
            await gate.promise;
            await manager.createDeviceNode('lazy', '/dev/lazy');
        });
        const driver: IDeviceDriver = { handlerId: 'lazy', writable: false, ready, read: async () => 'ready' };
        manager.devices.register(driver);
        const first = manager.openDevice('/dev/lazy'), second = manager.openDevice('/dev/lazy');
        try {
            const root = await manager.openFileSystem('/');
            expect(await root.driver.getNode('/etc')).not.toBeNull();
            let settled = false; void first.then(() => { settled = true; });
            await Promise.resolve(); expect(settled).toBe(false);
            gate.resolve();
            expect(await (await first).read()).toBe('ready');
            expect(await (await second).read()).toBe('ready');
            expect(ready).toHaveBeenCalledOnce();
        } finally { gate.resolve(); await manager.dispose(); }
    });
    it('propagates initialization failure instead of reporting a missing device', async () => {
        const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
        const failure = new Error('configuration unavailable');
        manager.devices.register({ handlerId: 'lazy', writable: false, read: async () => '', ready: async () => { throw failure; } });
        try { await expect(manager.openDevice('/dev/lazy')).rejects.toBe(failure); }
        finally { await manager.dispose(); }
    });
    it('drains preparation and refuses new initialization while disposing', async () => {
        const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
        const gate = deferred();
        const ready = vi.fn(() => gate.promise);
        const dispose = vi.fn(async () => {});
        manager.devices.register({ handlerId: 'lazy', writable: false, read: async () => '', ready, dispose });
        const pending = manager.devices.ready('/dev/lazy');
        await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
        const closing = manager.devices.disposeAll();
        expect(manager.devices.disposeAll()).toBe(closing);
        await expect(manager.devices.ready('/dev/lazy')).rejects.toThrow();
        expect(dispose).not.toHaveBeenCalled();
        gate.resolve(); await pending; await closing;
        expect(dispose).toHaveBeenCalledOnce();
        await manager.dispose();
    });

});
