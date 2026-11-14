import type {RecordValue} from '../protocol';
import {FSError, SEQ_FIELD_PREFIX, type SeqRowCommand, type SeqRowSchema, type SeqRowResult} from '../protocol';
import {validateRowDefinition, validateRowQuery, rowError, rowSchemaChange} from '../utils/seq-row-validation';
import {parseSeqRow, rowMatches, compareRows, readRowCursor, makeRowPage} from '../utils/seq-row-query';
import {SEQ_ROW_SCHEMA_FIELD} from '../utils/seq-row-metadata';

type Fields = Map<string, Map<string, RecordValue>>;
export function memoryRowSchema(fields: Fields, path: string): SeqRowSchema | null {
    const metadata = fields.get(path)?.get(SEQ_ROW_SCHEMA_FIELD) as {schema?:unknown} | undefined;
    return metadata ? structuredClone(metadata.schema) as SeqRowSchema : null;
}
function rows(fields: Fields, path: string, schema: SeqRowSchema): SeqRowResult[] {
    return [...(fields.get(path) ?? [])].flatMap(([field,value]) => {
        if (!field.startsWith(SEQ_FIELD_PREFIX + schema.keyPrefix)) return [];
        const key = field.slice(SEQ_FIELD_PREFIX.length);
        if (new TextEncoder().encode(key).length > 4096) rowError('Row keys must not exceed 4096 bytes');
        return [{key,values:parseSeqRow(schema,value)}];
    });
}
function uniqueRows(schema: SeqRowSchema, values: SeqRowResult[]): void {
    for (const index of schema.indexes ?? []) {
        if (!index.unique) continue;
        const seen = new Set<string>();
        for (const row of values) {
            const tuple = index.columns.map(column => row.values[column.column]);
            if (tuple.includes(null)) continue;
            const key = JSON.stringify(tuple);
            if (seen.has(key)) throw new FSError('ECONFLICT','Unique structured row index conflict','seq.rows');
            seen.add(key);
        }
    }
}
export function validateMemoryRowWrite(fields: Fields, path: string, field: string, value: RecordValue): void {
    const schema = memoryRowSchema(fields,path);
    if (!schema || !field.startsWith(SEQ_FIELD_PREFIX + schema.keyPrefix)) return;
    const candidate = new Map(fields), entries = new Map(fields.get(path)); entries.set(field,value); candidate.set(path,entries);
    uniqueRows(schema,rows(candidate,path,schema));
}
function define(fields: Fields, path: string, input: unknown): SeqRowSchema {
    const definition = validateRowDefinition(input), previous = memoryRowSchema(fields,path), next = definition.schema;
    if (!rowSchemaChange(previous,definition)) return previous!;
    uniqueRows(next,rows(fields,path,next));
    const entries = fields.get(path) ?? new Map<string,RecordValue>();
    entries.set(SEQ_ROW_SCHEMA_FIELD,{schema:next} as unknown as RecordValue); fields.set(path,entries);
    return structuredClone(next);
}
export function memoryRowControl(fields: Fields, path: string, command: SeqRowCommand, input?: unknown): unknown {
    if (command === 'seq.rows.define.v1') return define(fields,path,input);
    const schema = memoryRowSchema(fields,path);
    if (command === 'seq.rows.describe.v1') {
        if (input !== undefined) rowError('Schema inspection accepts no input');
        return schema;
    }
    if (command !== 'seq.rows.query.v1') throw new FSError('ECAPABILITY','Unsupported structured row command','seq.rows');
    if (!schema) throw new FSError('ECAPABILITY','SeqFile has no structured row schema','seq.rows');
    const query = validateRowQuery(schema,input), cursor = readRowCursor(path,schema,query);
    let values = rows(fields,path,schema).filter(row => rowMatches(row.values,query.where)).sort((a,b) => compareRows(query,a,b));
    if (cursor) {
        const valuesAtCursor = Object.fromEntries((query.orderBy ?? []).map((order,index) => [order.column,cursor.order[index]]));
        values = values.filter(row => compareRows(query,row,{key:cursor.key,values:valuesAtCursor}) > 0);
    }
    return makeRowPage(path,schema,query,values.slice(0,query.limit + 1));
}
