/**
 * Event emission: node:created, node:updated, node:deleted,
 * node:renamed, node:moved, node:copied, onAny.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupVFS, type TestVFS } from './helpers';
import type { FSEvent } from '@itookit/vfs-core';

describe('Event emission (IndexedDB backend)', () => {
    let vfs: TestVFS;
    beforeEach(async () => { vfs = await setupVFS(); });
    afterEach(async () => { await vfs.dispose(); });

    function capture<T>(subscribe: (cb: (e: T) => void) => () => void) {
        const events: T[] = [];
        const unsub = subscribe((e) => events.push(e));
        return { events, unsub };
    }

    it('createFile emits node:created', async () => {
        const { fs } = vfs;
        const { events, unsub } = capture<FSEvent<'node:created'>>(cb => fs.on('node:created', cb));
        await fs.driver.createFile({ name: 'ev.txt', parentPath: null, content: '' });
        unsub();
        expect(events).toHaveLength(1);
        expect(events[0].payload.nodes[0].path).toBe('/ev.txt');
    });

    it('writeContent emits node:updated with reason content', async () => {
        const { fs } = vfs;
        await fs.driver.createFile({ name: 'wr.txt', parentPath: null, content: 'x' });
        const { events, unsub } = capture<FSEvent<'node:updated'>>(cb => fs.on('node:updated', cb));
        await fs.driver.writeContent('/wr.txt', 'updated');
        unsub();
        expect(events).toHaveLength(1);
        expect(events[0].payload.reason).toBe('content');
    });

    it('updateMetadata emits node:updated with reason metadata', async () => {
        const { fs } = vfs;
        await fs.driver.createFile({ name: 'um.txt', parentPath: null, content: '' });
        const { events, unsub } = capture<FSEvent<'node:updated'>>(cb => fs.on('node:updated', cb));
        await fs.driver.updateMetadata('/um.txt', { key: 'val' });
        unsub();
        expect(events.some(e => e.payload.reason === 'metadata')).toBe(true);
    });

    it('delete emits node:deleted', async () => {
        const { fs } = vfs;
        await fs.driver.createFile({ name: 'dl.txt', parentPath: null, content: '' });
        const { events, unsub } = capture<FSEvent<'node:deleted'>>(cb => fs.on('node:deleted', cb));
        await fs.driver.delete(['/dl.txt']);
        unsub();
        expect(events).toHaveLength(1);
        expect(events[0].payload.requestedPaths).toHaveLength(1);
    });

    it('rename emits node:renamed', async () => {
        const { fs } = vfs;
        await fs.driver.createFile({ name: 'before.txt', parentPath: null, content: '' });
        const { events, unsub } = capture<FSEvent<'node:renamed'>>(cb => fs.on('node:renamed', cb));
        await fs.driver.rename('/before.txt', 'after.txt');
        unsub();
        expect(events).toHaveLength(1);
        expect(events[0].payload.nodes[0].newName).toBe('after.txt');
        expect(events[0].payload.nodes[0].oldName).toBe('before.txt');
    });

    it('move emits node:moved', async () => {
        const { fs } = vfs;
        await fs.driver.createDirectory({ name: 'mvd', parentPath: null });
        await fs.driver.createFile({ name: 'mov.txt', parentPath: null, content: '' });
        const { events, unsub } = capture<FSEvent<'node:moved'>>(cb => fs.on('node:moved', cb));
        await fs.driver.move(['/mov.txt'], '/mvd');
        unsub();
        expect(events).toHaveLength(1);
    });

    it('copy emits node:copied', async () => {
        const { fs } = vfs;
        await fs.driver.createFile({ name: 'orig.txt', parentPath: null, content: '' });
        const { events, unsub } = capture<FSEvent<'node:copied'>>(cb => fs.on('node:copied', cb));
        await fs.driver.copy!('/orig.txt', null, 'cp.txt');
        unsub();
        expect(events).toHaveLength(1);
        expect(events[0].payload.copies[0].targetPath).toBe('/cp.txt');
    });

    it('onAny receives all event types', async () => {
        const { fs } = vfs;
        const types: string[] = [];
        const unsub = fs.onAny!((e) => types.push(e.type));
        await fs.driver.createFile({ name: 'any.txt', parentPath: null, content: '' });
        await fs.driver.writeContent('/any.txt', 'changed');
        await fs.driver.delete(['/any.txt']);
        unsub();
        expect(types).toContain('node:created');
        expect(types).toContain('node:updated');
        expect(types).toContain('node:deleted');
    });

    it('unsubscribe stops receiving events', async () => {
        const { fs } = vfs;
        const events: unknown[] = [];
        const unsub = fs.on('node:created', (e) => events.push(e));
        await fs.driver.createFile({ name: 'sub1.txt', parentPath: null, content: '' });
        unsub();
        await fs.driver.createFile({ name: 'sub2.txt', parentPath: null, content: '' });
        expect(events).toHaveLength(1);
    });

    it('addTag emits node:updated with reason tags', async () => {
        const { fs } = vfs;
        await fs.driver.createFile({ name: 'tg.txt', parentPath: null, content: '' });
        const { events, unsub } = capture<FSEvent<'node:updated'>>(cb => fs.on('node:updated', cb));
        await fs.meta.tags!.addTag('/tg.txt', 'tagged');
        unsub();
        expect(events.some(e => e.payload.reason === 'tags')).toBe(true);
    });

    it('view identity is set on events', async () => {
        const { fs } = vfs;
        const { events, unsub } = capture<FSEvent<'node:created'>>(cb => fs.on('node:created', cb));
        await fs.driver.createFile({ name: 'mid.txt', parentPath: null, content: '' });
        unsub();
        expect(events[0].viewId).toBe(fs.viewId);
        expect(events[0].revision).toBe(fs.revision);
    });
});
