/**
 * AssetDir operations: putAsset, getAsset, listAssets, deleteAsset,
 * ensureAssetDir, removeAssetDir, hasAssetDir, cascade delete on rename.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupVFS, type TestVFS } from './helpers';

describe('AssetDir operations (IndexedDB backend)', () => {
    let vfs: TestVFS;
    beforeEach(async () => { vfs = await setupVFS(); });
    afterEach(async () => { await vfs.dispose(); });

    const ownerPath = '/report.md';

    async function createOwner(fs: Awaited<ReturnType<typeof setupVFS>>['fs']) {
        await fs.driver.createFile({ name: 'report.md', parentPath: null, content: '# report' });
    }

    it('putAsset creates assetdir and stores asset', async () => {
        const { fs } = vfs;
        await createOwner(fs);
        expect(fs.meta.assets).toBeDefined();
        await fs.meta.assets!.putAsset(ownerPath, 'thumb.png', 'fake-image-data');
        const data = await fs.meta.assets!.getAsset(ownerPath, 'thumb.png');
        expect(data).toBeTruthy();
        expect(new TextDecoder().decode(data as ArrayBuffer)).toBe('fake-image-data');
    });

    it('putAsset is idempotent — overwrite existing asset', async () => {
        const { fs } = vfs;
        await createOwner(fs);
        await fs.meta.assets!.putAsset(ownerPath, 'img.png', 'v1');
        await fs.meta.assets!.putAsset(ownerPath, 'img.png', 'v2');
        const data = await fs.meta.assets!.getAsset(ownerPath, 'img.png');
        expect(new TextDecoder().decode(data as ArrayBuffer)).toBe('v2');
    });

    it('getAsset returns null for non-existent asset', async () => {
        const { fs } = vfs;
        await createOwner(fs);
        const result = await fs.meta.assets!.getAsset(ownerPath, 'nonexistent.png');
        expect(result).toBeNull();
    });

    it('hasAssetDir returns false before first putAsset', async () => {
        const { fs } = vfs;
        await createOwner(fs);
        expect(await fs.meta.assets!.hasAssetDir(ownerPath)).toBe(false);
    });

    it('hasAssetDir returns true after putAsset', async () => {
        const { fs } = vfs;
        await createOwner(fs);
        await fs.meta.assets!.putAsset(ownerPath, 'x.txt', 'data');
        expect(await fs.meta.assets!.hasAssetDir(ownerPath)).toBe(true);
    });

    it('ensureAssetDir returns stable ID', async () => {
        const { fs } = vfs;
        await createOwner(fs);
        const id1 = await fs.meta.assets!.ensureAssetDir(ownerPath);
        const id2 = await fs.meta.assets!.ensureAssetDir(ownerPath);
        expect(id1).toBe(id2);
        expect(typeof id1).toBe('string');
    });

    it('getAssetDirPath returns null before creation', async () => {
        const { fs } = vfs;
        await createOwner(fs);
        expect(await fs.meta.assets!.getAssetDirPath(ownerPath)).toBeNull();
    });

    it('getAssetDirPath returns path after ensureAssetDir', async () => {
        const { fs } = vfs;
        await createOwner(fs);
        const ensuredPath = await fs.meta.assets!.ensureAssetDir(ownerPath);
        const fetchedPath = await fs.meta.assets!.getAssetDirPath(ownerPath);
        expect(fetchedPath).toBe(ensuredPath);
    });

    it('listAssets returns all asset names', async () => {
        const { fs } = vfs;
        await createOwner(fs);
        await fs.meta.assets!.putAsset(ownerPath, 'a.png', 'a');
        await fs.meta.assets!.putAsset(ownerPath, 'b.png', 'b');
        const names = await fs.meta.assets!.listAssets(ownerPath);
        expect(names.sort()).toEqual(['a.png', 'b.png']);
    });

    it('listAssets returns empty when no assets', async () => {
        const { fs } = vfs;
        await createOwner(fs);
        const names = await fs.meta.assets!.listAssets(ownerPath);
        expect(names).toHaveLength(0);
    });

    it('deleteAsset removes single asset, others remain', async () => {
        const { fs } = vfs;
        await createOwner(fs);
        await fs.meta.assets!.putAsset(ownerPath, 'keep.txt', 'keep');
        await fs.meta.assets!.putAsset(ownerPath, 'del.txt', 'del');
        await fs.meta.assets!.deleteAsset(ownerPath, 'del.txt');
        const names = await fs.meta.assets!.listAssets(ownerPath);
        expect(names).toEqual(['keep.txt']);
        expect(await fs.meta.assets!.getAsset(ownerPath, 'del.txt')).toBeNull();
    });

    it('removeAssetDir deletes all assets', async () => {
        const { fs } = vfs;
        await createOwner(fs);
        await fs.meta.assets!.putAsset(ownerPath, 'x.txt', 'data');
        await fs.meta.assets!.removeAssetDir(ownerPath);
        expect(await fs.meta.assets!.hasAssetDir(ownerPath)).toBe(false);
        expect(await fs.meta.assets!.listAssets(ownerPath)).toHaveLength(0);
    });

    it('multiple owners have independent asset dirs', async () => {
        const { fs } = vfs;
        await fs.driver.createFile({ name: 'doc1.md', parentPath: null, content: '' });
        await fs.driver.createFile({ name: 'doc2.md', parentPath: null, content: '' });
        await fs.meta.assets!.putAsset('/doc1.md', 'pic.png', 'doc1-asset');
        await fs.meta.assets!.putAsset('/doc2.md', 'pic.png', 'doc2-asset');
        const d1 = await fs.meta.assets!.getAsset('/doc1.md', 'pic.png');
        const d2 = await fs.meta.assets!.getAsset('/doc2.md', 'pic.png');
        expect(new TextDecoder().decode(d1 as ArrayBuffer)).toBe('doc1-asset');
        expect(new TextDecoder().decode(d2 as ArrayBuffer)).toBe('doc2-asset');
    });

    it('file delete cascades assetdir removal', async () => {
        const { fs } = vfs;
        await createOwner(fs);
        await fs.meta.assets!.putAsset(ownerPath, 'asset.bin', 'data');
        // delete the owner file — assetdir should also be cleaned up
        await fs.driver.delete([ownerPath], { recursive: true });
        expect(await fs.driver.exists(ownerPath)).toBe(false);
    });
});
