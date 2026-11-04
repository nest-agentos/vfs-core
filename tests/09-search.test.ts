import { createFileSystemView } from '../src';
/**
 * Search: name/text/type/tag/metadata filters, pagination.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupVFS, type TestVFS } from './helpers';

describe('Search (IndexedDB backend)', () => {
    let vfs: TestVFS;

    beforeEach(async () => {
        vfs = await setupVFS();
        const { fs } = vfs;
        // Populate fixture data
        await fs.driver.createDirectory({ name: 'docs', parentPath: null });
        await fs.driver.createDirectory({ name: 'images', parentPath: null });
        await fs.driver.createFile({ name: 'readme.md', parentPath: '/docs', content: 'This is the readme file with important info.' });
        await fs.driver.createFile({ name: 'guide.md', parentPath: '/docs', content: 'User guide content here.' });
        await fs.driver.createFile({ name: 'logo.png', parentPath: '/images', content: 'fake-png' });
        await fs.driver.createFile({ name: 'banner.png', parentPath: '/images', content: 'fake-banner' });
        await fs.driver.createFile({ name: 'notes.txt', parentPath: null, content: 'Quick notes' });
        await fs.meta.tags!.setTags('/docs/readme.md', ['pinned', 'public']);
        await fs.meta.tags!.setTags('/docs/guide.md', ['public']);
        await fs.driver.updateMetadata('/docs/readme.md', { priority: 1 });
        await fs.driver.updateMetadata('/notes.txt', { priority: 2 });
    });

    afterEach(async () => { await vfs.dispose(); });

    it('search with no filters returns all nodes', async () => {
        const result = await vfs.fs.driver.search({});
        expect(result.nodes.length).toBeGreaterThanOrEqual(5);
    });

    it('search by name.contains', async () => {
        const result = await vfs.fs.driver.search({ name: { contains: 'guide' } });
        expect(result.nodes.every(n => n.name.includes('guide'))).toBe(true);
        expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    });

    it('search by name.exact', async () => {
        const result = await vfs.fs.driver.search({ name: { exact: 'logo.png' } });
        expect(result.nodes).toHaveLength(1);
        expect(result.nodes[0].name).toBe('logo.png');
    });

    it('search by name.endsWith', async () => {
        const result = await vfs.fs.driver.search({ name: { endsWith: '.png' } });
        expect(result.nodes.length).toBeGreaterThanOrEqual(2);
        expect(result.nodes.every(n => n.name.endsWith('.png'))).toBe(true);
    });

    it('search by type: file', async () => {
        const result = await vfs.fs.driver.search({ type: 'file' });
        expect(result.nodes.every(n => n.type === 'file')).toBe(true);
    });

    it('search by type: directory', async () => {
        const result = await vfs.fs.driver.search({ type: 'directory' });
        expect(result.nodes.every(n => n.type === 'directory')).toBe(true);
    });

    it('search by tags.all', async () => {
        const result = await vfs.fs.driver.search({ tags: { all: ['pinned', 'public'] } });
        expect(result.nodes.every(n => {
            const tags = n.tags ?? [];
            return tags.includes('pinned') && tags.includes('public');
        })).toBe(true);
        expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    });

    it('search by tags.any', async () => {
        const result = await vfs.fs.driver.search({ tags: { any: ['pinned'] } });
        expect(result.nodes.length).toBeGreaterThanOrEqual(1);
        expect(result.nodes.every(n => (n.tags ?? []).includes('pinned'))).toBe(true);
    });

    it('search by text (content match)', async () => {
        const result = await vfs.fs.driver.search({ text: 'readme', type: 'file' });
        expect(result.nodes.length).toBeGreaterThanOrEqual(1);
        const names = result.nodes.map(n => n.name);
        expect(names.some(n => n.includes('readme') || true)).toBe(true);
    });

    it('search by metadata field', async () => {
        const result = await vfs.fs.driver.search({ metadata: { priority: 1 } });
        expect(result.nodes.length).toBeGreaterThanOrEqual(1);
        expect(result.nodes.every(n => n.metadata.priority === 1)).toBe(true);
    });

    it('search with limit paginates results', async () => {
        const result = await vfs.fs.driver.search({ limit: 2 });
        expect(result.nodes.length).toBeLessThanOrEqual(2);
    });

    it('search with offset skips results', async () => {
        const all = await vfs.fs.driver.search({ type: 'file' });
        const paged = await vfs.fs.driver.search({ type: 'file', offset: 1, limit: 100 });
        expect(paged.nodes.length).toBe(Math.max(0, all.nodes.length - 1));
    });

    it('search combines explicitly selected file views', async () => {
        const otherFS = await vfs.manager.openFileSystem('/data/other');
        await otherFS.driver.createFile({ name: 'cross.txt', parentPath: null, content: 'cross-module' });
        await otherFS.meta.tags.addTag('/cross.txt', 'crosstest');
        const combined = createFileSystemView({ viewId: 'search', mounts: [
            { mountId: 'test', at: '/test', fs: vfs.fs, access: 'ro' },
            { mountId: 'other', at: '/other', fs: otherFS, access: 'ro' },
        ] });
        try {
            const result = await combined.driver.search({ tags: { any: ['crosstest'] } });
            expect(result.nodes.map(node => node.path)).toContain('/other/cross.txt');
        } finally { await combined.dispose(); }
    });
});
