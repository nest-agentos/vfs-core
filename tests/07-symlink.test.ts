/**
 * Symlink capability contract for the path-based IndexedDB backend.
 *
 * Symlinks are optional in IStorageBackend. The IndexedDB implementation does
 * not advertise them, so callers must receive an explicit capability error.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupVFS, type TestVFS } from './helpers';

describe('Symlink capability (IndexedDB backend)', () => {
    let vfs: TestVFS;

    beforeEach(async () => {
        vfs = await setupVFS();
    });

    afterEach(async () => {
        await vfs.dispose();
    });

    it('reports symlinks as unsupported', () => {
        expect(vfs.fs.capabilities.symlinks).toBe(false);
    });

    it('rejects symlink operations with a capability error', async () => {
        await expect(vfs.fs.driver.symlink('/link.txt', 'target.txt'))
            .rejects.toThrow('ECAPABILITY');
        await expect(vfs.fs.driver.readlink('/link.txt'))
            .rejects.toThrow('ECAPABILITY');
    });
});
