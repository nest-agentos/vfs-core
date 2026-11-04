/**
 * @file packages/vfs-core/src/impl/services/DirectoryFS.ts
 * @desc IFileSystem 薄外观 — chroot 隔离文件系统视图（v4.1 path-based）。
 *
 * CRUD 委托 DirectoryDriver；路径/事件/序列化委托 DirectoryContext；
 * seq/ref/asset/tag 能力委托独立的能力类（依赖 EnginePort）。
 */

import type {
    IFileSystem,
    FSEventType,
    FSEvent,
    IAssetOperations,
    ITagOperations,
} from '../../protocol';

import { FileHandle } from '../file-io/File';

import { AssetOps } from '../capabilities/AssetOps';
import { TagOps } from '../capabilities/TagOps';
import { SeqFileOps } from '../capabilities/SeqFileOps';
import { RefOps } from '../capabilities/RefOps';
import { DirectoryContext } from './DirectoryContext';
import { DirectoryDriver } from './DirectoryDriver';

export type { DirectoryFSDeps } from './DirectoryContext';

export class DirectoryFS implements IFileSystem {
    readonly revision = 0;
    async capabilitiesAt(_path: string) { return this.capabilities; }
    readonly viewId: string;
    readonly capabilities: import('../../protocol').FSCapabilities;
    readonly assets: IAssetOperations;
    readonly tags: ITagOperations;
    readonly driver: import('../../protocol').IFSDriver;
    readonly meta: import('../../protocol').IFSMetaDriver;

    private readonly ctx: DirectoryContext;
    private readonly _driver: DirectoryDriver;

    constructor(deps: import('./DirectoryContext').DirectoryFSDeps) {
        this.ctx = new DirectoryContext(deps);
        this.viewId = this.ctx.viewId;
        this.capabilities = this.ctx.capabilities;

        this._driver = new DirectoryDriver(this.ctx);
        this.driver = this._driver;

        this.assets = new AssetOps(this.ctx);
        this._driver.assets = this.assets;
        this.tags = new TagOps(this.ctx);

        const records = this.ctx.records;
        const seq = records ? new SeqFileOps(this.ctx, records) : undefined;
        const refs = records ? new RefOps(this.ctx, records) : undefined;
        this.meta = {
            assets: this.assets,
            tags: this.tags,
            ...(seq ? { seq } : {}),
            ...(refs ? { refs } : {}),
        };
    }

    // ── IFileSystem ─────────────────────────────────────────────────────────────

    openFile(nodeId: string): import('../../protocol').IFile {
        return new FileHandle(this, nodeId);
    }

    async init(): Promise<void> {
        if (this.ctx.initialized) return;
        this.ctx.initialized = true;
    }

    async dispose(): Promise<void> { this.ctx.initialized = false; }

    on<E extends FSEventType>(event: E, callback: (event: FSEvent<E>) => void): () => void {
        return this._driver.on(event, callback);
    }

    onAny(callback: (event: FSEvent) => void): () => void {
        return this._driver.onAny(callback);
    }

}
