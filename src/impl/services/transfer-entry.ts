import type { FSNode, IFileSystem } from '../../protocol';
import { FSError, FSCapabilityError } from '../../protocol';
import { normalizeVirtualPath } from './FileSystemView';
import * as P from '../../utils/path';

type References = Parameters<NonNullable<IFileSystem['meta']['refs']>['syncOutgoing']>[1];
interface Entry {
    node: FSNode; to: string; bytes?: ArrayBuffer; records: Array<{ key: string; value: string }>;
    refs: References; children?: string[]; assetOwner?: string;
}
export interface TransferEntryOptions {
    move?: boolean;
    /** The host must establish namespace identity even when views are distinct objects. */
    sameNamespace?: boolean;
    newName?: string;
}

/** Live, non-overwriting transfer. Source deletion follows a complete copy; cross-store moves are not atomic. */
export async function transferFileSystemEntry(source: IFileSystem, path: string, target: IFileSystem,
    parent: string, options: TransferEntryOptions = {}): Promise<FSNode> {
    path = normalizeVirtualPath(path); parent = normalizeVirtualPath(parent);
    const name = options.newName ?? P.basename(path), to = P.join(parent, name);
    if (!name || /[/\\\0]/.test(name) || ['.', '..'].includes(name) || path === '/') throw new FSError('EINVAL', 'Invalid transfer source or name');
    if ((source === target || options.sameNamespace) && P.isUnder(to, path)) throw new FSError('EINVAL', 'Transfer destination is inside the source');
    const destination = await target.driver.getNode(parent);
    if (destination?.metadata._readOnly) throw new FSError('EROFS', 'Transfer destination is read-only');
    if (destination?.type !== 'directory') throw new FSError('ENOTDIR', 'Transfer destination must be a directory');
    const entries: Entry[] = [];
    await collect(source, target, path, to, entries, !!options.move);
    const mapped = new Map(entries.map(entry => [entry.node.path, entry.to]));
    for (const entry of entries) for (const ref of entry.refs) {
        if (!mapped.has(ref.targetPath) && !(source === target || options.sameNamespace)) throw new FSError('EXMOUNT', 'Cannot transfer an external reference between namespaces');
    }
    await verify(source, entries);
    for (const entry of entries) await publish(target, entry);
    for (const entry of entries) if (entry.refs.length) await target.meta.refs!.syncOutgoing(entry.to,
        entry.refs.map(ref => ({ ...ref, targetPath: mapped.get(ref.targetPath) ?? ref.targetPath })));
    if (options.move) {
        await verify(source, entries);
        await source.driver.delete([path]);
    }
    return (await target.driver.getNode(to))!;
}

async function collect(source: IFileSystem, target: IFileSystem, path: string, to: string, entries: Entry[], moving: boolean, assetOwner?: string): Promise<void> {
    if (entries.some(entry => entry.node.path === path)) return;
    const node = await source.driver.getNode(path);
    if (!node) throw new FSError('ENOENT', 'Transfer source missing', 'transfer', path);
    if (!['directory', 'file', 'seqfile'].includes(node.type)) throw new FSCapabilityError(`transfer.${node.type}`);
    if (node.metadata.vfsFixedLayout) throw new FSError('EACCES', 'Cannot transfer a fixed layout entry');
    if ((await target.capabilitiesAt(to)).readonly || (moving && ((await source.capabilitiesAt(path)).readonly || node.metadata._readOnly))) throw new FSError('EROFS', 'Transfer path is read-only');
    if (await target.driver.exists(to)) throw new FSError('EEXIST', 'Transfer destination already exists', 'transfer', to);
    const entry: Entry = { node, to, records: [], refs: [], assetOwner };
    if (node.type !== 'directory') {
        entry.bytes = await source.driver.readContent(path, { encoding: 'binary' });
        if (source.meta.seq) await source.meta.seq.walkEntries(path, record => { entry.records.push({ key: record.key, value: record.value }); return true; });
        if ((node.type === 'seqfile' || entry.records.length) && !target.meta.seq) throw new FSCapabilityError('transfer.records');
    }
    if (source.meta.refs) await source.meta.refs.walkOutgoing(path, ref => { entry.refs.push(ref); return true; });
    if (entry.refs.length && !target.meta.refs) throw new FSCapabilityError('transfer.references');
    if (node.tags.length && !(await target.capabilitiesAt(to)).tags) throw new FSCapabilityError('transfer.tags');
    entries.push(entry);
    if (node.type === 'directory') await collectChildren(source, target, entry, entries, moving);
    else if ('assetDirPath' in node && node.assetDirPath) {
        if (!(await target.capabilitiesAt(to)).assets) throw new FSCapabilityError('transfer.assets');
        await collect(source, target, node.assetDirPath, P.join(P.dirname(to), '_' + P.basename(to)), entries, moving, to);
    }
}

