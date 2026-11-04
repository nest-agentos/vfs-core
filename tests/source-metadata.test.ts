import {afterEach, expect, it, vi} from 'vitest';
import {createFileSystemSource, createFileSystemView, FileStorageAdapter, MemoryBackend, transferFileSystemEntry, type FileStat, type FileStorageBackend, type FSNode} from '../src';
const owners: Array<{dispose(): Promise<void>}> = [];
afterEach(async () => {for (const owner of owners.splice(0).reverse()) await owner.dispose();});

async function source(metadata: boolean) {
    const memory = new MemoryBackend();
    const stat = (node: FSNode): FileStat => ({kind: node.type as FileStat['kind'], size: node.type === 'file' ? node.size : undefined,
        metadata: node.metadata, sourceIdentity: 'source-object', revision: String(node.version)});
    const patch = vi.fn((path: string, values: Record<string, unknown>) => memory.updateMetadata('/' + path, values));
    const backend: FileStorageBackend = {name: 'file-source', init: async () => {}, close: async () => {},
        files: {stat: async path => {const node = await memory.stat('/' + path); return node ? stat(node) : null;},
            list: async path => ({entries: (await memory.list('/' + path)).map(node => ({name: node.name, stat: stat(node)})), nextCursor: null}),
            read: async path => ({data: await memory.read('/' + path)})},
        mutations: {mkdir: async path => stat(await memory.mkdir('/' + path)),
            replace: async (path, bytes) => stat(await memory.write('/' + path, bytes)),
            rename: (from, to) => memory.rename('/' + from, '/' + to), remove: path => memory.delete('/' + path),
            ...(metadata ? {updateMetadata: patch} : {})}};
    const owner = await createFileSystemSource({backend: new FileStorageAdapter(backend), viewId: 'metadata-source'});
    owners.push(owner); return {...owner, patch};
}
it('creates and patches source metadata and preserves opaque identity through a projected mount', async () => {
    const {fs, patch} = await source(true);
    expect((await fs.capabilitiesAt('/')).metadata).toBe(true);
    await fs.driver.createFile({parentPath: '/', name: 'a.md', content: 'A', metadata: {title: 'Old', nested: {a: 1}, keep: true}});
    await fs.driver.updateMetadata('/a.md', {title: null, nested: {b: 2}});
    expect((await fs.driver.getNode('/a.md'))?.metadata).toEqual({title: null, nested: {b: 2}, keep: true});
    expect(patch).toHaveBeenLastCalledWith('a.md', {title: null, nested: {b: 2}});
    const view = createFileSystemView({viewId: 'projected', mounts: [{mountId: 'source', at: '/mounted', fs, access: 'rw'}]});
    owners.push(view);
    expect((await view.driver.getNode('/mounted/a.md'))?.sourceIdentity).toBe('source-object');
});
it('copies metadata to a capable source and rejects an unsupported target before publishing any entries', async () => {
    const owner = await createFileSystemSource({backend: new MemoryBackend(), viewId: 'origin', internal: true});owners.push(owner);
    await owner.fs.driver.createFile({parentPath: '/', name: 'note.md', content: 'Note', metadata: {title: 'Note'}});
    const capable = await source(true), unsupported = await source(false);
    await transferFileSystemEntry(owner.fs, '/note.md', capable.fs, '/');
    expect((await capable.fs.driver.getNode('/note.md'))?.metadata.title).toBe('Note');
    expect((await unsupported.fs.capabilitiesAt('/')).metadata).toBe(false);
    await expect(transferFileSystemEntry(owner.fs, '/note.md', unsupported.fs, '/')).rejects.toMatchObject({code: 'ECAPABILITY'});
    expect(await unsupported.fs.driver.exists('/note.md')).toBe(false);
    await expect(unsupported.fs.driver.createFile({parentPath: '/', name: 'direct.md', metadata: {title: 'No'}})).rejects.toMatchObject({code: 'ECAPABILITY'});
    expect(await unsupported.fs.driver.exists('/direct.md')).toBe(false);
});
