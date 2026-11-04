/**
 * @file packages/vfslib/src/utils/path.ts
 * @desc 路径处理工具 — VFS 内部所有路径操作的唯一入口
 */

const SEP = '/';

export function normalize(path: string): string {
    if (!path || path === SEP) return SEP;
    const parts = path.split(SEP);
    const stack: string[] = [];
    for (const p of parts) {
        if (p === '' || p === '.') continue;
        if (p === '..') { stack.pop(); }
        else { stack.push(p); }
    }
    return SEP + stack.join(SEP);
}

export function dirname(path: string): string {
    const n = normalize(path);
    if (n === SEP) return SEP;
    const i = n.lastIndexOf(SEP);
    return i === 0 ? SEP : n.slice(0, i);
}

export function basename(path: string): string {
    const n = normalize(path);
    if (n === SEP) return '';
    return n.slice(n.lastIndexOf(SEP) + 1);
}

export function join(...parts: string[]): string {
    return normalize(parts.join(SEP));
}

export function segments(path: string): string[] {
    const n = normalize(path);
    return n === SEP ? [] : n.slice(1).split(SEP);
}

export function isUnder(path: string, prefix: string): boolean {
    const np = normalize(path);
    const npx = normalize(prefix);
    if (npx === SEP) return true;
    return np === npx || np.startsWith(npx + SEP);
}

export function relative(from: string, to: string): string {
    const nf = normalize(from);
    const nt = normalize(to);
    if (nf === nt) return '';
    const pfx = nf === SEP ? SEP : nf + SEP;
    return nt.startsWith(pfx) ? nt.slice(pfx.length) : nt;
}

export function isRoot(path: string): boolean {
    return normalize(path) === SEP;
}

export function depth(path: string): number {
    return segments(path).length;
}
