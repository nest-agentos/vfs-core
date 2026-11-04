/**
 * @file packages/vfs-core/src/impl/capabilities/RefOps.ts
 * @desc 双向引用能力实现。依赖 EnginePort 而非 DirectoryFS 具体类。
 */

import type {
    IRefOperations,
    RefQueryOptions,
    Reference,
    RefType,
    RecordValue,
    IRecordStore,
} from '../../protocol';
import { FSError } from '../../protocol';
import type { EnginePort } from './EnginePort';

const OUT_REF_PREFIX = '__vfs_ref_out__:';
const IN_REF_PREFIX = '__vfs_ref_in__:';

interface RefInput {
    targetPath: string;
    refType: RefType;
    extra?: Record<string, unknown>;
}

function refField(prefix: string, refType: RefType, path: string): string {
    return prefix + refType + ':' + encodeURIComponent(path);
}

function isRefType(value: unknown): value is RefType {
    return value === 'mention'
        || value === 'depend'
        || value === 'related'
        || value === 'embed';
}

function parseReference(value: RecordValue): Reference | null {
    if (typeof value !== 'string') return null;
    try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const ref = parsed as Record<string, unknown>;
        if (typeof ref.sourcePath !== 'string' || typeof ref.targetPath !== 'string') return null;
        if (!isRefType(ref.refType) || typeof ref.createdAt !== 'number') return null;
        const extra = typeof ref.extra === 'object' && ref.extra !== null
            ? ref.extra as Record<string, unknown>
            : undefined;
        return {
            sourcePath: ref.sourcePath,
            targetPath: ref.targetPath,
            refType: ref.refType,
            createdAt: ref.createdAt,
            extra,
        };
    } catch {
        return null;
    }
}

export class RefOps implements IRefOperations {
    constructor(
        private readonly fs: EnginePort,
        private readonly records: IRecordStore,
    ) {}

    async addRef(
        sourcePath: string,
        targetPath: string,
        refType: RefType,
        extra?: Record<string, unknown>,
    ): Promise<void> {
        const sourceReal = (await this.fs.resolveNode(sourcePath)).realPath;
        const targetReal = (await this.fs.resolveNode(targetPath)).realPath;
        const ref: Reference = { sourcePath, targetPath, refType, createdAt: Date.now(), extra };
        const encoded = JSON.stringify(ref);
        await this.records.setRecordField(sourceReal, refField(OUT_REF_PREFIX, refType, targetPath), encoded);
        await this.records.setRecordField(targetReal, refField(IN_REF_PREFIX, refType, sourcePath), encoded);
    }

    async removeRef(sourcePath: string, targetPath: string, refType: RefType): Promise<void> {
        const sourceReal = (await this.fs.resolveNode(sourcePath)).realPath;
        const targetReal = (await this.fs.resolveNode(targetPath)).realPath;
        await this.records.deleteRecordField(sourceReal, refField(OUT_REF_PREFIX, refType, targetPath));
        await this.records.deleteRecordField(targetReal, refField(IN_REF_PREFIX, refType, sourcePath));
    }

    walkOutgoing(
        path: string,
        callback: (ref: Reference) => boolean | Promise<boolean>,
        opts?: RefQueryOptions,
    ): Promise<number> {
        return this.walk(path, OUT_REF_PREFIX, callback, opts);
    }

    walkIncoming(
        path: string,
        callback: (ref: Reference) => boolean | Promise<boolean>,
        opts?: RefQueryOptions,
    ): Promise<number> {
        return this.walk(path, IN_REF_PREFIX, callback, opts);
    }

    async hasRef(sourcePath: string, targetPath: string, refType: RefType): Promise<boolean> {
        const sourceReal = (await this.fs.resolveNode(sourcePath)).realPath;
        const field = refField(OUT_REF_PREFIX, refType, targetPath);
        return (await this.records.getRecordField(sourceReal, field)) !== undefined;
    }

    async syncOutgoing(sourcePath: string, refs: RefInput[]): Promise<void> {
        const existing: Reference[] = [];
        await this.walkOutgoing(sourcePath, ref => {
            existing.push(ref);
            return true;
        });
        await Promise.all(existing.map(
            ref => this.removeRef(sourcePath, ref.targetPath, ref.refType),
        ));
        for (const ref of refs) {
            const targetPath = ref.targetPath;
            if (!targetPath) throw new FSError('EINVAL', 'reference target path is required', 'syncOutgoing');
            await this.addRef(sourcePath, targetPath, ref.refType, ref.extra);
        }
    }

    private async walk(
        path: string,
        prefix: string,
        callback: (ref: Reference) => boolean | Promise<boolean>,
        opts?: RefQueryOptions,
    ): Promise<number> {
        const realPath = (await this.fs.resolveNode(path)).realPath;
        const refs: Reference[] = [];
        await this.records.walkRecordFields(realPath, (_field, value) => {
            const ref = parseReference(value);
            if (ref && (!opts?.refTypes || opts.refTypes.includes(ref.refType))) refs.push(ref);
            return true;
        }, { prefix });
        return this.dispatch(refs, callback, opts);
    }

    private async dispatch(
        refs: Reference[],
        callback: (ref: Reference) => boolean | Promise<boolean>,
        opts?: RefQueryOptions,
    ): Promise<number> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? refs.length;
        let processed = 0;
        for (const ref of refs.slice(offset, offset + limit)) {
            processed++;
            if (!(await callback(ref))) break;
        }
        return processed;
    }
}
