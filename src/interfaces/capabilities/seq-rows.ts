/** Optional structured projection of JSON-object entries; raw SeqFile strings remain authoritative. */
export type SeqRowScalar = string | number | boolean | null;
export interface SeqRowColumn {type: 'text' | 'integer' | 'real' | 'boolean'; nullable?: boolean;}
export interface SeqRowOrder {column: string; direction: 'asc' | 'desc';}
export interface SeqRowSchema {
    version: number;
    keyPrefix: string;
    columns: Record<string, SeqRowColumn>;
    indexes?: Array<{name: string; columns: SeqRowOrder[]; unique?: boolean}>;
}
export type SeqRowPredicate =
    | {column: string; op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; value: SeqRowScalar}
    | {column: string; op: 'in'; values: SeqRowScalar[]}
    | {and: SeqRowPredicate[]}
    | {or: SeqRowPredicate[]};
export interface SeqRowQuery {
    select: string[];
    where?: SeqRowPredicate;
    orderBy?: SeqRowOrder[];
    limit: number;
    after?: string;
}
export interface SeqRowResult {key: string; values: Record<string, SeqRowScalar>;}
export interface SeqRowPage {rows: SeqRowResult[]; next?: string;}
export interface SeqRowDefinition {schema: SeqRowSchema; expectedVersion: number | null;}
export interface SeqRowCommands {
    'seq.rows.describe.v1': {input: undefined; output: SeqRowSchema | null};
    'seq.rows.define.v1': {input: SeqRowDefinition; output: SeqRowSchema};
    'seq.rows.query.v1': {input: SeqRowQuery; output: SeqRowPage};
}
export type SeqRowCommand = keyof SeqRowCommands;
export const SEQ_ROW_COMMANDS: Readonly<Record<SeqRowCommand, 'read' | 'write'>> = Object.freeze({
    'seq.rows.describe.v1': 'read', 'seq.rows.define.v1': 'write', 'seq.rows.query.v1': 'read',
});
export interface ISeqRowControl {
    readonly structuredRows?: boolean;
    rowControl?(path: string, command: SeqRowCommand, input?: unknown): Promise<unknown>;
}
