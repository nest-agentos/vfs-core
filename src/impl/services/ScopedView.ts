import * as P from '../../utils/path';
import { FSError } from '../../protocol';

/** One explicit directory mapping. Composition and permissions belong to FileSystemView. */
export class ScopedView {
    readonly root: string;
    constructor(rootPath: string) {
        this.root = absolute(rootPath);
    }
    toRealPath(path: string): string {
        return P.join(this.root, P.relative('/', absolute(path)));
    }
    toVirtualPath(path: string): string {
        const real = absolute(path);
        if (!P.isUnder(real, this.root)) throw new FSError('EACCES', 'Path is outside the directory root');
        return P.join('/', P.relative(this.root, real));
    }
}
function absolute(path: string): string {
    if (!path.startsWith('/') || /[\\\0]/.test(path) || path.split('/').includes('..')) throw new FSError('EINVAL', 'Invalid directory path');
    return P.normalize(path);
}
