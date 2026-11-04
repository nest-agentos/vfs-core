import type { FileDiscoveryEntry, FileDiscoveryOptions, FileDiscoverySource, IFileSystem } from '../../protocol';
import { FileIgnoreFilter } from './file-ignore';

/** Bounded discovery only; explicit reads and filesystem authorization are independent. */
export async function* discoverFiles(source: FileDiscoverySource, root: string,
    options: FileDiscoveryOptions = {}): AsyncGenerator<FileDiscoveryEntry> {
    const filter = options.includeIgnored ? undefined : new FileIgnoreFilter(source, options.signal);
    const excluded = new Set(options.excludeDirectories);
    const queue = [root];
    let visited = 0;
    options.signal?.throwIfAborted();
    const start = await source.stat(root);
    if (start && start.type !== 'directory') {
        if (isFile(start) && (!filter || await filter.accepts(root, false))) yield start;
        return;
    }
    while (queue.length) {
        options.signal?.throwIfAborted();
        const path = queue.shift()!;
        if (filter && !await filter.accepts(path, true)) continue;
        for (const entry of await source.list(path)) {
            options.signal?.throwIfAborted();
            if (++visited > 10000) throw new Error('File discovery traversal limit exceeded');
            if (entry.type === 'directory' && !excluded.has(entry.name)) queue.push(entry.path);
            else if (isFile(entry) && (!filter || await filter.accepts(entry.path, false))) yield entry;
        }
    }
}

function isFile(entry: FileDiscoveryEntry): boolean {
    return entry.type === 'file' || entry.type === 'seqfile';
}

export function createVFSFileDiscoverySource(fs: IFileSystem, options?: import('../../protocol').OperationOptions): FileDiscoverySource {
    return {
        list: path => fs.driver.getChildren(path, { ...options, includeHidden: true }),
        stat: path => fs.driver.getNode(path, options),
        rootFor: path => fs.discoveryRoot?.(path) ?? '/',
        async readIgnoreFile(path) {
            if (fs.driver.getNodeType && (await fs.driver.getNodeType(path, options))?.type !== 'file') return null;
            const node = await fs.driver.getNode(path, options);
            if (!node || node.type !== 'file') return null;
            if ((node.size ?? 0) > 1024 * 1024) throw new Error('Ignore file size limit exceeded');
            return fs.driver.readContent(path, { ...options, encoding: 'utf-8' });
        },
    };
}
