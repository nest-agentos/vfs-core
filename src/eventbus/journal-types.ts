import type { ISeqFileTransaction } from '../interfaces/capabilities/seq-file';

export interface EventCursor { streamId: string; sequence: number }
export interface JournalEvent<T> { id: string; sequence: number; occurredAt: number; value: T }
export interface JournalPage<T> {
    events: JournalEvent<T>[];
    cursor: EventCursor;
    head: EventCursor;
    more: boolean;
}
export interface JournalHead { version: 1; streamId: string; first: number; sequence: number }
export interface JournalTransaction<T> {
    /** Business records must use this transaction and the same backend for atomicity. */
    records: ISeqFileTransaction;
    append(id: string, value: T, occurredAt?: number): Promise<JournalEvent<T>>;
    getState(key: string): Promise<string | null>;
    setState(key: string, value: string | null): Promise<void>;
}
