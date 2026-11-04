import type { IFileSystem } from '../../protocol';
import { FSError, FSCapabilityError } from '../../protocol';
import * as P from '../../utils/path';
import { normalizeVirtualPath } from './FileSystemView';

/**
 * Startup migration only: source must be quiescent and destination unpublished.
 * Retry overwrites copied values. The caller owns the durable publication marker.
 * Unlike driver.copy this copies SeqFile records between independent backends.
 */
export async function copyFileSystemTree(source: IFileSystem, sourceRoot: string, target: IFileSystem, targetRoot: string): Promise<void> {
    sourceRoot = normalizeVirtualPath(sourceRoot);
    targetRoot = normalizeVirtualPath(targetRoot);
    if (source === target && (P.isUnder(targetRoot, sourceRoot) || P.isUnder(sourceRoot, targetRoot))) throw new FSError('EINVAL', 'Migration roots overlap');
    const copied: Array<{ from: string; to: string }> = [];
    const visit = async (from: string, to: string): Promise<void> => {
        const node = await source.driver.getNode(from);
        if (!node) throw new FSError('ENOENT', 'Migration source missing', 'copy', from);
        const { vfsFixedLayout: _fixed, ...metadata } = node.metadata;
        if (node.type === 'directory') {
            const existing = await target.driver.getNode(to);
            if (existing && existing.type !== 'directory') throw new FSError('ETYPEMISMATCH', 'Migration target type differs');
            if (!existing) await target.driver.createDirectory({ name: P.basename(to), parentPath: P.dirname(to), recursive: true });
            for (const child of await source.driver.getChildren(from, { includeHidden: true, includeInternalDirs: true, includeAssetDirs: true })) {
                if (P.dirname(child.path) !== from) throw new FSError('EINVAL', 'Invalid migration source listing');
                await visit(child.path, P.join(to, child.name));
            }
        } else if (node.type === 'file' || node.type === 'seqfile') {
            if (await target.driver.exists(to)) {
                const current = await target.driver.getNode(to);
                if (current?.type !== node.type) throw new FSError('ETYPEMISMATCH', 'Migration target type differs');
            } else await target.driver.createFile({ name: P.basename(to), parentPath: P.dirname(to), type: node.type, content: '', recursive: true });
            // Some providers expose record-backed files as ordinary files. Copy
            // their records explicitly too; serialized readContent is not a record import.
            const entries: Array<{ key: string; value: string }> = [];
            if (source.meta.seq) await source.meta.seq.walkEntries(from, entry => { entries.push(entry); return true; });
            if (node.type === 'seqfile' || entries.length) {
                if (!target.meta.seq?.transaction) throw new FSCapabilityError('migration.seq.transaction');
            }
            if (node.type === 'file') await target.driver.writeContent(to, await source.driver.readContent(from, { encoding: 'binary' }));
            if (target.meta.seq?.transaction) {
                await target.meta.seq.transaction(async tx => {
                    const stale: string[] = [];
                    const keys = new Set(entries.map(entry => entry.key));
                    await tx.walkEntries(to, entry => { if (!keys.has(entry.key)) stale.push(entry.key); return true; });
                    for (const key of stale) await tx.deleteEntry(to, key);
                    for (const entry of entries) await tx.setEntry(to, entry.key, entry.value);
                });
            }
        } else throw new FSCapabilityError(`migration.${node.type}`);
        await target.driver.updateMetadata(to, metadata);
        await target.meta.tags.setTags(to, [...node.tags]);
        copied.push({ from, to });
    };
    await visit(sourceRoot, targetRoot);
    // Rebind references only after every destination node exists. External references
    // cannot safely retain a path that belongs to a different namespace.
    if (source.meta.refs) {
        for (const { from, to } of copied) {
            const refs: Parameters<NonNullable<typeof target.meta.refs>['syncOutgoing']>[1] = [];
            await source.meta.refs.walkOutgoing(from, ref => {
                if (!P.isUnder(ref.targetPath, sourceRoot)) throw new FSError('EXMOUNT', 'Migration contains an external reference');
                refs.push({ ...ref, targetPath: P.join(targetRoot, P.relative(sourceRoot, ref.targetPath)) });
                return true;
            });
            if (refs.length && !target.meta.refs) throw new FSCapabilityError('migration.references');
            await target.meta.refs?.syncOutgoing(to, refs);
        }
    }
}
