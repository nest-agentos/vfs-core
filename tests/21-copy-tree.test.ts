import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSystemTree } from '../src';
import { setupVFS } from './helpers';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe('unpublished storage migration', () => {
    it('copies SeqFile records and append counters independently of file bytes, with retry reconciliation', async () => {
        const a = await setupVFS(), b = await setupVFS();
        cleanup.push(a.dispose, b.dispose);
        const source = a.fs, target = b.fs;
        await source.driver.createFile({ name: 'journal.seq', parentPath: '/old', type: 'seqfile', recursive: true });
        await source.meta.seq!.transaction!(async tx => { await tx.append('/old/journal.seq', 'event/', 'one'); });
        await source.openFile('/old/journal.seq').asset('attachment.txt').write('asset');
        await source.meta.tags.setTags('/old/journal.seq', ['journal']);
        expect(await source.meta.seq!.getEntry('/old/journal.seq', 'event/0000000000000001')).toBe('one');
        await copyFileSystemTree(source, '/old', target, '/new');
        expect(await target.meta.seq!.getEntry('/new/journal.seq', 'event/0000000000000001')).toBe('one');
        expect(await target.openFile('/new/journal.seq').asset('attachment.txt').readText()).toBe('asset');
        expect((await target.driver.getNode('/new/journal.seq'))?.tags).toEqual(['journal']);
        await target.meta.seq!.setEntry('/new/journal.seq', 'partial-retry', 'stale');
        await copyFileSystemTree(source, '/old', target, '/new');
        expect(await target.meta.seq!.getEntry('/new/journal.seq', 'partial-retry')).toBeNull();
        const key = await target.meta.seq!.transaction!(tx => tx.append('/new/journal.seq', 'event/', 'two'));
        expect(key).toBe('event/0000000000000002');
        expect(await source.meta.seq!.getEntry('/old/journal.seq', key)).toBeNull();
    });

    it('rejects conflicting destination types without replacing user data', async () => {
        const a = await setupVFS(), b = await setupVFS();
        cleanup.push(a.dispose, b.dispose);
        await a.fs.driver.createDirectory({ name: 'old', parentPath: '/' });
        await b.fs.driver.createFile({ name: 'new', parentPath: '/', content: 'keep' });
        await expect(copyFileSystemTree(a.fs, '/old', b.fs, '/new')).rejects.toMatchObject({ code: 'ETYPEMISMATCH' });
        expect(await b.fs.driver.readContent('/new', { encoding: 'utf-8' })).toBe('keep');
    });
});
