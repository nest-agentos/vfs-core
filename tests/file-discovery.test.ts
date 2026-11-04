import { afterEach, expect, it } from 'vitest';
import { createVFS, MemoryBackend, createFileSystemView, createVFSFileDiscoverySource, discoverFiles,
    type IFileSystem, type FileDiscoveryOptions } from '../src';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture(files: Record<string, string>) {
    const { manager } = await createVFS({ rootBackend: new MemoryBackend() });
    cleanups.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/');
    for (const [path, content] of Object.entries(files)) {
        const split = path.lastIndexOf('/');
        await fs.driver.createFile({ name: path.slice(split + 1), parentPath: path.slice(0, split) || '/', content, recursive: true });
    }
    return fs;
}

async function list(fs: IFileSystem, root = '/', options?: FileDiscoveryOptions) {
    const files: string[] = [];
    for await (const node of discoverFiles(createVFSFileDiscoverySource(fs), root, options)) files.push(node.path);
    return files.sort();
}

it('inherits nested rules, anchored patterns, negation and MindOS overrides', async () => {
    const fs = await fixture({
        '/.gitignore': '*.log\n/root-only.txt\nignored/\n!node_modules/\n',
        '/.mindosignore': '!keep.log\nprivate.txt\n',
        '/root-only.txt': '', '/sub/root-only.txt': '', '/keep.log': '', '/drop.log': '', '/private.txt': '',
        '/sub/.gitignore': '/local.txt\n!child.log\n   \n',
        '/sub/local.txt': '', '/sub/deep/local.txt': '', '/sub/child.log': '', '/sub/deep/drop.log': '',
        '/ignored/.gitignore': '!file.txt', '/ignored/file.txt': '', '/node_modules/module.js': '',
    });
    const files = await list(fs);
    expect(files).toEqual(expect.arrayContaining(['/keep.log', '/sub/root-only.txt', '/sub/child.log',
        '/sub/deep/local.txt', '/node_modules/module.js']));
    expect(files).not.toEqual(expect.arrayContaining(['/root-only.txt']));
    expect(files.some(path => /drop\.log|private\.txt|ignored\/|sub\/local\.txt/.test(path))).toBe(false);
    expect(await list(fs, '/sub')).toEqual(files.filter(path => path.startsWith('/sub/')));
    expect(await list(fs, '/ignored')).toEqual([]);
});

it('uses Git-compatible glob, escaping and literal directory names', async () => {
    const fs = await fixture({ '/[pkg]/.gitignore': '# comment\n\\#hidden\n\\!hidden\n**/cache?.[jt]s\nspace\\ \n',
        '/[pkg]/#hidden': '', '/[pkg]/!hidden': '', '/[pkg]/space ': '',
        '/[pkg]/sub/cache1.js': '', '/[pkg]/cache22.js': '', '/[pkg]/good.ts': '', '/p/good.ts': '' });
    expect(await list(fs)).toEqual(['/[pkg]/.gitignore', '/[pkg]/cache22.js', '/[pkg]/good.ts', '/p/good.ts']);
});

it('prunes before enumerating an ignored directory and keeps explicit exclusions', async () => {
    const fs = await fixture({ '/.gitignore': 'cache/\n', '/cache/secret': '', '/node_modules/dep': '', '/keep': '' });
    const children = fs.driver.getChildren.bind(fs.driver);
    fs.driver.getChildren = async path => {
        if (path === '/cache' || path === '/node_modules') throw new Error('Ignored subtree was traversed');
        return children(path, { includeHidden: true });
    };
    expect(await list(fs)).toEqual(['/.gitignore', '/keep']);
    expect(await list(fs, '/', { includeIgnored: true, excludeDirectories: ['cache', 'node_modules'] }))
        .toEqual(['/.gitignore', '/keep']);
});

it('excludes Rust target without an ancestor gitignore inside the granted root', async () => {
    const fs = await fixture({ '/target/debug/huge-binary': 'mdx', '/src/lib.rs': 'mdx' });
    expect(await list(fs)).toEqual(['/src/lib.rs']);
    expect(await list(fs, '/', { includeIgnored: true })).toEqual(['/src/lib.rs', '/target/debug/huge-binary']);
});

it('includeIgnored bypasses filters, rules refresh per search, explicit reads remain available', async () => {
    const fs = await fixture({ '/.gitignore': 'secret.txt', '/secret.txt': 'evidence', '/node_modules/dep': '' });
    expect(await list(fs)).toEqual(['/.gitignore']);
    expect(await list(fs, '/', { includeIgnored: true })).toEqual(['/.gitignore', '/node_modules/dep', '/secret.txt']);
    expect(await fs.driver.readContent('/secret.txt', { encoding: 'utf-8' })).toBe('evidence');
    await fs.driver.writeContent('/.gitignore', '');
    expect(await list(fs)).toContain('/secret.txt');
    expect(await list(fs, '/secret.txt')).toEqual(['/secret.txt']);
});

it('does not inherit rules from another mount or from the host parent of a mounted root', async () => {
    const parent = await fixture({ '/.gitignore': '*.txt', '/secret.txt': '', '/root.txt': '' });
    const a = await fixture({ '/.gitignore': '*.txt', '/a.txt': '' });
    const b = await fixture({ '/.gitignore': '*.log', '/b.txt': '', '/b.log': '' });
    const view = createFileSystemView({ viewId: 'test', mounts: [
        { mountId: 'root', at: '/', fs: parent, access: 'ro' },
        { mountId: 'a', at: '/work', fs: a, access: 'ro' },
        { mountId: 'b', at: '/other', fs: b, access: 'ro' },
    ] });
    cleanups.push(() => view.dispose());
    expect(await list(view)).toEqual(['/.gitignore', '/other/.gitignore', '/other/b.txt', '/work/.gitignore']);
    expect(await list(view, '/other')).toContain('/other/b.txt');
});

it('does not convert cancellation or unreadable rules into successful unfiltered results', async () => {
    const fs = await fixture({ '/.gitignore': '*.txt', '/file.txt': '' });
    const abort = new AbortController(); abort.abort();
    await expect(list(fs, '/', { signal: abort.signal })).rejects.toThrow();
    fs.driver.readContent = async () => { throw new Error('backend offline'); };
    await expect(list(fs)).rejects.toThrow('backend offline');
});


it('preserves boundaries through Session wrappers and mounted source subdirectories', async () => {
    const host = await fixture({ '/.gitignore': '*.txt', '/project/keep.txt': '', '/project/.mindosignore': 'private.txt',
        '/project/private.txt': '' });
    const view = createFileSystemView({ viewId: 'mount', mounts: [
        { mountId: 'workspace', at: '/workspace', fs: host, root: '/project', access: 'ro' },
    ] });
    const wrapper = createFileSystemView({ viewId: 'session', mounts: [
        { mountId: 'session', at: '/', fs: view, access: 'ro' },
    ] });
    cleanups.push(() => view.dispose(), () => wrapper.dispose());
    expect(wrapper.discoveryRoot('/workspace/keep.txt')).toBe('/workspace');
    expect(await list(wrapper, '/workspace')).toEqual(['/workspace/.mindosignore', '/workspace/keep.txt']);
    expect(await list(wrapper, '/workspace', { includeIgnored: true })).toContain('/workspace/private.txt');
    expect(await wrapper.driver.getNode('/project/keep.txt')).toBeNull();
});
