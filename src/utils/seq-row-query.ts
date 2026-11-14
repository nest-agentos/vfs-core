import type {SeqRowPage, SeqRowPredicate, SeqRowQuery, SeqRowResult, SeqRowScalar, SeqRowSchema} from '../interfaces/capabilities/seq-rows';
import {rowError, rowObject, validateRowScalar} from './seq-row-validation';
import {FSError} from '../interfaces/core/errors';
import {compareUtf8} from './key-order';

export interface SeqRowCursor {signature: string; key: string; order: SeqRowScalar[];}

/** Pagination fingerprint only; it is not an authorization token or a content digest. */
export function rowQuerySignature(path: string, schema: SeqRowSchema, query: SeqRowQuery): string {
    const source = JSON.stringify([path,schema,query.select,query.where,query.orderBy ?? []]);
    let a = 2166136261, b = 2246822519;
    for (let i = 0; i < source.length; i++) {a = Math.imul(a ^ source.charCodeAt(i),16777619); b = Math.imul(b ^ source.charCodeAt(i),3266489917);}
    return (a >>> 0).toString(16).padStart(8,'0') + (b >>> 0).toString(16).padStart(8,'0');
}
export function readRowCursor(path: string, schema: SeqRowSchema, query: SeqRowQuery): SeqRowCursor | undefined {
    if (!query.after) return;
    let value: Record<string, unknown>;
    try {value = rowObject(JSON.parse(query.after));} catch {return rowError('Invalid row cursor');}
    const orders = query.orderBy ?? [];
    if (value.signature !== rowQuerySignature(path,schema,query) || typeof value.key !== 'string' || new TextEncoder().encode(value.key).length > 4096
        || !Array.isArray(value.order) || value.order.length !== orders.length) rowError('Row cursor does not match this query');
    orders.forEach((order,index) => validateRowScalar(schema.columns[order.column],(value.order as unknown[])[index]));
    return value as unknown as SeqRowCursor;
}
export function compareRowScalar(left: SeqRowScalar, right: SeqRowScalar): number {
    if (left === right) return 0;
    if (left === null) return -1;
    if (right === null) return 1;
    if (typeof left !== 'string' || typeof right !== 'string') return Number(left) < Number(right) ? -1 : 1;
    return compareUtf8(left,right);
}
const comparisons = {eq:(value:number) => value === 0,ne:(value:number) => value !== 0,
    lt:(value:number) => value < 0,lte:(value:number) => value <= 0,gt:(value:number) => value > 0,gte:(value:number) => value >= 0};
export function compareRows(query: SeqRowQuery, left: SeqRowResult, right: SeqRowResult): number {
    for (const order of query.orderBy ?? []) {
        const compared = compareRowScalar(left.values[order.column],right.values[order.column]);
        if (compared) return compared * (order.direction === 'asc' ? 1 : -1);
    }
    return compareRowScalar(left.key,right.key);
}
export function rowMatches(values: Record<string, SeqRowScalar>, predicate?: SeqRowPredicate): boolean {
    if (!predicate) return true;
    if ('and' in predicate) return predicate.and.every(item => rowMatches(values,item));
    if ('or' in predicate) return predicate.or.some(item => rowMatches(values,item));
    const actual = values[predicate.column];
    if (predicate.op === 'in') return predicate.values.includes(actual);
    if (predicate.value === null) return predicate.op === 'eq' ? actual === null : actual !== null;
    if (actual === null) return false;
    const compared = compareRowScalar(actual,predicate.value);
    return comparisons[predicate.op](compared);
}
export function parseSeqRow(schema: SeqRowSchema, value: unknown): Record<string, SeqRowScalar> {
    let object: Record<string, unknown>;
    try {object = rowObject(typeof value === 'string' ? JSON.parse(value) : value);} catch {
        throw new FSError('ETYPEMISMATCH','Structured entries require a JSON object','seq.rows');
    }
    return Object.fromEntries(Object.entries(schema.columns).map(([name,column]) => {
        const item = object[name] ?? null;
        try {validateRowScalar(column,item);} catch {throw new FSError('ETYPEMISMATCH',`Structured column ${name} has an invalid type or size`,'seq.rows');}
        return [name,item];
    }));
}
export function makeRowPage(path: string, schema: SeqRowSchema, query: SeqRowQuery, found: SeqRowResult[]): SeqRowPage {
    const selected = found.slice(0,query.limit), last = selected.at(-1);
    const rows = selected.map(row => ({key:row.key,values:Object.fromEntries(query.select.map(name => [name,row.values[name]]))}));
    if (found.length <= query.limit || !last) return {rows};
    const next = JSON.stringify({signature:rowQuerySignature(path,schema,query),key:last.key,
        order:(query.orderBy ?? []).map(order => last.values[order.column])});
    if (next.length > 262144) rowError('Sort values exceed the row cursor size limit');
    return {rows,next};
}
