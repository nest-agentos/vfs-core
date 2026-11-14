import {FSError,FSCapabilityError,SEQ_FIELD_PREFIX,type IRecordTransaction,type SeqKeyQuery,type SeqKeyPage} from '../../protocol';
function input(value: unknown): SeqKeyQuery {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FSError('EINVAL','Key page input requires an object');
    const query = value as SeqKeyQuery;
    if (Object.keys(value).some(key => !['keyPrefix','after','limit'].includes(key))) throw new FSError('EINVAL','Unknown key page option');
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 500) throw new FSError('EINVAL','Key page size must be 1–500');
    boundary(query.keyPrefix); boundary(query.after);
    return query;
}
function boundary(field: unknown): void {
    if (field === undefined) return;
    if (typeof field !== 'string' || field.length > 65536) throw new FSError('EINVAL','Invalid key page boundary');
}
export async function seqKeyPage(records: IRecordTransaction, path: string, value: unknown): Promise<SeqKeyPage> {
    if (!records.keyPages || !records.getRecordKeys) throw new FSCapabilityError('seqKeyPages');
    const query = input(value), fields = await records.getRecordKeys(path,{prefix:SEQ_FIELD_PREFIX+(query.keyPrefix ?? ''),
        after:query.after === undefined ? undefined : SEQ_FIELD_PREFIX+query.after,limit:query.limit+1});
    const keys = fields.slice(0,query.limit).map(field => field.slice(SEQ_FIELD_PREFIX.length));
    return fields.length > query.limit ? {keys,next:keys.at(-1)} : {keys};
}
