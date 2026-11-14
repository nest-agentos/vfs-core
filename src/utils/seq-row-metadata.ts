import {FSError} from '../interfaces/core/errors';
export const SEQ_ROW_SCHEMA_FIELD = '__vfs_seq_rows_schema__';
export function ordinaryRecordField(field: string): void {
    if (field === SEQ_ROW_SCHEMA_FIELD) throw new FSError('ERESERVED','Structured schema metadata requires rowControl','seq.rows');
}
