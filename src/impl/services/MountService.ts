/**
 * @file packages/vfs-core/src/impl/services/MountService.ts
 * @desc 挂载子服务 + 挂载路由器（最长前缀匹配）。
 *
 * 从 VFSManager 拆分（SRP）：挂载生命周期、路径解析、跨挂载判断。
 */

import type {
    IMountService,
    IMountRouter,
    IStorageBackend,
    MountEntry,
    MountPoint,
    MountOptions,
    PreparedMount,
    ResolvedMount,
} from '../../protocol';
import { FSError } from '../../protocol';
import type { VFSEngine } from '../engine/vfs-engine';
import { detectCapabilities } from '../engine/capabilities';
import * as P from '../../utils/path';

/** Batch mount failures keep every cause (preparation and cleanup) in one error. */
function mountBatchError(errors: unknown[], message: string): unknown {
    return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
}

export class MountService implements IMountService {
    readonly router: IMountRouter;
    private readonly engine: VFSEngine;

    constructor(engine: VFSEngine) {
        this.engine = engine;
        this.router = new InlineMountRouter(engine);
    }

    async mountBackend(
        mountPath: string,
        backend: IStorageBackend,
        options?: MountOptions,
    ): Promise<MountPoint> {
        return this.attach(await this.router.prepare(mountPath, backend, options));
    }

    /**
     * 批量挂载：独立后端的初始化与根校验并发进行，注册仍按声明顺序，
     * 因此挂载点 ID 与 `listMounts()` 顺序保持确定。准备阶段失败时，
     * 本次已准备但未注册的后端会被关闭（`close` 幂等，宿主可再次关闭）。
     */
    async mountBackends(mounts: MountEntry[]): Promise<MountPoint[]> {
        const settled = await Promise.allSettled(mounts.map(mount =>
            this.router.prepare(mount.path, mount.backend, mount.options)));
        const prepared = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
        const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) {
            const cleanup: unknown[] = [];
            for (const mount of prepared) {
                try { await mount.backend.close(); } catch (error) { cleanup.push(error); }
            }
            throw mountBatchError([...failures, ...cleanup], 'Mount batch preparation and cleanup failed');
        }
        const points: MountPoint[] = [];
        const registered = new Set<PreparedMount>();
        try {
            for (const mount of prepared) { points.push(this.attach(mount)); registered.add(mount); }
        } catch (error) {
            const cleanup: unknown[] = [error];
            // Registration keeps declared order, so only the tail can be unprepared;
            // their backends are this call's responsibility, the registered ones stay mounted.
            for (const mount of prepared) {
                if (registered.has(mount)) continue;
                try { await mount.backend.close(); } catch (closeError) { cleanup.push(closeError); }
            }
            throw mountBatchError(cleanup, 'Mount batch registration and cleanup failed');
        }
        return points;
    }

    private attach(prepared: PreparedMount): MountPoint {
        const mount = this.router.register(prepared);
        this.engine.events.emit('mount:added', {
            mountPath: mount.mountPath,
            mountId: mount.mountId,
            label: mount.options.label,
        });
        return mount;
    }

    async unmountBackend(mountPath: string, force?: boolean): Promise<void> {
        const mount = this.router.getMountByPath(mountPath);
        await this.router.unmount(mountPath, force);
        if (mount) {
            this.engine.events.emit('mount:removed', {
                mountPath: mount.mountPath,
                mountId: mount.mountId,
                label: mount.options.label,
            });
        }
    }

    listMounts(): MountPoint[] {
        return this.router.listMounts();
    }

    getMountForPath(absolutePath: string): MountPoint {
        return this.router.resolve(absolutePath).mount;
    }
}

class InlineMountRouter implements IMountRouter {
    private readonly mounts = new Map<string, MountPoint>();
    private nextId = 1;

    constructor(engine: VFSEngine) {
        const backend = engine.getBackend();
        this.mounts.set('/', {
            mountId: 'mount_0',
            mountPath: '/',
            backend,
            options: { label: 'Root' },
            mountedAt: Date.now(),
            capabilities: detectCapabilities(backend, { deviceFiles: true, mount: true }),
        });
    }

    async mount(
        mountPath: string,
        backend: IStorageBackend,
        options?: MountOptions,
    ): Promise<MountPoint> {
        return this.register(await this.prepare(mountPath, backend, options));
    }

    async prepare(
        mountPath: string,
        backend: IStorageBackend,
        options?: MountOptions,
    ): Promise<PreparedMount> {
        const norm = P.normalize(mountPath);
        if (this.mounts.has(norm)) {
            throw new FSError('EEXIST', 'mount already exists: ' + norm, 'mount', norm);
        }

        try {
            await backend.init();
            if (!await backend.stat('/')) await backend.mkdir('/');
        } catch (error) {
            try { await backend.close(); }
            catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Mount initialization and cleanup failed'); }
            throw error;
        }

        return {
            mountPath: norm,
            backend,
            options: options ?? {},
            capabilities: detectCapabilities(backend, {
                readonly: options?.readonly ?? false,
                syncable: options?.syncable ?? false,
            }),
        };
    }

    register(prepared: PreparedMount): MountPoint {
        if (this.mounts.has(prepared.mountPath)) {
            throw new FSError('EEXIST', 'mount already exists: ' + prepared.mountPath, 'mount', prepared.mountPath);
        }

        const mp: MountPoint = {
            mountId: 'mount_' + this.nextId++,
            mountPath: prepared.mountPath,
            backend: prepared.backend,
            options: prepared.options,
            mountedAt: Date.now(),
            capabilities: prepared.capabilities,
        };
        this.mounts.set(prepared.mountPath, mp);
        return mp;
    }

    async unmount(mountPath: string, _force?: boolean): Promise<void> {
        const norm = P.normalize(mountPath);
        if (norm === '/') {
            throw new FSError('EINVAL', 'cannot unmount root', 'unmount', '/');
        }
        const mp = this.mounts.get(norm);
        if (!mp) {
            throw new FSError('ENOENT', 'mount not found: ' + norm, 'unmount', norm);
        }
        await mp.backend.close();
        this.mounts.delete(norm);
    }

    resolve(absolutePath: string): ResolvedMount {
        const norm = P.normalize(absolutePath);
        let bestMatch: MountPoint | null = null;
        let bestLen = 0;

        for (const [path, mp] of this.mounts) {
            if (P.isUnder(norm, path) && path.length > bestLen) {
                bestMatch = mp;
                bestLen = path.length;
            }
        }

        if (!bestMatch) bestMatch = this.mounts.get('/')!;

        const relativePath = bestLen <= 1
            ? norm.slice(1)
            : P.relative(bestMatch.mountPath, norm);

        return { mount: bestMatch, relativePath };
    }

    isCrossMount(srcPath: string, destPath: string): boolean {
        return this.resolve(srcPath).mount.mountId !== this.resolve(destPath).mount.mountId;
    }

    listMounts(): MountPoint[] {
        return Array.from(this.mounts.values());
    }

    getMount(mountId: string): MountPoint | null {
        for (const mp of this.mounts.values()) {
            if (mp.mountId === mountId) return mp;
        }
        return null;
    }

    getMountByPath(mountPath: string): MountPoint | null {
        return this.mounts.get(P.normalize(mountPath)) ?? null;
    }
}
