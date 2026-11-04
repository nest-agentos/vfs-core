import type { IFileSystem, IStorageBackend } from '../../protocol';
import { createVFS } from '../factory';
import { MemoryBackend } from '../../testing/memory-backend';
import { createFileSystemView } from './FileSystemView';

export interface FileSystemSourceOwner {
    readonly fs: IFileSystem;
    dispose(): Promise<void>;
}

/**
 * Takes ownership of an already-open, host-authorized backend. Its adapter manager
 * is private; bootstrap directories/devices are created only in memory, never in
 * the external directory. Keep the owner alive for as long as its mounts are used.
 */
export async function createFileSystemSource(options: {
    backend: IStorageBackend;
    viewId: string;
    access?: 'ro' | 'rw';
    tags?: boolean;
    /** Internal utility sources (archive staging, inspectors) may keep tags enabled. */
    internal?: boolean;
}): Promise<FileSystemSourceOwner> {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend(),
        additionalMounts: [{ path: '/source', backend: options.backend }] });
    try {
        const directory = await manager.openFileSystem('/source');
        const fs = createFileSystemView({
            viewId: options.viewId,
            tags: options.tags,
            external: options.internal !== true,
            mounts: [{ mountId: 'source', at: '/', fs: directory, access: options.access ?? 'rw' }],
        });
        let closing: Promise<void> | undefined;
        return { fs, dispose: () => closing ??= (async () => { await fs.dispose(); await manager.dispose(); })() };
    } catch (error) { await manager.dispose(); throw error; }
}
