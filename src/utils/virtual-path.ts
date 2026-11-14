import {FSError} from '../protocol';
import * as P from './path';

/** Strict POSIX virtual path. No implicit host paths, URL decoding, or parent traversal. */
export function normalizeVirtualPath(path: string): string {
    if (!path.startsWith('/') || /[\\\0]/.test(path) || path.split('/').includes('..')) {
        throw new FSError('EINVAL', 'Expected an absolute virtual path without parent traversal', 'resolve');
    }
    return P.normalize(path);
}

