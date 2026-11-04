/**
 * SeqFile / KV operations: setEntry, getEntry, getAllEntries,
 * setEntries, deleteEntry, hasEntry, queryEntries.
 * IndexedDB backend provides native IRecordStore → seqFiles capability is true.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshMem, setupVFS, type TestVFS } from './helpers';

describe('SeqFile operations (IndexedDB backend)', () => {
    let vfs: TestVFS;
    beforeEach(async () => { vfs = await setupVFS(); });
    afterEach(async () => { await vfs.dispose(); });

    async function mkSeq(name: string) {
        await vfs.fs.driver.createFile({ name, parentPath: null, type: 'seqfile' });
        return `/${name}`;
    }

    it('notifies once after commit, never for reads or rolled-back mutations', async () => {
        const one = await mkSeq('one.seq'), two = await mkSeq('two.seq');
        const events: string[][] = [];
        const off = vfs.fs.on('seq:committed', event => events.push(event.payload.paths));
        const seq = vfs.fs.meta.seq!;
        await seq.transaction!(async tx => {
            await tx.setEntry(one, 'state', 'ready');
            await tx.setEntry(two, 'state', 'waiting');
            await tx.setEntry(one, 'version', '2');
            expect(events).toEqual([]);
        });
        expect(events).toEqual([[one, two]]);
        await expect(seq.transaction!(async tx => {
            await tx.deleteEntry(one, 'state');
            throw new Error('rollback');
        })).rejects.toThrow('rollback');
        await seq.transaction!(tx => tx.getEntry(one, 'state'));
        expect(events).toHaveLength(1);
        expect(await seq.getEntry(one, 'state')).toBe('ready');
        await seq.setEntry(one, 'state', 'done');
        await seq.deleteEntry(two, 'state');
        expect(events).toEqual([[one, two], [one], [two]]);
        off();
    });

    it('capabilities.seqFiles is true', () => {
        expect(vfs.fs.capabilities.seqFiles).toBe(true);
        expect(vfs.fs.meta.seq).toBeDefined();
    });

    it('setEntry and getEntry round-trip', async () => {
        const p = await mkSeq('kv.seq');
        await vfs.fs.meta.seq!.setEntry(p, 'foo', 'bar');
        expect(await vfs.fs.meta.seq!.getEntry(p, 'foo')).toBe('bar');
    });

    it('getEntry returns null for missing key', async () => {
        const p = await mkSeq('miss.seq');
        expect(await vfs.fs.meta.seq!.getEntry(p, 'ghost')).toBeNull();
    });

    it('hasEntry returns true/false correctly', async () => {
        const p = await mkSeq('has.seq');
        expect(await vfs.fs.meta.seq!.hasEntry(p, 'k')).toBe(false);
        await vfs.fs.meta.seq!.setEntry(p, 'k', 'v');
        expect(await vfs.fs.meta.seq!.hasEntry(p, 'k')).toBe(true);
    });

    it('setEntry overwrites existing value', async () => {
        const p = await mkSeq('ow.seq');
        await vfs.fs.meta.seq!.setEntry(p, 'x', 'v1');
        await vfs.fs.meta.seq!.setEntry(p, 'x', 'v2');
        expect(await vfs.fs.meta.seq!.getEntry(p, 'x')).toBe('v2');
    });

    it('setEntries batch-writes multiple keys', async () => {
        const p = await mkSeq('batch.seq');
        await vfs.fs.meta.seq!.setEntries(p, { a: '1', b: '2', c: '3' });
        expect(await vfs.fs.meta.seq!.getEntry(p, 'a')).toBe('1');
        expect(await vfs.fs.meta.seq!.getEntry(p, 'b')).toBe('2');
        expect(await vfs.fs.meta.seq!.getEntry(p, 'c')).toBe('3');
    });

    it('walkEntries returns all key-value pairs', async () => {
        const p = await mkSeq('all.seq');
        await vfs.fs.meta.seq!.setEntries(p, { name: 'alice', age: '30' });
        const entries: import('@itookit/vfs-core').SeqFileEntry[] = [];
        await vfs.fs.meta.seq!.walkEntries(p, (e) => { entries.push(e); return true; });
        const map = Object.fromEntries(entries.map(e => [e.key, e.value]));
        expect(map.name).toBe('alice');
        expect(map.age).toBe('30');
    });

    it('walkEntries returns empty for new seqfile', async () => {
        const p = await mkSeq('empty.seq');
        const entries: import('@itookit/vfs-core').SeqFileEntry[] = [];
        await vfs.fs.meta.seq!.walkEntries(p, (e) => { entries.push(e); return true; });
        expect(entries).toHaveLength(0);
    });

    it('getEntries retrieves only requested keys', async () => {
        const p = await mkSeq('partial.seq');
        await vfs.fs.meta.seq!.setEntries(p, { x: '1', y: '2', z: '3' });
        const result = await vfs.fs.meta.seq!.getEntries(p, ['x', 'z']);
        expect(Object.keys(result).sort()).toEqual(['x', 'z']);
        expect(result.x).toBe('1');
        expect(result.z).toBe('3');
    });

    it('getEntriesMany reads many files in request order and reports missing paths as null', async () => {
        const left = await mkSeq('many-left.seq'), right = await mkSeq('many-right.seq');
        await vfs.fs.meta.seq!.setEntry(left, 'state', 'ready');
        await vfs.fs.meta.seq!.setEntry(right, 'state', 'waiting');
        const requests = [
            { fileIdOrPath: left, key: 'state' },
            { fileIdOrPath: right, key: 'state' },
            { fileIdOrPath: right, key: 'absent' },
            { fileIdOrPath: '/many-missing.seq', key: 'state' },
        ];
        expect(await vfs.fs.meta.seq!.getEntriesMany(requests))
            .toEqual(['ready', 'waiting', null, null]);
        expect(await vfs.fs.meta.seq!.transaction!(tx => tx.getEntriesMany(requests)))
            .toEqual(['ready', 'waiting', null, null]);
        expect(await vfs.fs.meta.seq!.getEntriesMany([])).toEqual([]);
    });

    it('getEntriesMany issues one backend batch call and falls back without the capability', async () => {
        const backend = freshMem();
        const batch = vi.spyOn(backend.records, 'getRecordFieldsMany');
        const batched = await setupVFS(backend);
        try {
            await batched.fs.driver.createFile({ name: 'pair.seq', parentPath: null, type: 'seqfile' });
            await batched.fs.meta.seq!.setEntries('/pair.seq', { x: '1', y: '2' });
            batch.mockClear();
            expect(await batched.fs.meta.seq!.getEntriesMany([
                { fileIdOrPath: '/pair.seq', key: 'x' }, { fileIdOrPath: '/pair.seq', key: 'y' },
            ])).toEqual(['1', '2']);
            expect(batch).toHaveBeenCalledTimes(1);
        } finally { await batched.dispose(); }

        const degraded = freshMem();
        (degraded.records as { getRecordFieldsMany?: unknown }).getRecordFieldsMany = undefined;
        const plain = await setupVFS(degraded);
        try {
            await plain.fs.driver.createFile({ name: 'pair.seq', parentPath: null, type: 'seqfile' });
            await plain.fs.meta.seq!.setEntries('/pair.seq', { x: '1' });
            expect(await plain.fs.meta.seq!.getEntriesMany([
                { fileIdOrPath: '/pair.seq', key: 'x' }, { fileIdOrPath: '/pair.seq', key: 'nope' },
            ])).toEqual(['1', null]);
        } finally { await plain.dispose(); }
    });

    it('deleteEntry removes a key', async () => {
        const p = await mkSeq('del.seq');
        await vfs.fs.meta.seq!.setEntry(p, 'del', 'gone');
        await vfs.fs.meta.seq!.setEntry(p, 'keep', 'here');
        await vfs.fs.meta.seq!.deleteEntry(p, 'del');
        expect(await vfs.fs.meta.seq!.getEntry(p, 'del')).toBeNull();
        expect(await vfs.fs.meta.seq!.getEntry(p, 'keep')).toBe('here');
    });

    it('transaction atomically updates multiple seqfiles', async () => {
        const left = await mkSeq('tx-left.seq');
        const right = await mkSeq('tx-right.seq');
        await vfs.fs.meta.seq!.transaction!(async tx => {
            await tx.setEntry(left, 'state', 'ready');
            await tx.setEntry(right, 'state', 'waiting');
        });
        expect(await vfs.fs.meta.seq!.getEntry(left, 'state')).toBe('ready');
        expect(await vfs.fs.meta.seq!.getEntry(right, 'state')).toBe('waiting');
    });

    it('transaction rolls back and compareAndSet is conditional', async () => {
        const path = await mkSeq('tx-rollback.seq');
        await vfs.fs.meta.seq!.setEntry(path, 'version', '1');
        await expect(vfs.fs.meta.seq!.transaction!(async tx => {
            expect(await tx.compareAndSet(path, 'version', { expected: '1', value: '2' })).toBe(true);
            throw new Error('rollback');
        })).rejects.toThrow('rollback');
        expect(await vfs.fs.meta.seq!.getEntry(path, 'version')).toBe('1');
    });

    it('append allocates monotonic ordered keys', async () => {
        const path = await mkSeq('tx-append.seq');
        const keys = await vfs.fs.meta.seq!.transaction!(async tx => [
            await tx.append(path, 'event/', 'first'),
            await tx.append(path, 'event/', 'second'),
        ]);
        expect(keys[0] < keys[1]).toBe(true);
    });

    it('queryEntries with equality operator', async () => {
        const p = await mkSeq('query.seq');
        await vfs.fs.meta.seq!.setEntries(p, { status: 'active', color: 'blue', role: 'admin' });
        const results = await vfs.fs.meta.seq!.queryEntries!(p, { field: 'status', operator: '=', value: 'active' });
        expect(results).toHaveLength(1);
        expect(results[0].value).toBe('active');
    });

    it('queryEntries with contains operator on string', async () => {
        const p = await mkSeq('qc.seq');
        await vfs.fs.meta.seq!.setEntries(p, { title: 'Hello World', body: 'Lorem ipsum' });
        const results = await vfs.fs.meta.seq!.queryEntries!(p, { field: 'title', operator: 'contains', value: 'World' });
        expect(results).toHaveLength(1);
    });

    it('multiple seqfiles are independent', async () => {
        const p1 = await mkSeq('m1.seq');
        const p2 = await mkSeq('m2.seq');
        await vfs.fs.meta.seq!.setEntry(p1, 'k', 'from-m1');
        await vfs.fs.meta.seq!.setEntry(p2, 'k', 'from-m2');
        expect(await vfs.fs.meta.seq!.getEntry(p1, 'k')).toBe('from-m1');
        expect(await vfs.fs.meta.seq!.getEntry(p2, 'k')).toBe('from-m2');
    });

    it('readContent of seqfile serializes entries as key=value lines', async () => {
        const p = await mkSeq('read.seq');
        await vfs.fs.meta.seq!.setEntry(p, 'name', 'alice');
        const text = await vfs.fs.driver.readContent(p, { encoding: 'utf-8' }) as string;
        expect(text).toContain('name=alice');
    });
});
