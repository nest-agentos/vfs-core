import type { IRecordStore, IRecordTransaction } from '../../protocol';

/** Keep capability paths in the system namespace while the backend stores local paths. */
export function mapRecordPaths(records: IRecordStore, path: (systemPath: string) => string): IRecordStore {
    const scoped = (tx: IRecordTransaction): IRecordTransaction => {
        const mapped: IRecordTransaction = {
            getRecordField: (p, key) => tx.getRecordField(path(p), key),
            setRecordField: (p, key, value) => tx.setRecordField(path(p), key, value),
            deleteRecordField: (p, key) => tx.deleteRecordField(path(p), key),
            walkRecordFields: (p, callback, options) => tx.walkRecordFields(path(p), callback, options),
        };
        if (tx.getRecordFields) mapped.getRecordFields = (p, fields) => tx.getRecordFields!(path(p), fields);
        if (tx.getRecordFieldsMany) {
            mapped.getRecordFieldsMany = requests =>
                tx.getRecordFieldsMany!(requests.map(request => ({ path: path(request.path), field: request.field })));
        }
        return mapped;
    };
    return {
        ...scoped(records),
        setAllRecordFields: (p, fields) => records.setAllRecordFields(path(p), fields),
        clearRecordFields: p => records.clearRecordFields(path(p)),
        createRecordIndex: (p, field) => records.createRecordIndex(path(p), field),
        deleteRecordIndex: (p, field) => records.deleteRecordIndex(path(p), field),
        queryRecordFields: (p, query, options) => records.queryRecordFields(path(p), query, options),
        walkRecordFieldNames: (p, callback, options) => records.walkRecordFieldNames(path(p), callback, options),
        ...(records.transaction ? { transaction: <T>(operation: (tx: IRecordTransaction) => Promise<T>) =>
            records.transaction!(tx => operation(scoped(tx))) } : {}),
    };
}
