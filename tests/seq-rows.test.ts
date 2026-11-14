import {afterEach,expect,it,vi} from 'vitest';
import {setupVFS,freshMem} from './helpers';
import {createFileSystemView,copyFileSystemTree,type IFileSystem} from '../src';
import {seqRowControl,type SeqRowSchema,type SeqRowQuery} from '../src/seq';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
const schema: SeqRowSchema = {version:1,keyPrefix:'run:',columns:{state:{type:'integer'},time:{type:'integer'},label:{type:'text',nullable:true}},
    indexes:[{name:'state_time',columns:[{column:'state',direction:'asc'},{column:'time',direction:'desc'}]}]};
async function fixture() {
    const vfs = await setupVFS(); cleanup.push(vfs.dispose);
    await vfs.fs.driver.createFile({name:'rows.seq',type:'seqfile'});
    const file = vfs.fs.openFile('/rows.seq'); cleanup.push(() => file.close?.());
    return {fs:vfs.fs,file};
}
async function define(fs: IFileSystem, value = schema, expectedVersion: number | null = null) {
    return fs.meta.seq!.ioctl!('/rows.seq','seq.rows.define.v1',{schema:value,expectedVersion});
}
const query: SeqRowQuery = {select:['time'],where:{column:'state',op:'eq',value:1},orderBy:[{column:'time',direction:'desc'}],limit:2};

it('projects and filters rows with stable cursor ties while retaining exact original strings and cold fields', async () => {
    const {fs,file} = await fixture(), seq = fs.meta.seq!;
    const raw = ' { "state": 1, "time": 9, "label": null, "cold": "PRIVATE_COLD_BODY" } ';
    await seq.setEntry('/rows.seq','run:a',raw);
    for (const [key,state,time] of [['b',1,9],['c',1,4],['d',0,7]] as const)
        await seq.setEntry('/rows.seq','run:'+key,JSON.stringify({state,time,label:null}));
    await seq.setEntry('/rows.seq','detail:a','unstructured detail'); await define(fs);
    expect(fs.capabilities.structuredSeqFiles).toBe(true);
    const page = await seqRowControl(file,'seq.rows.query.v1',query);
    expect(page.rows).toEqual([{key:'run:a',values:{time:9}},{key:'run:b',values:{time:9}}]);
    expect(JSON.stringify(page)).not.toContain('PRIVATE_COLD_BODY');
    expect(await seqRowControl(file,'seq.rows.query.v1',{...query,after:page.next})).toEqual({rows:[{key:'run:c',values:{time:4}}]});
    await expect(seqRowControl(file,'seq.rows.query.v1',{...query,select:['label'],after:page.next})).rejects.toMatchObject({code:'EINVAL'});
    expect(await seq.getEntry('/rows.seq','run:a')).toBe(raw);
    const keys: string[] = []; await seq.walkEntries('/rows.seq',key => {keys.push(key.key); return true;});
    expect(keys).toHaveLength(5);
});