async function collectChildren(source: IFileSystem, target: IFileSystem, entry: Entry, entries: Entry[], moving: boolean): Promise<void> {
    const children = await source.driver.getChildren(entry.node.path, { includeHidden: true, includeInternalDirs: true, includeAssetDirs: true });
    entry.children = children.map(node => node.path).sort();
    // Owner files create their asset directory before any explicitly listed asset directory.
    children.sort((a, b) => Number(a.type === 'directory') - Number(b.type === 'directory'));
    for (const child of children) {
        if (P.dirname(child.path) !== entry.node.path || P.basename(child.path) !== child.name || /[/\\\0]/.test(child.name)) throw new FSError('EINVAL', 'Invalid source listing');
        await collect(source, target, child.path, P.join(entry.to, child.name), entries, moving);
    }
}

async function publish(target: IFileSystem, entry: Entry): Promise<void> {
    const { vfsFixedLayout: _fixed, ...metadata } = entry.node.metadata;
    if (entry.assetOwner) {
        await target.driver.createDirectory({ name: P.basename(entry.to), parentPath: P.dirname(entry.to) });
        const actual = await target.meta.assets.ensureAssetDir(entry.assetOwner);
        if (actual !== entry.to) throw new FSError('EINVAL', 'Unexpected asset directory path');
        await target.driver.updateMetadata(entry.to, metadata);
    } else if (entry.node.type === 'directory') await target.driver.createDirectory({ name: P.basename(entry.to), parentPath: P.dirname(entry.to), metadata, icon: entry.node.icon });
    else await target.driver.createFile({ name: P.basename(entry.to), parentPath: P.dirname(entry.to), type: entry.node.type, content: entry.bytes, metadata, icon: entry.node.icon });
    for (const record of entry.records) await target.meta.seq!.setEntry(entry.to, record.key, record.value);
    if (entry.node.tags.length) await target.meta.tags.setTags(entry.to, [...entry.node.tags]);
}

async function verify(source: IFileSystem, entries: Entry[]): Promise<void> {
    for (const entry of entries) {
        const current = await source.driver.getNode(entry.node.path);
        if (JSON.stringify(current) !== JSON.stringify(entry.node)) throw new FSError('ECONFLICT', 'Source changed during transfer; source retained');
        if (entry.bytes) await verifyContent(source, entry);
        if (entry.children) {
            const children = await source.driver.getChildren(entry.node.path, { includeHidden: true, includeInternalDirs: true, includeAssetDirs: true });
            if (JSON.stringify(children.map(node => node.path).sort()) !== JSON.stringify(entry.children)) throw new FSError('ECONFLICT', 'Source directory changed during transfer; source retained');
        }
    }
}

async function verifyContent(source: IFileSystem, entry: Entry): Promise<void> {
    const before = new Uint8Array(entry.bytes!), after = new Uint8Array(await source.driver.readContent(entry.node.path, { encoding: 'binary' }));
    if (before.length !== after.length || before.some((value, index) => value !== after[index])) throw new FSError('ECONFLICT', 'Source content changed during transfer; source retained');
    const records: Array<{ key: string; value: string }> = [];
    if (source.meta.seq) await source.meta.seq.walkEntries(entry.node.path, record => { records.push({ key: record.key, value: record.value }); return true; });
    const sort = (values: typeof records) => [...values].sort((a, b) => a.key.localeCompare(b.key));
    if (JSON.stringify(sort(records)) !== JSON.stringify(sort(entry.records))) throw new FSError('ECONFLICT', 'Source records changed during transfer; source retained');
}
