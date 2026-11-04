/**
 * @file packages/vfs-core/src/interfaces/core/errors.ts
 * @desc VFS 错误体系
 *
 * 设计：
 * - POSIX 风格错误码
 * - 类型化子类（消费方可 catch 特定类型）
 * - 每个错误携带操作上下文
 */

export type FSErrorCode =
    | 'ECANCELLED'
    | 'ETIMEDOUT'
    | 'ENOENT'
    | 'EEXIST'
    | 'EISDIR'
    | 'ENOTDIR'
    | 'ENOTEMPTY'
    | 'EACCES'
    | 'EROFS'
    | 'ENOSPC'
    | 'ENOTTY'
    | 'EINVAL'
    | 'ELOOP'
    | 'EFBIG'
    | 'EIO'
    | 'EPLUGIN'
    | 'ENOTRECORD'
    | 'ECAPABILITY'
    | 'ECONFLICT'
    | 'EBUSY'
    | 'EXMOUNT'
    | 'ERESERVED'
    | 'ETYPEMISMATCH'
    | 'EDEVNOTFOUND'
    | 'EFROZEN'
    | 'EINTERNAL';

export class FSError extends Error {
    constructor(
        public readonly code: FSErrorCode,
        message: string,
        public readonly operation?: string,
        public readonly path?: string,
        public readonly cause?: Error,
    ) {
        super(
            path
                ? `[${code}] ${operation ?? 'fs'} "${path}": ${message}`
                : `[${code}] ${operation ?? 'fs'}: ${message}`,
        );
        this.name = 'FSError';
    }
}

export class FSNotFoundError extends FSError {
    constructor(path: string, operation?: string) {
        super('ENOENT', `not found: ${path}`, operation, path);
        this.name = 'FSNotFoundError';
    }
}

export class FSAlreadyExistsError extends FSError {
    constructor(path: string, operation?: string) {
        super('EEXIST', `already exists: ${path}`, operation, path);
        this.name = 'FSAlreadyExistsError';
    }
}

export class FSAccessDeniedError extends FSError {
    constructor(path: string, operation?: string, detail?: string) {
        super('EACCES', detail ?? 'permission denied', operation, path);
        this.name = 'FSAccessDeniedError';
    }
}

export class FSReadOnlyError extends FSError {
    constructor(path?: string, operation?: string) {
        super('EROFS', 'read-only filesystem', operation, path);
        this.name = 'FSReadOnlyError';
    }
}

export class FSReservedNameError extends FSError {
    constructor(name: string) {
        super('ERESERVED', 'filename must not start with . or _', 'create', name);
        this.name = 'FSReservedNameError';
    }
}

export class FSCapabilityError extends FSError {
    constructor(capability: string, viewId?: string) {
        super(
            'ECAPABILITY',
            `capability '${capability}' not supported${viewId ? ` by view '${viewId}'` : ''}`,
        );
        this.name = 'FSCapabilityError';
    }
}

export class FSConflictError extends FSError {
    constructor(
        path: string,
        public readonly expectedVersion: number,
        public readonly actualVersion: number,
    ) {
        super(
            'ECONFLICT',
            `version conflict: expected ${expectedVersion}, actual ${actualVersion}`,
            'write',
            path,
        );
        this.name = 'FSConflictError';
    }
}

export class FSInvalidPathError extends FSError {
    constructor(path: string, reason?: string) {
        super(
            'EINVAL',
            `invalid path '${path}'${reason ? ': ' + reason : ''}`,
            undefined,
            path,
        );
        this.name = 'FSInvalidPathError';
    }
}

export class FSSymlinkLoopError extends FSError {
    constructor(path: string) {
        super('ELOOP', 'too many levels of symbolic links', 'resolve', path);
        this.name = 'FSSymlinkLoopError';
    }
}

export class FSCrossMountError extends FSError {
    constructor(srcPath: string, destPath: string) {
        super(
            'EXMOUNT',
            `cross - mount operation denied: ${srcPath} → ${destPath} `,
            'move',
            srcPath,
        );
        this.name = 'FSCrossMountError';
    }
}

export class FSBusyError extends FSError {
    constructor(path: string, detail?: string) {
        super('EBUSY', detail ?? 'resource busy', undefined, path);
        this.name = 'FSBusyError';
    }
}

export class FSTypeMismatchError extends FSError {
    constructor(path: string, expectedType: string, actualType: string) {
        super(
            'ETYPEMISMATCH',
            `expected type '${expectedType}', got '${actualType}'`,
            undefined,
            path,
        );
        this.name = 'FSTypeMismatchError';
    }
}

export class FSDeviceNotFoundError extends FSError {
    constructor(handlerId: string) {
        super('EDEVNOTFOUND', `device driver '${handlerId}' not found`);
        this.name = 'FSDeviceNotFoundError';
    }
}

export class FSDeviceFrozenError extends FSError {
    constructor(operation?: string) {
        super('EFROZEN', 'device registry is frozen — no new registrations allowed', operation);
        this.name = 'FSDeviceFrozenError';
    }
}