it('uses the same transaction for rows, schema and receipts and reports only committed changes', async () => {
    const {fs} = await fixture(), seq = fs.meta.seq!, events: unknown[] = [], diagnostics: unknown[] = [];
    fs.on('seq:committed',event => events.push(event.payload)); fs.on('operation:finished',event => diagnostics.push(event.payload));
    await expect(seq.transaction!(async tx => {
        await tx.ioctl!('/rows.seq','seq.rows.define.v1',{schema,expectedVersion:null});
        await tx.setEntry('/rows.seq','run:a',JSON.stringify({state:1,time:1}));
        await tx.setEntry('/rows.seq','receipt','accepted'); throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(events).toEqual([]); expect(await seq.getEntry('/rows.seq','receipt')).toBeNull();
    expect(await seq.ioctl!('/rows.seq','seq.rows.describe.v1')).toBeNull();
    await define(fs); const committed = events.length;
    await expect(seq.setEntry('/rows.seq','run:bad','{"state":"PRIVATE_BAD_VALUE","time":1}')).rejects.toMatchObject({code:'ETYPEMISMATCH'});
    expect(events).toHaveLength(committed);
    await expect(seq.ioctl!('/rows.seq','seq.rows.query.v1',{...query,select:['unknown']})).rejects.toMatchObject({code:'EINVAL'});
    expect(diagnostics.at(-1)).toMatchObject({operation:'ioctl',stage:'records.control',outcome:'failure',errorCode:'EINVAL',operationId:expect.any(String)});
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_BAD_VALUE');
});

it('preserves the old schema on migration failure and enforces uniqueness on ordinary writes', async () => {
    const {fs} = await fixture(), seq = fs.meta.seq!;
    await seq.setEntry('/rows.seq','run:a',JSON.stringify({state:1,time:1})); await define(fs);
    const next = {...schema,version:2,columns:{...schema.columns,required:{type:'text' as const}}};
    await expect(define(fs,next,1)).rejects.toMatchObject({code:'ETYPEMISMATCH'});
    expect(await seq.ioctl!('/rows.seq','seq.rows.describe.v1')).toMatchObject({version:1});
    await expect(define(fs,schema,null)).rejects.toMatchObject({code:'ECONFLICT'});
    const unique = {...schema,version:2,indexes:[{name:'only_time',columns:[{column:'time',direction:'asc' as const}],unique:true}]};
    await define(fs,unique,1);
    await expect(seq.setEntry('/rows.seq','run:b',JSON.stringify({state:2,time:1}))).rejects.toMatchObject({code:'ECONFLICT'});
    expect(await seq.getEntry('/rows.seq','run:b')).toBeNull();
});

it('allows read controls through read-only nested views and rejects write controls and mount escapes', async () => {
    const {fs} = await fixture(); await define(fs);
    const view = createFileSystemView({viewId:'readonly',mounts:[{mountId:'read',at:'/data',fs,access:'ro'}]}); cleanup.push(() => view.dispose());
    const nested = createFileSystemView({viewId:'nested',mounts:[{mountId:'nested',at:'/mounted',fs:view,access:'ro'}]}); cleanup.push(() => nested.dispose());
    expect(await nested.meta.seq!.ioctl!('/mounted/data/rows.seq','seq.rows.query.v1',query)).toEqual({rows:[]});
    await expect(nested.meta.seq!.ioctl!('/mounted/data/rows.seq','seq.rows.define.v1',{schema,expectedVersion:1})).rejects.toMatchObject({code:'EROFS'});
    await expect(nested.meta.seq!.ioctl!('/mounted/data/../rows.seq','seq.rows.query.v1',query)).rejects.toMatchObject({code:'EINVAL'});
    await expect(nested.meta.seq!.ioctl!('/mounted/data/rows.seq','unknown' as any,{})).rejects.toMatchObject({code:'ECAPABILITY'});
});

it('rejects an unsupported backend without a full-record scan', async () => {
    const backend = freshMem(); Object.defineProperty(backend.records,'rowControl',{value:undefined});
    Object.defineProperty(backend.records,'structuredRows',{value:false}); const scan = vi.spyOn(backend.records,'walkRecordFields');
    const vfs = await setupVFS(backend); cleanup.push(vfs.dispose);
    await vfs.fs.driver.createFile({name:'rows.seq',type:'seqfile'});
    expect(vfs.fs.capabilities.structuredSeqFiles).toBe(false);
    await expect(vfs.fs.meta.seq!.ioctl!('/rows.seq','seq.rows.query.v1',query)).rejects.toMatchObject({code:'ECAPABILITY'});
    expect(scan).not.toHaveBeenCalled();
});

it('copies a declared schema through the logical migration API instead of copying backend layout identities', async () => {
    const {fs} = await fixture(), destination = await setupVFS(); cleanup.push(destination.dispose);
    await define(fs); await fs.meta.seq!.setEntry('/rows.seq','run:a',' {"state":1,"time":7} ');
    await copyFileSystemTree(fs,'/rows.seq',destination.fs,'/copy.seq');
    expect(await destination.fs.meta.seq!.ioctl!('/copy.seq','seq.rows.query.v1',query)).toMatchObject({rows:[{key:'run:a',values:{time:7}}]});
    expect(await destination.fs.meta.seq!.getEntry('/copy.seq','run:a')).toBe(' {"state":1,"time":7} ');
    await copyFileSystemTree(fs,'/rows.seq',destination.fs,'/copy.seq');
    expect(await destination.fs.meta.seq!.ioctl!('/copy.seq','seq.rows.describe.v1')).toMatchObject({version:1});
});


it('pages keys without reading values and permits stable deletion across page boundaries', async () => {
    const {fs} = await fixture(), seq = fs.meta.seq!;
    const {seqKeys} = await import('../src/seq');
    await seq.transaction!(async tx => {
        for (let i=0;i<503;i++) await tx.setEntry('/rows.seq','item:'+String(i).padStart(4,'0'),'PRIVATE_COLD_BODY');
        await tx.setEntry('/rows.seq','other','keep');
    });
    const page = await seq.ioctl!('/rows.seq','seq.keys.page.v1',{keyPrefix:'item:',limit:2});
    expect(page).toEqual({keys:['item:0000','item:0001'],next:'item:0001'});
    await expect(seq.ioctl!('/rows.seq','seq.keys.page.v1',{limit:501})).rejects.toMatchObject({code:'EINVAL'});
    const keys: string[]=[];
    await seq.transaction!(async tx => {
        for await (const key of seqKeys(tx,'/rows.seq','item:')) {keys.push(key);await tx.deleteEntry('/rows.seq',key);}
    });
    expect(new Set(keys).size).toBe(503);
    expect(await seq.getEntry('/rows.seq','other')).toBe('keep');
    expect(await seq.ioctl!('/rows.seq','seq.keys.page.v1',{keyPrefix:'item:',limit:2})).toEqual({keys:[]});
});

it('releases ordinary walk snapshots before callbacks and restricts readonly transaction lifetime', async () => {
    const {fs} = await fixture(),seq=fs.meta.seq!;
    await seq.setEntry('/rows.seq','a','one');
    await seq.walkEntries('/rows.seq',async entry => {expect(await seq.getEntry('/rows.seq',entry.key)).toBe('one');return true;});
    let escaped: any;
    await seq.readTransaction!(async tx => {
        escaped=tx;await expect((tx as any).setEntry('/rows.seq','b','bad')).rejects.toMatchObject({code:'EROFS'});
        expect(await tx.getEntry('/rows.seq','a')).toBe('one');
        await expect(tx.ioctl!('/rows.seq','seq.rows.define.v1' as any,{schema,expectedVersion:null})).rejects.toMatchObject({code:'EROFS'});
    });
    await expect(escaped.getEntry('/rows.seq','a')).rejects.toMatchObject({code:'EACCES'});
});
