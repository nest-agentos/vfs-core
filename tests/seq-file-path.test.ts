import { expect, it, vi } from 'vitest';
import { SeqFileOps } from '../src/impl/capabilities/SeqFileOps';
import type { EnginePort } from '../src/impl/capabilities/EnginePort';
import type { IRecordStore } from '../src/protocol';

it('resolves a batch once and resolves the next call again after its target changes', async () => {
    const resolveNode = vi.fn().mockResolvedValue({ realPath: '/first' });
    const getRecordField = vi.fn(async (path: string, field: string) => field.endsWith('missing') ? undefined : path);
    const seq = new SeqFileOps({ resolveNode } as unknown as EnginePort, { getRecordField } as unknown as IRecordStore);
    expect(await seq.getEntries('/alias', ['a', 'b', 'missing'])).toEqual({ a: '/first', b: '/first' });
    expect(resolveNode).toHaveBeenCalledTimes(1);
    expect(getRecordField).toHaveBeenCalledTimes(3);
    resolveNode.mockResolvedValue({ realPath: '/second' });
    expect(await seq.getEntries('/alias', ['a'])).toEqual({ a: '/second' });
    expect(resolveNode).toHaveBeenCalledTimes(2);
});

it('performs no record reads when batch path resolution fails, or when no keys are requested', async () => {
    const resolveNode = vi.fn().mockRejectedValue(new Error('mount unavailable'));
    const getRecordField = vi.fn();
    const seq = new SeqFileOps({ resolveNode } as unknown as EnginePort, { getRecordField } as unknown as IRecordStore);
    expect(await seq.getEntries('/alias', [])).toEqual({});
    expect(resolveNode).not.toHaveBeenCalled();
    await expect(seq.getEntries('/alias', ['a', 'b'])).rejects.toThrow('mount unavailable');
    expect(resolveNode).toHaveBeenCalledTimes(1);
    expect(getRecordField).not.toHaveBeenCalled();
});
