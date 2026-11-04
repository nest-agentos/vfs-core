/**
 * Tag operations: addTag, removeTag, setTags, findByTag, getAllTags.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupVFS, type TestVFS } from './helpers';

describe('Tag operations (IndexedDB backend)', () => {
    let vfs: TestVFS;
    beforeEach(async () => { vfs = await setupVFS(); });
    afterEach(async () => { await vfs.dispose(); });

    async function mkFile(fs: TestVFS['fs'], name: string) {
        await fs.driver.createFile({ name, parentPath: null, content: '' });
        return `/${name}`;
    }

    it('addTag appends a tag to a node', async () => {
        const { fs } = vfs;
        const p = await mkFile(fs, 'tagged.txt');
        await fs.meta.tags!.addTag(p, 'important');
        const node = await fs.driver.getNode(p);
        expect(node?.tags).toContain('important');
    });

    it('addTag is idempotent', async () => {
        const { fs } = vfs;
        const p = await mkFile(fs, 'idem.txt');
        await fs.meta.tags!.addTag(p, 'same');
        await fs.meta.tags!.addTag(p, 'same');
        const node = await fs.driver.getNode(p);
        expect(node?.tags?.filter(t => t === 'same')).toHaveLength(1);
    });

    it('removeTag removes a specific tag', async () => {
        const { fs } = vfs;
        const p = await mkFile(fs, 'rmtag.txt');
        await fs.meta.tags!.setTags(p, ['a', 'b', 'c']);
        await fs.meta.tags!.removeTag(p, 'b');
        const node = await fs.driver.getNode(p);
        expect(node?.tags).not.toContain('b');
        expect(node?.tags).toContain('a');
        expect(node?.tags).toContain('c');
    });

    it('setTags replaces all tags', async () => {
        const { fs } = vfs;
        const p = await mkFile(fs, 'set.txt');
        await fs.meta.tags!.setTags(p, ['x', 'y']);
        await fs.meta.tags!.setTags(p, ['z']);
        const node = await fs.driver.getNode(p);
        expect(node?.tags).toEqual(['z']);
    });

    it('setTags with empty array clears all tags', async () => {
        const { fs } = vfs;
        const p = await mkFile(fs, 'clear.txt');
        await fs.meta.tags!.setTags(p, ['a', 'b']);
        await fs.meta.tags!.setTags(p, []);
        const node = await fs.driver.getNode(p);
        expect(node?.tags ?? []).toHaveLength(0);
    });

    it('walkByTag returns matching node IDs', async () => {
        const { fs } = vfs;
        const p1 = await mkFile(fs, 'f1.txt');
        const p2 = await mkFile(fs, 'f2.txt');
        await mkFile(fs, 'f3.txt');
        await fs.meta.tags!.addTag(p1, 'vip');
        await fs.meta.tags!.addTag(p2, 'vip');
        const ids: string[] = [];
        await fs.meta.tags!.walkByTag('vip', (id) => { ids.push(id); return true; });
        expect(ids).toHaveLength(2);
    });

    it('walkByTag returns empty for unknown tag', async () => {
        const { fs } = vfs;
        const ids: string[] = [];
        await fs.meta.tags!.walkByTag('nonexistent', (id) => { ids.push(id); return true; });
        expect(ids).toHaveLength(0);
    });

    it('getAllTags aggregates tags across all nodes', async () => {
        const { fs } = vfs;
        const p1 = await mkFile(fs, 'g1.txt');
        const p2 = await mkFile(fs, 'g2.txt');
        await fs.meta.tags!.setTags(p1, ['alpha', 'beta']);
        await fs.meta.tags!.setTags(p2, ['beta', 'gamma']);
        const all = await fs.meta.tags!.getAllTags();
        const names = all.map(t => t.name);
        expect(names).toContain('alpha');
        expect(names).toContain('beta');
        expect(names).toContain('gamma');
    });

    it('tags survive writeContent (not cleared on content update)', async () => {
        const { fs } = vfs;
        const p = await mkFile(fs, 'persist.txt');
        await fs.meta.tags!.addTag(p, 'sticky');
        await fs.driver.writeContent(p, 'new content');
        const node = await fs.driver.getNode(p);
        expect(node?.tags).toContain('sticky');
    });

    it('tags survive rename', async () => {
        const { fs } = vfs;
        await fs.driver.createFile({ name: 'before-rename.txt', parentPath: null, content: '' });
        await fs.meta.tags!.addTag('/before-rename.txt', 'keepme');
        await fs.driver.rename('/before-rename.txt', 'after-rename.txt');
        const node = await fs.driver.getNode('/after-rename.txt');
        expect(node?.tags).toContain('keepme');
    });
});
