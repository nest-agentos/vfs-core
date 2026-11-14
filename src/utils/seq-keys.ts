import {FSError,FSCapabilityError,type ISeqFileReadTransaction,type SeqKeyPage} from '../protocol';

/** Stream index keys in bounded pages; legacy ports retain their established walk behavior. */
export async function* seqKeys(reader: Pick<ISeqFileReadTransaction,'keyPages' | 'ioctl' | 'walkEntries'>,
    path: string, keyPrefix = ''): AsyncGenerator<string> {
    if (reader.keyPages !== true) {
        const keys: string[] = [];
        await reader.walkEntries(path,entry => {keys.push(entry.key); return true;},{keyPrefix,order:'key'});
        yield* keys; return;
    }
    if (!reader.ioctl) throw new FSCapabilityError('seqKeyPages');
    let after: string | undefined;
    while (true) {
        const page = await reader.ioctl(path,'seq.keys.page.v1',{keyPrefix,after,limit:500}) as SeqKeyPage;
        for (const key of page.keys) yield key;
        if (!page.next) return;
        if (page.next === after) throw new FSError('EIO','Record key cursor did not advance');
        after = page.next;
    }
}
