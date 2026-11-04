/**
 * @file packages/vfs-core/src/impl/capabilities/AssetOps.ts
 * @desc AssetDir 能力实现。依赖 EnginePort 而非 DirectoryFS 具体类。
 */

import type { IAssetOperations, FSNode, FileContent } from '../../protocol';
import { toBuffer } from '../../utils/encoding';
import type { EnginePort } from './EnginePort';

export class AssetOps implements IAssetOperations {
    constructor(private readonly fs: EnginePort) {}

    private _engine() { return this.fs.engine; }

    async putAsset(ownerIdOrPath: string, assetName: string, content: FileContent): Promise<FSNode> {
        const { realPath } = await this.fs.resolveNode(ownerIdOrPath);
        const assetDir = await this.fs.engine.ensureAssetDir(realPath);
        const buf = toBuffer(content);
        // Asset files are internal — write via the engine directly so we do NOT
        // emit public node events or run the plugin pipeline.
        const node = await this.fs.engine.createFile(assetDir, assetName, 'file', buf, undefined, { overwrite: true });
        return this.fs.toVirtualNode(node);
    }

    async getAsset(ownerIdOrPath: string, assetName: string): Promise<FileContent | null> {
        try {
            const { realPath } = await this.fs.resolveNode(ownerIdOrPath);
            const assetDir = await this._engine().getAssetDirPath(realPath);
            if (!assetDir) return null;
            const assetPath = assetDir + '/' + assetName;
            const data = await this._engine().readContent(assetPath);
            return data;
        } catch { return null; }
    }

    async getAssetDirPath(ownerPath: string): Promise<string | null> {
        try {
            const { realPath } = await this.fs.resolveNode(ownerPath);
            const assetDir = await this._engine().getAssetDirPath(realPath);
            return assetDir ? this.fs.toVirtualPath(assetDir) : null;
        } catch { return null; }
    }

    async ensureAssetDir(ownerIdOrPath: string): Promise<string> {
        const { realPath } = await this.fs.resolveNode(ownerIdOrPath);
        const assetDir = await this._engine().ensureAssetDir(realPath);
        return this.fs.toVirtualPath(assetDir);
    }

    async listAssets(ownerIdOrPath: string): Promise<string[]> {
        try {
            const { realPath } = await this.fs.resolveNode(ownerIdOrPath);
            const assetPath = await this._engine().getAssetDirPath(realPath);
            if (!assetPath) return [];
            const children = await this._engine().listChildren(assetPath);
            return children.map(c => c.name);
        } catch { return []; }
    }

    async deleteAsset(ownerIdOrPath: string, assetName: string): Promise<void> {
        const { realPath } = await this.fs.resolveNode(ownerIdOrPath);
        const assetDir = await this._engine().getAssetDirPath(realPath);
        if (!assetDir) return;
        const assetPath = assetDir + '/' + assetName;
        await this._engine().delete(assetPath);
    }

    async removeAssetDir(ownerIdOrPath: string): Promise<void> {
        const { realPath } = await this.fs.resolveNode(ownerIdOrPath);
        const assetPath = await this._engine().getAssetDirPath(realPath);
        if (assetPath) await this._engine().delete(assetPath, { recursive: true });
    }

    async hasAssetDir(ownerIdOrPath: string): Promise<boolean> {
        const dirPath = await this.getAssetDirPath(ownerIdOrPath);
        return dirPath !== null;
    }
}
