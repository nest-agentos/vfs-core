import { FSError } from '../interfaces/core/errors';
import type { IFileSystem } from '../interfaces/services/file-system';
import type { ISeqFileTransaction } from '../interfaces/capabilities/seq-file';
import type { EventCursor, JournalEvent, JournalHead, JournalPage, JournalTransaction } from './journal-types';

const eventKey = (n: number) => `event/${String(n).padStart(16, '0')}`;
const idKey = (id: string) => `id/${encodeURIComponent(id)}`;
const invalid = (message: string) => new FSError('EINVAL', message);

/** Durable, bounded journal. Identity, payload policy and storage ownership belong to the host. */
export class SeqEventJournal<T> {
    private listeners = new Set<() => void>();
    private constructor(private readonly fs: IFileSystem, readonly path: string, private readonly retain: number) {}

    static async open<T>(fs: IFileSystem, path: string, streamId: string, retain = 1000): Promise<SeqEventJournal<T>> {
        if (!fs.capabilities.transactionalSeqFiles || !fs.meta.seq?.transaction)
            throw new FSError('ECAPABILITY', 'Durable events require transactional SeqFiles');
        if (!streamId || !Number.isSafeInteger(retain) || retain < 1 || retain > 10000) throw invalid('Invalid journal options');
        const at = path.lastIndexOf('/');
        try { await fs.driver.createFile({parentPath: path.slice(0, at) || '/', name: path.slice(at + 1), type: 'seqfile', recursive: true}); }
        catch (error) { if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error; }
        const journal = new SeqEventJournal<T>(fs, path, retain);
        await fs.meta.seq.transaction(async tx => {
            if (await tx.getEntry(path, 'head') === null) {
                let found = false;
                await tx.walkEntries(path, () => {found = true; return false;}, {limit: 1});
                if (found) throw invalid('Journal head missing from nonempty storage');
                await tx.setEntry(path, 'head', JSON.stringify({version: 1, streamId, first: 1, sequence: 0}));
            }
            await journal.head(tx);
        });
        return journal;
    }

    onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    close(): void { this.listeners.clear(); }
    async baseline(): Promise<EventCursor> {
        return this.fs.meta.seq!.transaction!(async tx => cursor(await this.head(tx)));
    }
    append(id: string, value: T, occurredAt = Date.now()): Promise<JournalEvent<T>> {
        return this.transaction(tx => tx.append(id, value, occurredAt));
    }
    async transaction<R>(run: (tx: JournalTransaction<T>) => Promise<R>): Promise<R> {
        let changed = false;
        const result = await this.fs.meta.seq!.transaction!(async records => {
            const head = await this.head(records), initialSequence = head.sequence;
            const output = await run({records,
                append: async (id, value, at = Date.now()) => {
                    const previousSequence = head.sequence;
                    const event = await this.appendTx(records, head, id, value, at);
                    changed ||= head.sequence !== previousSequence;
                    return event;
                },
                getState: key => records.getEntry(this.path, stateKey(key)),
                setState: async (key, value) => {
                    const previous = await records.getEntry(this.path, stateKey(key));
                    if (previous === value) return;
                    if (value === null) await records.deleteEntry(this.path, stateKey(key));
                    else await records.setEntry(this.path, stateKey(key), value);
                    changed = true;
                }});
            if (head.sequence !== initialSequence) await records.setEntry(this.path, 'head', JSON.stringify(head));
            return output;
        });
        if (changed) for (const listener of this.listeners) { try { listener(); } catch { /* Observer failure cannot undo a commit. */ } }
        return result;
    }
    async read(after?: EventCursor, limit = 100): Promise<JournalPage<T>> {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw invalid('Invalid journal page limit');
        return this.fs.meta.seq!.transaction!(async tx => {
            const head = await this.head(tx), sequence = after ? after.sequence : head.first - 1;
            if (!Number.isSafeInteger(sequence) || sequence < 0) throw invalid('Invalid event cursor');
            if ((after && after.streamId !== head.streamId) || sequence < head.first - 1 || sequence > head.sequence)
                throw new FSError('ECONFLICT', 'EVENT_CURSOR_EXPIRED: reload the resource snapshot and event baseline');
            const end = Math.min(head.sequence, sequence + limit);
            const sequences = Array.from({length: end - sequence}, (_, i) => sequence + i + 1);
            const rows = await tx.getEntries(this.path, sequences.map(eventKey));
            const events = sequences.map(n => decodeEvent<T>(rows[eventKey(n)] ?? null, n));
            return {events, cursor: {streamId: head.streamId, sequence: end}, head: cursor(head), more: end < head.sequence};
        });
    }
    private async head(tx: ISeqFileTransaction): Promise<JournalHead> {
        const raw = await tx.getEntry(this.path, 'head');
        const h = parse<JournalHead>(raw);
        if (!h || h.version !== 1 || typeof h.streamId !== 'string' || !h.streamId
            || !Number.isSafeInteger(h.sequence) || h.sequence < 0 || !Number.isSafeInteger(h.first) || h.first < 1 || h.first > h.sequence + 1)
            throw invalid('Invalid event journal head');
        return h;
    }
    private async appendTx(tx: ISeqFileTransaction, head: JournalHead, id: string, value: T, at: number): Promise<JournalEvent<T>> {
        if (typeof id !== 'string' || !id || id.length > 512 || !Number.isFinite(at) || at < 0) throw invalid('Invalid event identity');
        const previous = await tx.getEntry(this.path, idKey(id));
        if (previous !== null) {
            const event = await this.readEvent(tx, Number(previous));
            if (JSON.stringify(event.value) !== JSON.stringify(value)) throw new FSError('ECONFLICT', 'Event identity already has another value');
            return event;
        }
        if (head.sequence === Number.MAX_SAFE_INTEGER) throw invalid('Event sequence exhausted');
        const event = {id, sequence: ++head.sequence, occurredAt: at, value};
        const raw = JSON.stringify(event);
        if (raw.length > 16384) throw invalid('Event exceeds journal entry limit');
        await tx.setEntry(this.path, eventKey(event.sequence), raw);
        await tx.setEntry(this.path, idKey(id), String(event.sequence));
        while (head.sequence - head.first + 1 > this.retain) {
            const old = await this.readEvent(tx, head.first);
            await tx.deleteEntry(this.path, idKey(old.id));
            await tx.deleteEntry(this.path, eventKey(head.first++));
        }
        return event;
    }
    private async readEvent(tx: ISeqFileTransaction, sequence: number): Promise<JournalEvent<T>> {
        const raw = await tx.getEntry(this.path, eventKey(sequence));
        return decodeEvent<T>(raw, sequence);
    }
}
function cursor(head: JournalHead): EventCursor { return {streamId: head.streamId, sequence: head.sequence}; }
function stateKey(key: string): string {
    if (!key || key.length > 512) throw invalid('Invalid journal state key');
    return 'state/' + key;
}

function parse<T>(raw: string | null): T | undefined {
    try {return raw === null ? undefined : JSON.parse(raw) as T;}
    catch {throw invalid('Invalid event journal encoding');}
}
function decodeEvent<T>(raw: string | null, sequence: number): JournalEvent<T> {
    const event = parse<JournalEvent<T>>(raw);
    if (!event || event.sequence !== sequence || typeof event.id !== 'string' || !Number.isFinite(event.occurredAt))
        throw invalid('Event journal entry missing or invalid');
    return event;
}
