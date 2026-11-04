/**
 * @file packages/vfs-core/src/impl/capabilities/TagOps.ts
 * @desc 标签能力实现。依赖 EnginePort 而非 DirectoryFS 具体类。
 */

import type { ITagOperations, TagDefinition } from '../../protocol';
import type { EnginePort } from './EnginePort';

export class TagOps implements ITagOperations {
    constructor(private readonly fs: EnginePort) {}

    async getAllTags(): Promise<TagDefinition[]> {
        const counts = new Map<string, number>();
        for (const { tag } of await this.listTagEntries()) counts.set(tag, (counts.get(tag) ?? 0) + 1);
        return [...counts].map(([name, refCount]) => ({ name, refCount }));
    }

    async listTagEntries(): Promise<Array<{ path: string; tag: string }>> {
        return (await this.fs.engine.listTagEntries(this.fs.toRealPath('/')))
            .map(entry => ({ ...entry, path: this.fs.toVirtualPath(entry.path) }));
    }

    async setTags(path: string, tags: string[]): Promise<void> {
        const { realPath } = await this.fs.resolveNode(path);
        await this.fs.engine.setTags(realPath, tags);
        this.emitTagUpdate(path);
    }

    async addTag(path: string, tag: string): Promise<void> {
        const { node, realPath } = await this.fs.resolveNode(path);
        const newTags = [...new Set([...node.tags, tag])];
        await this.fs.engine.setTags(realPath, newTags);
        this.emitTagUpdate(path);
    }

    async removeTag(path: string, tag: string): Promise<void> {
        const { node, realPath } = await this.fs.resolveNode(path);
        const newTags = node.tags.filter(t => t !== tag);
        await this.fs.engine.setTags(realPath, newTags);
        this.emitTagUpdate(path);
    }

    private emitTagUpdate(path: string): void {
        this.fs.emit('node:updated', {
            nodes: [{ path, changedFields: ['tags'] }],
            reason: 'tags',
        });
    }

    async walkByTag(tag: string, callback: (path: string) => boolean | Promise<boolean>, options?: { limit?: number; offset?: number }): Promise<{ total: number; processed: number }> {
        const paths = (await this.listTagEntries()).filter(entry => entry.tag === tag).map(entry => entry.path).sort();
        let processed = 0;
        for (const path of paths.slice(options?.offset ?? 0, options?.limit === undefined ? undefined : (options.offset ?? 0) + options.limit)) {
            processed++;
            if (await callback(path) === false) break;
        }
        return { total: paths.length, processed };
    }
}
