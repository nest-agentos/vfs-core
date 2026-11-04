import {afterEach, expect, it, vi} from 'vitest';
import {SeqEventJournal} from '../src';
import {setupVFS} from './helpers';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close();});
async function fixture(retain = 3) {
    const vfs = await setupVFS(); cleanup.push(vfs.dispose);
    const journal = await SeqEventJournal.open<{type: string}>(vfs.fs, '/events.seq', 'stream-a', retain);
    return {...vfs, journal};
}
it('commits business records, source checkpoint and event atomically; rollback is silent', async () => {
    const {journal, fs} = await fixture(), changed = vi.fn(); journal.onChange(changed);
    await fs.driver.createFile({parentPath: '/', name: 'business.seq', type: 'seqfile'});
    await expect(journal.transaction(async tx => {
        await tx.records.setEntry('/business.seq', 'status', 'done');
        await tx.append('op-1', {type: 'done'}); await tx.setState('source', '1');
        throw new Error('interrupt');
    })).rejects.toThrow('interrupt');
    expect(await fs.meta.seq!.getEntry('/business.seq', 'status')).toBeNull();
    expect((await journal.read()).events).toEqual([]); expect(changed).not.toHaveBeenCalled();
    await journal.transaction(async tx => {
        await tx.records.setEntry('/business.seq', 'status', 'done');
        await tx.append('op-1', {type: 'done'}); await tx.setState('source', '1');
    });
    expect(await journal.transaction(tx => tx.getState('source'))).toBe('1');
    expect(changed).toHaveBeenCalledOnce();
    await journal.append('op-1', {type: 'done'});
    expect(changed).toHaveBeenCalledOnce();
    await expect(journal.append('op-1', {type: 'different'})).rejects.toMatchObject({code: 'ECONFLICT'});
});
it('reopens with the same stream, replays independent cursors and expires pruned or foreign cursors', async () => {
    const {journal, fs} = await fixture(), baseline = await journal.baseline();
    await Promise.all(['a', 'b', 'c'].map(id => journal.append(id, {type: id})));
    const restored = await SeqEventJournal.open<{type: string}>(fs, '/events.seq', 'ignored-new-id', 3);
    const first = await restored.read(baseline, 1);
    expect(first.events.map(event => event.id)).toEqual(['a']);
    expect((await journal.read(baseline)).events).toHaveLength(3);
    expect((await restored.read(first.cursor)).events.map(event => event.id)).toEqual(['b', 'c']);
    await restored.append('d', {type: 'd'});
    await expect(restored.read(baseline)).rejects.toMatchObject({code: 'ECONFLICT'});
    await expect(restored.read({streamId: 'another-user', sequence: 2})).rejects.toMatchObject({code: 'ECONFLICT'});
    expect((await restored.read()).events.map(event => event.id)).toEqual(['b', 'c', 'd']);
});
it('rejects oversized records without publishing or consuming sequence numbers', async () => {
    const {journal} = await fixture(), before = await journal.baseline(), changed = vi.fn(); journal.onChange(changed);
    await expect(journal.append('big', {type: 'x'.repeat(17000)})).rejects.toMatchObject({code: 'EINVAL'});
    expect(await journal.baseline()).toEqual(before); expect(changed).not.toHaveBeenCalled();
});
it('rejects corrupt nonempty storage instead of assigning a new stream and silently resetting history', async () => {
    const {journal, fs} = await fixture();
    await journal.append('a', {type: 'a'});
    await fs.meta.seq!.deleteEntry('/events.seq', 'head');
    await expect(SeqEventJournal.open(fs, '/events.seq', 'replacement')).rejects.toMatchObject({code: 'EINVAL'});
    expect(await fs.meta.seq!.getEntry('/events.seq', 'id/a')).toBe('1');
});
