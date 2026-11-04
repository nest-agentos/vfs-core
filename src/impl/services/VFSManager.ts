/** Trusted filesystem host. Applications receive only opened file contexts. */
import type { IVFSManager, IFileSystem, IDeviceDriver, IMountService, IDeviceManager, IPluginManager, ISystemAccess, FileContent } from '../../protocol';
import { FSError, FSAlreadyExistsError } from '../../protocol';
import { DeviceHandle } from '../devices/DeviceHandle';
import { VFSEngine } from '../engine/vfs-engine';
import { DirectoryFS } from './DirectoryFS';
import { MountService } from './MountService';
import { createFileSystemView, type FileSystemView } from './FileSystemView';
import * as P from '../../utils/path';

export class VFSManager implements IVFSManager {
    private readonly directories = new Map<string, Promise<FileSystemView>>();
    private closing = false;
    private disposal?: Promise<void>;

    async openFileSystem(rootPath: string): Promise<IFileSystem> {
        if (this.closing || !this.initialized) throw new FSError('EACCES', 'Filesystem host is not active');
        if (!rootPath.startsWith('/') || /[\\\0]/.test(rootPath) || rootPath.split('/').includes('..')) {
            throw new FSError('EINVAL', 'Invalid filesystem root');
        }
        rootPath = P.normalize(rootPath);
        let pending = this.directories.get(rootPath);
        if (!pending) {
            const root = rootPath;
            pending = (async () => {
                await this.engine.ensureDirectoryPath(root);
                const directory = new DirectoryFS({
                    viewId: `directory:${root}`, rootRealPath: root,
                    engine: this.engine, eventBus: this.engine.events, plugins: this.engine.plugins,
                    devices: this.engine.devices,
                });
                await directory.init();
                return createFileSystemView({ viewId: `directory:${root}`,
                    mounts: [{ mountId: 'directory', at: '/', fs: directory, access: 'rw' }] });
            })();
            this.directories.set(root, pending);
            void pending.catch(() => { if (this.directories.get(root) === pending) this.directories.delete(root); });
        }
        const fs = await pending;
        if (this.closing) throw new FSError('EACCES', 'Filesystem host is closing');
        return fs;
    }
    private readonly engine: VFSEngine;

    readonly mounts: IMountService;
    readonly devices: IDeviceManager;
    readonly plugins: IPluginManager;

    private initialized = false;

    constructor(engine: VFSEngine) {
        this.engine = engine;
        this.devices = engine.devices;
        this.plugins = engine.plugins;
        this.mounts = new MountService(engine);
    }

    // ══════════════════════════════════════════════════════════
    // Lifecycle
    // ══════════════════════════════════════════════════════════

    async initialize(): Promise<void> {
        if (this.closing) throw new FSError('EACCES', 'Filesystem host is closed');
        if (this.initialized) return;
        await this.engine.initialize();
        this.closing = false;
        this.initialized = true;
    }

    dispose(): Promise<void> {
        if (this.disposal) return this.disposal;
        if (!this.initialized) return Promise.resolve();
        this.closing = true;
        this.disposal = this.closeResources();
        return this.disposal;
    }

