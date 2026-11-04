import ignore, { type Ignore } from 'ignore';
import type { FileDiscoverySource } from '../../protocol';
import { dirname, isUnder } from '../../utils/path';

export const DEFAULT_DISCOVERY_EXCLUDES = [
    'node_modules', 'dist', '.git', '.svn', 'build', 'out', 'target',
    '.next', '.nuxt', '.cache', 'coverage', '__pycache__',
] as const;

export interface FileIgnorePolicy { files: readonly string[]; defaults: readonly string[] }
const defaultPolicy: FileIgnorePolicy = { files: ['.gitignore', '.mindosignore'], defaults: DEFAULT_DISCOVERY_EXCLUDES };

interface DirectoryState { root: string; matcher: Ignore; ignored: boolean }

/** Per-search cache: edits to ignore files are visible on the next search. */
export class FileIgnoreFilter {
    private readonly directories = new Map<string, Promise<DirectoryState>>();
    constructor(private readonly source: FileDiscoverySource, private readonly signal?: AbortSignal, private readonly policy: FileIgnorePolicy = defaultPolicy) {}

    async accepts(path: string, directory: boolean): Promise<boolean> {
        this.signal?.throwIfAborted();
        if (directory && path === this.source.rootFor(path)) return true;
        const parent = await this.directory(dirname(path));
        return !parent.ignored && !parent.matcher.ignores(relative(parent.root, path) + (directory ? '/' : ''));
    }

    private directory(path: string): Promise<DirectoryState> {
        let state = this.directories.get(path);
        if (!state) { state = this.loadDirectory(path); this.directories.set(path, state); }
        return state;
    }

    private async loadDirectory(path: string): Promise<DirectoryState> {
        this.signal?.throwIfAborted();
        const root = this.source.rootFor(path);
        if (!isUnder(path, root)) throw new Error('Invalid discovery boundary');
        const parent = path === root ? this.defaults(root) : await this.directory(dirname(path));
        if (parent.ignored || (path !== root && parent.matcher.ignores(relative(root, path) + '/'))) {
            return { ...parent, ignored: true };
        }
        const matcher = ignore({ ignorecase: false }).add(parent.matcher);
        for (const name of this.policy.files) {
            this.signal?.throwIfAborted();
            const text = await this.source.readIgnoreFile(`${path === '/' ? '' : path}/${name}`);
            if (text) matcher.add(scopePatterns(text, relative(root, path)));
        }
        return { root, matcher, ignored: false };
    }

    private defaults(root: string): DirectoryState {
        return { root, ignored: false, matcher: ignore({ ignorecase: false })
            .add(this.policy.defaults.map(name => `${name}/`)) };
    }
}

function relative(root: string, path: string): string {
    return path === root ? '' : path.slice(root === '/' ? 1 : root.length + 1);
}

/** Anchor nested rules at the boundary while keeping gitignore pattern syntax. */
function scopePatterns(text: string, directory: string): string[] {
    if (!directory) return text.split(/\r?\n/);
    const escaped = directory.replace(/[\\*?[\]]/g, '\\$&');
    return text.split(/\r?\n/).map(line => {
        if (!line.trim() || line === '!' || line.startsWith('#')) return '';
        const negative = line.startsWith('!') ? '!' : '';
        const pattern = negative ? line.slice(1) : line;
        const anchored = pattern.startsWith('/') || pattern.replace(/(?<!\\) +$/, '').replace(/\/$/, '').includes('/');
        return `${negative}/${escaped}/${anchored ? '' : '**/'}${pattern.replace(/^\//, '')}`;
    });
}
