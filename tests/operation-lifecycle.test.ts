import { describe, it, expect } from 'vitest';
import { createFileSystemView } from '../src';
import { setupVFS } from './helpers';
import type { FSEvent } from '../src/protocol';

describe('operation lifecycle', () => {
    it('finishes content only after close and pending writes, once per handle', async () => {
        const vfs = await setupVFS();
        try {
            await vfs.fs.driver.createFile({ name: 'file', content: '' });
            const events: FSEvent[] = [];
            const off = vfs.fs.onAny!(event => events.push(event));
            const file = vfs.fs.openFile('/file');
            const writing = file.write('updated');
            const closing = file.close!();
            expect(events.some(e => e.type === 'content:finished')).toBe(false);
            await Promise.all([writing, closing, file.close!()]);
            expect(events.filter(e => e.type === 'content:started')).toHaveLength(1);
            expect(events.filter(e => e.type === 'content:finished')).toHaveLength(1);
            expect(events.findIndex(e => e.type === 'content:finished')).toBeGreaterThan(events.findIndex(e => e.type === 'node:updated'));
            await expect(file.write('late')).rejects.toThrow('closed');
            off();
        } finally { await vfs.dispose(); }
    });

    it('reports failed content on close through a composed view', async () => {
        const vfs = await setupVFS();
        const view = createFileSystemView({ viewId: 'composed', mounts: [
            { mountId: 'source', at: '/work', fs: vfs.fs, access: 'rw' },
        ] });
        try {
            const events: FSEvent<'content:finished'>[] = [];
            const off = view.on('content:finished', e => events.push(e));
            const file = view.openFile('/work/missing');
            await expect(file.read()).rejects.toThrow();
            await file.close!();
            expect(events[0].payload).toMatchObject({ path: '/work/missing', outcome: 'failure' });
            expect(events[0].viewId).toBe('composed');
            off();
        } finally { await view.dispose(); await vfs.dispose(); }
    });

    it('pairs failed file operations with a classified finish', async () => {
        const vfs = await setupVFS();
        try {
            const events: FSEvent[] = [];
            const off = vfs.fs.onAny!(event => events.push(event));
            await expect(vfs.fs.driver.rename('/missing', 'next')).rejects.toThrow();
            const start = events.find(e => e.type === 'operation:started')!;
            const end = events.find(e => e.type === 'operation:finished') as FSEvent<'operation:finished'>;
            expect(end.payload).toMatchObject({ operationId: (start as FSEvent<'operation:started'>).payload.operationId,
                operation: 'rename', outcome: 'failure', errorCode: 'ENOENT' });
            off();
        } finally { await vfs.dispose(); }
    });

    it('publishes record keys and mutation types only after a successful commit', async () => {
        const vfs = await setupVFS();
        try {
            await vfs.fs.driver.createFile({ name: 'records', content: '' });
            const events: FSEvent<'seq:committed'>[] = [];
            const off = vfs.fs.on('seq:committed', e => events.push(e));
            await vfs.fs.meta.seq!.transaction(async tx => {
                await tx.setEntry('/records', 'message:1', 'secret');
                await tx.deleteEntry('/records', 'old');
            });
            expect(events[0].payload.changes).toEqual([
                { path: '/records', key: 'message:1', type: 'set' },
                { path: '/records', key: 'old', type: 'delete' },
            ]);
            await expect(vfs.fs.meta.seq!.transaction(async tx => {
                await tx.setEntry('/records', 'rollback', 'secret');
                throw new Error('abort');
            })).rejects.toThrow('abort');
            expect(events).toHaveLength(1);
            expect(JSON.stringify(events)).not.toContain('secret');
            off();
        } finally { await vfs.dispose(); }
    });
});
