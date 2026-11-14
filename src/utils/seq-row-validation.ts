import {FSError} from '../interfaces/core/errors';
import type {SeqRowColumn,SeqRowDefinition,SeqRowOrder,SeqRowQuery,SeqRowScalar,SeqRowSchema} from '../interfaces/capabilities/seq-rows';

export function rowError(message: string): never {throw new FSError('EINVAL',message,'seq.rows');}
export function rowObject(input: unknown): Record<string,unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return rowError('Expected an object');
    return input as Record<string,unknown>;
}
function keys(value: Record<string,unknown>, allowed: string[]): void {
    if (Object.keys(value).some(key => !allowed.includes(key))) rowError('Unknown structured row option');
}
function list(input: unknown, minimum: number, maximum: number): unknown[] {
    if (!Array.isArray(input) || input.length < minimum || input.length > maximum) return rowError('Structured row list size is invalid');
    return input;
}
function identifier(input: unknown): input is string {
    return typeof input === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(input) && !['__proto__','constructor','prototype'].includes(input);
}
function unicode(value: string): boolean {
    return new TextDecoder('utf-8',{ignoreBOM:true}).decode(new TextEncoder().encode(value)) === value;
}
function text(value: unknown, maximum: number): value is string {
    return typeof value === 'string' && unicode(value) && new TextEncoder().encode(value).length <= maximum;
}
function positive(value: unknown): value is number {return Number.isSafeInteger(value) && (value as number) > 0;}
function flag(value: unknown): boolean {
    if (value === undefined) return false;
    if (typeof value !== 'boolean') return rowError('Invalid structured row flag');
    return value;
}
function column(input: unknown): SeqRowColumn {
    const value = rowObject(input); keys(value,['type','nullable']);
    if (!['text','integer','real','boolean'].includes(value.type as string)) rowError('Invalid column type');
    return {type:value.type as SeqRowColumn['type'],nullable:flag(value.nullable)};
}
function columns(input: unknown): Record<string,SeqRowColumn> {
    const value = rowObject(input), names = Object.keys(value); list(names,1,24);
    return Object.fromEntries(names.sort().map(name => {
        if (!identifier(name)) rowError('Invalid column name');
        return [name,column(value[name])];
    }));
}
export function validateRowSchema(input: unknown): SeqRowSchema {
    const value = rowObject(input); keys(value,['version','keyPrefix','columns','indexes']);
    if (!positive(value.version)) rowError('Schema version must be a positive safe integer');
    if (!text(value.keyPrefix,256) || !value.keyPrefix) rowError('A bounded Unicode row key prefix is required');
    const schema: SeqRowSchema = {version:value.version as number,keyPrefix:value.keyPrefix as string,columns:columns(value.columns)};
    schema.indexes = indexes(schema,value.indexes); return schema;
}
function indexes(schema: SeqRowSchema, input: unknown): NonNullable<SeqRowSchema['indexes']> {
    if (input === undefined) return [];
    const seen = new Set<string>(), layouts = new Set<string>();
    return list(input,0,8).map(item => {
        const value = rowObject(item); keys(value,['name','columns','unique']);
        if (!identifier(value.name) || seen.has(value.name)) rowError('Invalid or duplicate index name');
        seen.add(value.name as string);
        const order = validateRowOrder(schema,value.columns,true), unique = flag(value.unique), signature = JSON.stringify([order,unique]);
        if (layouts.has(signature)) rowError('Duplicate structured row index');
        layouts.add(signature); return {name:value.name as string,columns:order,unique};
    }).sort((a,b) => a.name < b.name ? -1 : 1);
}
function columnName(schema: SeqRowSchema, value: unknown): string {
    if (typeof value !== 'string' || !Object.hasOwn(schema.columns,value)) return rowError('Unknown structured row column');
    return value;
}
export function validateRowOrder(schema: SeqRowSchema, input: unknown, required = false): SeqRowOrder[] {
    if (input === undefined && !required) return [];
    const seen = new Set<string>();
    return list(input,required ? 1 : 0,6).map(item => {
        const value = rowObject(item); keys(value,['column','direction']);
        const name = columnName(schema,value.column);
        if (seen.has(name)) rowError('Duplicate order column');
        if (value.direction !== 'asc' && value.direction !== 'desc') rowError('Sort direction must be asc or desc');
        seen.add(name); return {column:name,direction:value.direction as 'asc' | 'desc'};
    });
}
const scalarChecks: Record<SeqRowColumn['type'],(value:unknown) => boolean> = {
    text:value => text(value,4096), integer:Number.isSafeInteger,
    real:value => typeof value === 'number' && Number.isFinite(value), boolean:value => typeof value === 'boolean',
};
export function validateRowScalar(definition: SeqRowColumn, value: unknown): asserts value is SeqRowScalar {
    if (value === null && definition.nullable) return;
    if (!scalarChecks[definition.type](value)) rowError(`Column requires bounded ${definition.type}`);
}
function projection(schema: SeqRowSchema, input: unknown): string[] {
    const selected = list(input,1,24).map(value => columnName(schema,value));
    if (new Set(selected).size !== selected.length) rowError('Projection requires distinct columns');
    return selected;
}
export function validateRowQuery(schema: SeqRowSchema, input: unknown): SeqRowQuery {
    const query = rowObject(input); keys(query,['select','where','orderBy','limit','after']);
    projection(schema,query.select); validateRowOrder(schema,query.orderBy);
    if (!positive(query.limit) || query.limit > 500) rowError('Page size must be 1–500');
    if (query.after !== undefined && (typeof query.after !== 'string' || query.after.length > 262144)) rowError('Invalid row cursor');
    if (query.where !== undefined) predicate(schema,query.where,{count:0},0);
    return structuredClone(query) as unknown as SeqRowQuery;
}
function predicate(schema: SeqRowSchema, input: unknown, budget: {count:number}, depth: number): void {
    if (++budget.count > 64 || depth > 6) rowError('Filter is too complex');
    const value = rowObject(input);
    if (Object.hasOwn(value,'and') || Object.hasOwn(value,'or')) group(schema,value,budget,depth);
    else leaf(schema,value);
}
function group(schema: SeqRowSchema, value: Record<string,unknown>, budget: {count:number}, depth: number): void {
    if (Object.hasOwn(value,'and') === Object.hasOwn(value,'or')) rowError('Ambiguous filter group');
    const name = Object.hasOwn(value,'and') ? 'and' : 'or'; keys(value,[name]);
    for (const child of list(value[name],1,32)) predicate(schema,child,budget,depth+1);
}
function leaf(schema: SeqRowSchema, value: Record<string,unknown>): void {
    const definition = schema.columns[columnName(schema,value.column)];
    if (value.op === 'in') {
        keys(value,['column','op','values']);
        for (const item of list(value.values,1,100)) validateRowScalar(definition,item);
        return;
    }
    keys(value,['column','op','value']);
    if (!['eq','ne','lt','lte','gt','gte'].includes(value.op as string)) rowError('Unknown filter operator');
    validateRowScalar(definition,value.value);
    if (value.value === null && !['eq','ne'].includes(value.op as string)) rowError('Null only supports equality filters');
}
export function validateRowDefinition(input: unknown): SeqRowDefinition {
    const value = rowObject(input); keys(value,['schema','expectedVersion']);
    if (value.expectedVersion !== null && !positive(value.expectedVersion)) rowError('Expected schema version is required');
    return {schema:validateRowSchema(value.schema),expectedVersion:value.expectedVersion as number | null};
}
export function rowSchemaChange(current: SeqRowSchema | null, next: SeqRowDefinition): boolean {
    if ((current?.version ?? null) !== next.expectedVersion) throw new FSError('ECONFLICT','Structured row schema version changed','seq.rows');
    if (!current) return true;
    if (JSON.stringify(current) === JSON.stringify(next.schema)) return false;
    if (next.schema.version <= current.version) throw new FSError('ECONFLICT','Schema changes require a newer version','seq.rows');
    return true;
}
