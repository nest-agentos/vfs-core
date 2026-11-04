/**
 * Regression tests for review fixes:
 *  - device node materialization + openDevice/ioctl
 *  - optimistic concurrency (expectedVersion) + version counter
 *  - partial read / partial write (offset/length)
 *  - IFile.move/delete with a companion assetdir (no double-handling throw)
 *  - VFSManager node:* event forwarding from engine.events
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupVFS, readText, type TestVFS } from './helpers';
import { type IDeviceDriver } from '@itookit/vfs-core';

describe('Regression fixes', () => {
    let vfs: TestVFS;
    beforeEach(async () => { vfs = await setupVFS(); });
    afterEach(async () => { await vfs.dispose(); });

    describe('device nodes', () => {
        it('materializes a device node with deviceHandlerId', async () => {
            const driver: IDeviceDriver = {
                handlerId: 'testdev',
                writable: true,
                async read() { return 'hello'; },
                async write() {},
            };
            await vfs.manager.registerDevice(driver);

            const dev = await vfs.manager.openFileSystem('/dev');
            const node = (await dev.driver.getChildren('/')).find(node => node.name === 'testdev');
            expect(node?.type).toBe('device');
            expect((node as { deviceHandlerId?: string }).deviceHandlerId).toBe('testdev');
        });

        it('openDevice returns a working handle and ioctl routes to the driver', async () => {
            const driver: IDeviceDriver = {
                handlerId: 'testdev2',
                writable: true,
                async read(ctx) { return 'ctx-' + (ctx.sessionId ?? 'none'); },
                async write() {},
                async ioctl(_ctx, cmd, arg) { return { cmd, arg }; },
            };
            await vfs.manager.registerDevice(driver);

            const handle = await vfs.manager.openDevice('/dev/testdev2');
            expect(await handle.read()).toBe('ctx-none');
            expect(await handle.ioctl('ping', 42)).toEqual({ cmd: 'ping', arg: 42 });
        });
    });

    describe('optimistic concurrency', () => {
        it('writeContent honors expectedVersion and bumps version', async () => {
            const node = await vfs.fs.driver.createFile({ name: 'ver.txt', parentPath: null, content: 'v1' });
            expect(node.version).toBe(1);

            await vfs.fs.driver.writeContent('/ver.txt', 'v2', { expectedVersion: 1 });
            expect((await vfs.fs.driver.getNode('/ver.txt'))?.version).toBe(2);

            await expect(
                vfs.fs.driver.writeContent('/ver.txt', 'v3', { expectedVersion: 1 }),
            ).rejects.toMatchObject({ code: 'ECONFLICT' });
        });
    });

    describe('partial read / write', () => {
        it('readContent honors offset/length', async () => {
            await vfs.fs.driver.createFile({ name: 'p.bin', parentPath: null, content: 'ABCDEFGH' });
            const part = await vfs.fs.driver.readContent('/p.bin', { encoding: 'utf-8', offset: 2, length: 3 });
            expect(part).toBe('CDE');
        });

        it('writeContent with offset splices bytes', async () => {
            await vfs.fs.driver.createFile({ name: 'pw.bin', parentPath: null, content: 'ABCDEFGH' });
            await vfs.fs.driver.writeContent('/pw.bin', 'XY', { offset: 3 });
            expect(await readText(vfs.fs, '/pw.bin')).toBe('ABCXYFGH');
        });
    });

    describe('IFile lifecycle with assetdir', () => {
        it('move does not throw when a companion assetdir exists', async () => {
            await vfs.fs.driver.createFile({ name: 'm.md', parentPath: null, content: '# m' });
            await vfs.fs.meta.assets.putAsset('/m.md', 'a.txt', 'data');
            await vfs.fs.driver.createDirectory({ name: 'sub', parentPath: null });

            const handle = vfs.fs.openFile('/m.md');
            await handle.move('/sub');

            expect(await vfs.fs.driver.exists('/sub/m.md')).toBe(true);
            expect(await vfs.fs.meta.assets.getAsset('/sub/m.md', 'a.txt')).toBeTruthy();
        });

        it('delete does not throw when a companion assetdir exists', async () => {
            await vfs.fs.driver.createFile({ name: 'd.md', parentPath: null, content: '# d' });
            await vfs.fs.meta.assets.putAsset('/d.md', 'a.txt', 'data');

            const handle = vfs.fs.openFile('/d.md');
            await handle.delete();

            expect(await vfs.fs.driver.exists('/d.md')).toBe(false);
        });
    });

    describe('File view event forwarding', () => {
        it('forwards node:created/updated/deleted to the owning view', async () => {
            const seen: string[] = [];
            const off = vfs.fs.on('node:created', () => seen.push('created'));
            const off2 = vfs.fs.on('node:updated', () => seen.push('updated'));
            const off3 = vfs.fs.on('node:deleted', () => seen.push('deleted'));

            const node = await vfs.fs.driver.createFile({ name: 'evt.txt', parentPath: null, content: 'x' });
            await vfs.fs.driver.writeContent(node.path, 'y');
            await vfs.fs.driver.delete([node.path]);

            off(); off2(); off3();

            expect(seen).toContain('created');
            expect(seen).toContain('updated');
            expect(seen).toContain('deleted');
        });
    });
});
