import {FSError,FSCapabilityError,type IFileSystem,type ISeqFileTransaction,type SeqRowSchema} from '../../protocol';

export async function migrationRowSchema(fs: IFileSystem, path: string): Promise<SeqRowSchema | null> {
    if (!(await fs.capabilitiesAt(path)).structuredSeqFiles) return null;
    if (!fs.meta.seq?.ioctl) throw new FSCapabilityError('migration.structuredSeqFiles');
    return await fs.meta.seq.ioctl(path,'seq.rows.describe.v1') as SeqRowSchema | null;
}
export async function copySeqSchema(tx: ISeqFileTransaction, path: string, schema: SeqRowSchema | null, supported: boolean): Promise<void> {
    if (!supported) {if (schema) throw new FSCapabilityError('migration.structuredSeqFiles'); return;}
    if (!tx.ioctl) throw new FSCapabilityError('migration.structuredSeqFiles');
    const current = await tx.ioctl(path,'seq.rows.describe.v1') as SeqRowSchema | null;
    if (JSON.stringify(current) === JSON.stringify(schema)) return;
    if (!schema) throw new FSError('ECONFLICT','Migration target has a different structured schema','copy');
    const keys: string[] = [];
    await tx.walkEntries(path,entry => {keys.push(entry.key); return true;});
    for (const key of keys) await tx.deleteEntry(path,key);
    await tx.ioctl(path,'seq.rows.define.v1',{schema,expectedVersion:current?.version ?? null});
}
