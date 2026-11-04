/**
 * Reference (bidirectional link) operations:
 * addRef, removeRef, walkOutgoing, walkIncoming, hasRef, syncOutgoing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Reference } from '@itookit/vfs-core';
import { setupVFS, type TestVFS } from './helpers';

describe('Reference operations (IndexedDB backend)', () => {
    let vfs: TestVFS;
    beforeEach(async () => { vfs = await setupVFS(); });
    afterEach(async () => { await vfs.dispose(); });

    async function mkFile(name: string) {
        await vfs.fs.driver.createFile({ name, parentPath: null, content: '' });
        return `/${name}`;
    }

    async function collectOutgoing(idOrPath: string, opts?: import('@itookit/vfs-core').RefQueryOptions): Promise<Reference[]> {
        const refs: Reference[] = [];
        await vfs.fs.meta.refs!.walkOutgoing(idOrPath, (r) => { refs.push(r); return true; }, opts);
        return refs;
    }

    async function collectIncoming(idOrPath: string, opts?: import('@itookit/vfs-core').RefQueryOptions): Promise<Reference[]> {
        const refs: Reference[] = [];
        await vfs.fs.meta.refs!.walkIncoming(idOrPath, (r) => { refs.push(r); return true; }, opts);
        return refs;
    }

    it('addRef creates outgoing ref on source', async () => {
        const src = await mkFile('src.md');
        const tgt = await mkFile('tgt.md');
        await vfs.fs.meta.refs!.addRef(src, tgt, 'mention');
        const out = await collectOutgoing(src);
        expect(out).toHaveLength(1);
        expect(out[0].refType).toBe('mention');
    });

    it('addRef creates incoming ref on target', async () => {
        const src = await mkFile('s.md');
        const tgt = await mkFile('t.md');
        await vfs.fs.meta.refs!.addRef(src, tgt, 'depend');
        const inc = await collectIncoming(tgt);
        expect(inc).toHaveLength(1);
        expect(inc[0].refType).toBe('depend');
    });

    it('addRef is idempotent', async () => {
        const src = await mkFile('i1.md');
        const tgt = await mkFile('i2.md');
        await vfs.fs.meta.refs!.addRef(src, tgt, 'related');
        await vfs.fs.meta.refs!.addRef(src, tgt, 'related');
        const out = await collectOutgoing(src);
        expect(out.filter(r => r.refType === 'related')).toHaveLength(1);
    });

    it('hasRef returns true when ref exists', async () => {
        const src = await mkFile('h1.md');
        const tgt = await mkFile('h2.md');
        await vfs.fs.meta.refs!.addRef(src, tgt, 'embed');
        expect(await vfs.fs.meta.refs!.hasRef(src, tgt, 'embed')).toBe(true);
    });

    it('hasRef returns false for different refType', async () => {
        const src = await mkFile('x1.md');
        const tgt = await mkFile('x2.md');
        await vfs.fs.meta.refs!.addRef(src, tgt, 'mention');
        expect(await vfs.fs.meta.refs!.hasRef(src, tgt, 'depend')).toBe(false);
    });

    it('removeRef deletes the link from both sides', async () => {
        const src = await mkFile('r1.md');
        const tgt = await mkFile('r2.md');
        await vfs.fs.meta.refs!.addRef(src, tgt, 'mention');
        await vfs.fs.meta.refs!.removeRef(src, tgt, 'mention');
        expect(await vfs.fs.meta.refs!.hasRef(src, tgt, 'mention')).toBe(false);
        expect(await collectIncoming(tgt)).toHaveLength(0);
    });

    it('walkOutgoing filters by refType', async () => {
        const src = await mkFile('fo1.md');
        const t1 = await mkFile('fo2.md');
        const t2 = await mkFile('fo3.md');
        await vfs.fs.meta.refs!.addRef(src, t1, 'mention');
        await vfs.fs.meta.refs!.addRef(src, t2, 'depend');
        const mentions = await collectOutgoing(src, { refTypes: ['mention'] });
        expect(mentions).toHaveLength(1);
        expect(mentions[0].refType).toBe('mention');
    });

    it('syncOutgoing replaces all outgoing refs', async () => {
        const src = await mkFile('so1.md');
        const t1 = await mkFile('so2.md');
        const t2 = await mkFile('so3.md');
        const t3 = await mkFile('so4.md');
        await vfs.fs.meta.refs!.addRef(src, t1, 'mention');
        await vfs.fs.meta.refs!.addRef(src, t2, 'mention');
        await vfs.fs.meta.refs!.syncOutgoing(src, [
            { targetPath: t3, refType: 'mention' },
        ]);
        const out = await collectOutgoing(src);
        expect(out).toHaveLength(1);
        expect(await vfs.fs.meta.refs!.hasRef(src, t3, 'mention')).toBe(true);
        expect(await vfs.fs.meta.refs!.hasRef(src, t1, 'mention')).toBe(false);
    });

    it('extra payload is stored on ref', async () => {
        const src = await mkFile('ep1.md');
        const tgt = await mkFile('ep2.md');
        await vfs.fs.meta.refs!.addRef(src, tgt, 'related', { anchor: 'section-1' });
        const out = await collectOutgoing(src);
        expect(out[0].extra?.anchor).toBe('section-1');
    });

    it('node with no refs returns empty arrays', async () => {
        const p = await mkFile('solo.md');
        expect(await collectOutgoing(p)).toHaveLength(0);
        expect(await collectIncoming(p)).toHaveLength(0);
    });
});
