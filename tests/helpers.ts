/**
 * Shared test helpers for vfs-core integration tests.
 *
 * Each test suite uses vfs-core's built-in MemoryBackend — vfs-core has no
 * dependency on any sibling package. Real driver backends (e.g. IndexedDB)
 * are covered by their own packages.
 */

import { MemoryBackend } from '../src/testing/memory-backend';
import { createVFS } from '../src/impl/factory';
import type { IVFSManager, IFileSystem, IStorageBackend } from '@itookit/vfs-core';

// ─────────────────────────────────────────────────────────────────────────────
// Backend factories
// ─────────────────────────────────────────────────────────────────────────────

/** Create a plain in-memory backend (instant, self-contained). */
export function freshMem(): MemoryBackend {
    return new MemoryBackend();
}

// ─────────────────────────────────────────────────────────────────────────────
// VFS setup / teardown
// ─────────────────────────────────────────────────────────────────────────────

export interface TestVFS {
    manager: IVFSManager;
    fs: IFileSystem;          // 'test' module FS
    dispose: () => Promise<void>;
}

/**
 * Bootstrap a full VFS with a 'test' module.
 * Uses the built-in MemoryBackend by default; pass `backend` to override.
 */
export async function setupVFS(backend?: IStorageBackend): Promise<TestVFS> {
    const rootBackend = backend ?? freshMem();
    const { manager } = await createVFS({
        rootBackend,
    });
    const fs = await manager.openFileSystem('/data/test');
    return {
        manager,
        fs,
        dispose: async () => {
            await manager.dispose();
        },
    };
}

/**
 * Bootstrap a VFS with two separate modules, each potentially backed by
 * a different storage backend.
 */
export async function setupDualMountVFS(opts?: {
    rootBackend?: IStorageBackend;
    extraBackend?: IStorageBackend;
    extraPath?: string;
}): Promise<{ manager: IVFSManager; dispose: () => Promise<void> }> {
    const rootBackend = opts?.rootBackend ?? freshMem();
    const extraBackend = opts?.extraBackend ?? freshMem();
    const extraPath = opts?.extraPath ?? '/data/extra';

    const { manager } = await createVFS({
        rootBackend,
    });

    await manager.mounts.mountBackend(extraPath, extraBackend);

    return {
        manager,
        dispose: async () => { await manager.dispose(); },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Assert a path exists and return its node. */
export async function expectNode(fs: IFileSystem, path: string) {
    const node = await fs.driver.getNode(path);
    if (!node) throw new Error(`Expected node at '${path}' but it does not exist`);
    return node;
}

/** Assert a path does not exist. */
export async function expectMissing(fs: IFileSystem, path: string) {
    const exists = await fs.driver.exists(path);
    if (exists) throw new Error(`Expected '${path}' to be absent but it exists`);
}

/** Read text content from a path. */
export async function readText(fs: IFileSystem, path: string): Promise<string> {
    const content = await fs.driver.readContent(path, { encoding: 'utf-8' });
    return content as string;
}
