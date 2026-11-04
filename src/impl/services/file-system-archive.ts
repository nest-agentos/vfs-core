import type { FSNode, IFileSystem } from '../../protocol';
import { FSError } from '../../protocol';
import { MemoryBackend } from '../../testing/memory-backend';
import { createFileSystemSource } from './FileSystemSource';
import { copyFileSystemTree } from './copy-tree';
import { normalizeVirtualPath } from './FileSystemView';
import * as P from '../../utils/path';

type References = Parameters<NonNullable<IFileSystem['meta']['refs']>['syncOutgoing']>[1];
export interface FileSystemArchive {
    format: 'filesystem-archive/v1';
    entries: Array<{ node: FSNode; bytes?: string; records: Array<{ key: string; value: string }>; refs: References }>;
}

/** The host must quiesce writers before taking a consistent archive. */
export async function exportFileSystem(fs: IFileSystem): Promise<FileSystemArchive> {
    const entries: FileSystemArchive['entries'] = [];
    const visit = async (path: string) => {
        const node = await fs.driver.getNode(path);
        if (!node) throw new FSError('ENOENT', 'Archive source disappeared');
        if (!['file', 'seqfile', 'directory'].includes(node.type)) throw new FSError('EINVAL', 'Archive contains an unsupported node');
        const records: Array<{ key: string; value: string }> = [];
        const refs: References = [];
        if (node.type !== 'directory' && fs.meta.seq) await fs.meta.seq.walkEntries(path, entry => { records.push({ key: entry.key, value: entry.value }); return true; });
        if (fs.meta.refs) await fs.meta.refs.walkOutgoing(path, ref => { refs.push({ ...ref }); return true; });
        let bytes: string | undefined;
        if (node.type !== 'directory') {
            const raw = await fs.driver.readContent(path, { encoding: 'binary' });
            let binary = '';
            for (const value of new Uint8Array(raw)) binary += String.fromCharCode(value);
            bytes = btoa(binary);
        }
        entries.push({ node, bytes, records, refs });
        if (node.type === 'directory') for (const child of await fs.driver.getChildren(path, { includeHidden: true, includeAssetDirs: true, includeInternalDirs: true })) {
            if (P.dirname(child.path) !== path) throw new FSError('EINVAL', 'Invalid archive source listing');
            await visit(child.path);
        }
    };
    await visit('/');
    return { format: 'filesystem-archive/v1', entries };
}

/** Validate/stage the entire archive first. Target must be unpublished or quiescent. */
export async function importFileSystem(fs: IFileSystem, archive: FileSystemArchive): Promise<void> {
    if (archive?.format !== 'filesystem-archive/v1' || !Array.isArray(archive.entries)) throw new FSError('EINVAL', 'Unsupported filesystem archive');
    const seen = new Set<string>();
    for (const entry of archive.entries) {
        if (!entry?.node || typeof entry.node.path !== 'string') throw new FSError('EINVAL', 'Invalid archive node');
        const path = normalizeVirtualPath(entry.node.path);
        if (path !== entry.node.path || seen.has(path) || !['directory', 'file', 'seqfile'].includes(entry.node.type)) throw new FSError('EINVAL', 'Invalid archive node');
        if (!Array.isArray(entry.records) || !Array.isArray(entry.refs)) throw new FSError('EINVAL', 'Invalid archive metadata');
        seen.add(path);
    }
    if (archive.entries.find(entry => entry.node.path === '/')?.node.type !== 'directory') throw new FSError('EINVAL', 'Archive root missing');
    const staging = await createFileSystemSource({ backend: new MemoryBackend(), viewId: 'archive-staging', internal: true });
    try {
        const ordered = [...archive.entries].sort((a, b) => a.node.path.split('/').length - b.node.path.split('/').length);
        for (const entry of ordered) {
            const { node } = entry;
            if (node.type === 'directory') {
                if (node.path !== '/') await staging.fs.driver.createDirectory({ name: P.basename(node.path), parentPath: P.dirname(node.path), recursive: true });
            } else {
                if (typeof entry.bytes !== 'string') throw new FSError('EINVAL', 'Archive content missing');
                const content = Uint8Array.from(atob(entry.bytes), char => char.charCodeAt(0)).buffer;
                await staging.fs.driver.createFile({ name: P.basename(node.path), parentPath: P.dirname(node.path), type: node.type, content, recursive: true });
                for (const record of entry.records) {
                    if (typeof record.key !== 'string' || typeof record.value !== 'string') throw new FSError('EINVAL', 'Invalid archive record');
                    await staging.fs.meta.seq!.setEntry(node.path, record.key, record.value);
                }
            }
            await staging.fs.driver.updateMetadata(node.path, node.metadata);
            await staging.fs.meta.tags.setTags(node.path, [...node.tags]);
        }
        for (const entry of ordered) {
            for (const ref of entry.refs) {
                if (!ref || typeof ref.targetPath !== 'string' || !['mention', 'depend', 'related', 'embed'].includes(ref.refType)) throw new FSError('EINVAL', 'Invalid archive reference');
                const path = normalizeVirtualPath(ref.targetPath);
                if (path !== ref.targetPath || !seen.has(path)) throw new FSError('EINVAL', 'Archive reference target missing');
            }
            await staging.fs.meta.refs!.syncOutgoing(entry.node.path, entry.refs);
        }
        await copyFileSystemTree(staging.fs, '/', fs, '/');
    } finally { await staging.dispose(); }
}