    private async closeResources(): Promise<void> {
        const directories = await Promise.allSettled(this.directories.values());
        const viewResults = await Promise.allSettled(directories.flatMap(result => result.status === 'fulfilled' ? [result.value.dispose()] : []));
        this.directories.clear();
        const backends = [...new Set(this.mounts.listMounts().map(mount => mount.backend))]
            .filter(backend => backend !== this.engine.getBackend());
        const results = await Promise.allSettled([
            this.engine.dispose(), ...backends.map(backend => backend.close()),
        ]);
        this.initialized = false;
        const failures = [...viewResults, ...results].flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, 'Filesystem host cleanup failed');
    }

    /**
     * 注册设备驱动并在 /dev/<handlerId> 创建对应的设备文件节点（幂等）。
     *
     * 等同于 `devices.register(driver)` + 在 VFS 文件树中创建 FSDeviceNode，
     * 之后可通过路径访问：`engine.openDevice('/dev/llm', opts)`。
     */
    /** Device capability belongs to the trusted host, never a file view. */
    async openDevice(path: string, options?: Record<string, unknown>): Promise<import('../../protocol').IDeviceHandle> {
        if (this.closing || !this.initialized) throw new FSError('EACCES', 'Filesystem host is not active');
        if (!path.startsWith('/dev/') || path.split('/').includes('..') || /[\\\0]/.test(path)) throw new FSError('EINVAL', 'Invalid device path');
        const node = await this.engine.stat(path);
        if (node.type !== 'device' || !node.deviceHandlerId) throw new FSError('ENOTTY', 'Not a device');
        const driver = this.devices.get(node.deviceHandlerId);
        const context: import('../../protocol').DeviceContext = {
            nodeId: node.path, name: node.name, metadata: node.metadata, systemAccess: this.createSystemAccess(),
        };
        if (driver.sessionable && driver.open) context.sessionId = await driver.open(context, options);
        return new DeviceHandle(driver, context);
    }

    async registerDevice(driver: IDeviceDriver): Promise<void> {
        this.devices.register(driver);

        try {
            await this.engine.createFile(
                '/dev',
                driver.handlerId,
                'device',
                undefined,
                undefined,
                { deviceHandlerId: driver.handlerId },
            );
        } catch (e) {
            // 幂等：文件已存在时忽略
            if (!(e instanceof FSAlreadyExistsError)) throw e;
        }
    }

    async ensureSystemDirectory(path: string): Promise<void> {
        const lastSlash = path.lastIndexOf('/');
        const parentPath = path.slice(0, lastSlash) || '/';
        const name = path.slice(lastSlash + 1);
        try {
            await this.engine.createFile(parentPath, name, 'directory', undefined, undefined, { recursive: true });
        } catch (e) {
            if (!(e instanceof FSAlreadyExistsError)) throw e;
        }
    }

    async createDeviceNode(
        handlerId: string,
        devPath: string,
        nodeMetadata?: Record<string, unknown>,
    ): Promise<void> {
        const lastSlash = devPath.lastIndexOf('/');
        const parentPath = devPath.slice(0, lastSlash) || '/';
        const name = devPath.slice(lastSlash + 1);
        try {
            await this.engine.createFile(
                parentPath,
                name,
                'device',
                undefined,
                nodeMetadata,
                { deviceHandlerId: handlerId, recursive: true },
            );
        } catch (e) {
            // 幂等：文件已存在时忽略
            if (!(e instanceof FSAlreadyExistsError)) throw e;
        }
    }

    async removeDeviceNode(devPath: string): Promise<void> {
        try {
            await this.engine.delete(devPath);
        } catch {
            // Node doesn't exist — ignore silently
        }
    }

    private createSystemAccess(): ISystemAccess {
        const engine = this.engine;
        const etcRoot = '/etc';
        return {
            async readEtc(relativePath: string): Promise<string> {
                const clean = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
                const fullPath = clean ? P.join(etcRoot, clean) : etcRoot;
                return engine.readEtcFile(fullPath);
            },
            async writeEtc(relativePath: string, content: string): Promise<void> {
                const clean = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
                const fullPath = P.join(etcRoot, clean);
                const parentDir = P.dirname(fullPath);
                await engine.ensureDirectoryPath(parentDir);
                await engine.writeEtcFile(fullPath, content);
            },
            async listEtc(relativePath?: string): Promise<string[]> {
                const fullPath = relativePath ? P.join(etcRoot, relativePath) : etcRoot;
                return engine.listEtcDir(fullPath);
            },
            async deleteEtc(relativePath: string): Promise<void> {
                const clean = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
                const fullPath = P.join(etcRoot, clean);
                try {
                    await engine.delete(fullPath, { force: true });
                } catch { /* file may not exist */ }
            },
        };
    }

    async readBySystemPath(path: string): Promise<FileContent> { return this.engine.readBySystemPath(path); }
    /** Snapshot of engine operation counters for host diagnostics. */
    get ioStats(): Readonly<Record<import('../../protocol').IOOperation, number>> { return { ...this.engine.ioStats }; }
    resetIOStats(): void { this.engine.resetIOStats(); }
    get _engine(): VFSEngine { return this.engine; }
}
