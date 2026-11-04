/**
 * @file packages/vfs-core/src/impl/services/config-service.ts
 * @desc IConfigService 实现
 *
 * 配置文件存储在宿主注入的文件来源中（工厂使用 /etc）。
 * 当后端支持 IRecordStore 时使用 seqfile，否则退化为 JSON 文件。
 */

import type {
    IConfigService,
    ConfigFileDescriptor,
    ConfigChangeEvent,
    IFileSystem,
} from '../../protocol';

import { FSNotFoundError } from '../../protocol';

type ChangeHandler = (event: ConfigChangeEvent) => void;

export class ConfigService implements IConfigService {
    private readonly listeners = new Map<string, Set<ChangeHandler>>();
    private readonly cache = new Map<string, Map<string, string>>();

    constructor(private readonly getFS: () => IFileSystem) {}

    private get fs(): IFileSystem {
        return this.getFS();
    }

    async listConfigs(): Promise<ConfigFileDescriptor[]> {
        const children = await this.fs.driver.getChildren('/');
        return children
            .filter(c => c.type === 'seqfile' || c.type === 'file')
            .map(c => ({
                name: c.name.replace(/\.(seq|json)$/, ''),
                description: c.metadata?.description as string | undefined,
            }));
    }

    // ── Read ──

    async get(configName: string, key: string): Promise<string | null> {
        const entries = await this.loadAll(configName);
        return entries.get(key) ?? null;
    }

    async getString(configName: string, key: string, defaultValue: string): Promise<string> {
        return (await this.get(configName, key)) ?? defaultValue;
    }

    async getNumber(configName: string, key: string, defaultValue: number): Promise<number> {
        const val = await this.get(configName, key);
        if (val === null) return defaultValue;
        const num = Number(val);
        return isNaN(num) ? defaultValue : num;
    }

    async getBoolean(configName: string, key: string, defaultValue: boolean): Promise<boolean> {
        const val = await this.get(configName, key);
        if (val === null) return defaultValue;
        return val === 'true' || val === '1' || val === 'yes';
    }

    async getJson<T>(configName: string, key: string, defaultValue: T): Promise<T> {
        const val = await this.get(configName, key);
        if (val === null) return defaultValue;
        try {
            return JSON.parse(val) as T;
        } catch {
            return defaultValue;
        }
    }

    async getAll(configName: string): Promise<Record<string, string>> {
        const entries = await this.loadAll(configName);
        return Object.fromEntries(entries);
    }

    // ── Write ──

    async set(configName: string, key: string, value: string): Promise<void> {
        await this.ensureFile(configName);
        const oldValue = await this.get(configName, key);

        if (this.fs.meta.seq) {
            await this.fs.meta.seq.setEntry(this.seqPath(configName), key, value);
        } else {
            const entries = await this.loadAll(configName);
            entries.set(key, value);
            await this.saveJson(configName, entries);
        }

        this.cache.delete(configName);
        this.notify({ configName, key, oldValue: oldValue ?? undefined, newValue: value });
    }

    async setBatch(configName: string, entries: Record<string, string>): Promise<void> {
        await this.ensureFile(configName);

        if (this.fs.meta.seq) {
            await this.fs.meta.seq.setEntries(this.seqPath(configName), entries);
        } else {
            const current = await this.loadAll(configName);
            for (const [k, v] of Object.entries(entries)) {
                current.set(k, v);
            }
            await this.saveJson(configName, current);
        }

        this.cache.delete(configName);

        for (const [k, v] of Object.entries(entries)) {
            this.notify({ configName, key: k, oldValue: undefined, newValue: v });
        }
    }

    async delete(configName: string, key: string): Promise<void> {
        const oldValue = await this.get(configName, key);

        if (this.fs.meta.seq) {
            try {
                await this.fs.meta.seq.deleteEntry(this.seqPath(configName), key);
            } catch (e) {
                if (e instanceof FSNotFoundError) return;
                throw e;
            }
        } else {
            const entries = await this.loadAll(configName);
            entries.delete(key);
            await this.saveJson(configName, entries);
        }

        this.cache.delete(configName);

        if (oldValue !== null) {
            this.notify({ configName, key, oldValue, newValue: undefined });
        }
    }

    // ── Subscribe ──

    /**
     * 订阅某个 config 的键变更（进程内、高层事件）。
     *
     * 与 FSEventBus 的 node:updated 是不同粒度：此处是 "configName+key+old/new"
     * 的配置语义事件；而底层文件写入还会额外触发文件级 node:updated（总线）。
     * 二者互补，非替代。
     */
    onChange(configName: string, handler: ChangeHandler): () => void {
        let set = this.listeners.get(configName);
        if (!set) {
            set = new Set();
            this.listeners.set(configName, set);
        }
        set.add(handler);
        return () => { set!.delete(handler); };
    }

    // ── Internal ──

    private seqPath(configName: string): string {
        return `/${configName}.seq`;
    }

    private jsonPath(configName: string): string {
        return `/${configName}.json`;
    }

    private async loadAll(configName: string): Promise<Map<string, string>> {
        const cached = this.cache.get(configName);
        if (cached) return new Map(cached);

        const entries = new Map<string, string>();

        // Try seqfile first
        if (this.fs.meta.seq) {
            const path = this.seqPath(configName);
            if (await this.fs.driver.exists(path)) {
                await this.fs.meta.seq.walkEntries(path, (e) => { entries.set(e.key, e.value); return true; });
                this.cache.set(configName, new Map(entries));
                return entries;
            }
        }

        // Fallback: JSON file
        const path = this.jsonPath(configName);
        if (await this.fs.driver.exists(path)) {
            const content = await this.fs.driver.readContent(path, { encoding: 'utf-8', representation: 'bytes' });
            if (typeof content === 'string' && content.length > 0) {
                try {
                    const parsed = JSON.parse(content);
                    for (const [k, v] of Object.entries(parsed)) {
                        entries.set(k, String(v));
                    }
                } catch {
                    // corrupted — return empty
                }
            }
        }

        this.cache.set(configName, new Map(entries));
        return entries;
    }

    private async ensureFile(configName: string): Promise<void> {
        if (this.fs.meta.seq) {
            const path = this.seqPath(configName);
            if (!(await this.fs.driver.exists(path))) {
                await this.fs.driver.createFile({
                    name: `${configName}.seq`,
                    parentPath: null,
                    type: 'seqfile',
                });
            }
        } else {
            const path = this.jsonPath(configName);
            if (!(await this.fs.driver.exists(path))) {
                await this.fs.driver.createFile({
                    name: `${configName}.json`,
                    parentPath: null,
                    content: '{}',
                });
            }
        }
    }

    private async saveJson(configName: string, entries: Map<string, string>): Promise<void> {
        const path = this.jsonPath(configName);
        const obj = Object.fromEntries(entries);
        await this.fs.driver.writeContent(path, JSON.stringify(obj, null, 2));
    }

    private notify(event: ConfigChangeEvent): void {
        const specific = this.listeners.get(event.configName);
        if (specific) {
            for (const h of specific) {
                try { h(event); } catch { /* swallow */ }
            }
        }
        const wildcard = this.listeners.get('*');
        if (wildcard) {
            for (const h of wildcard) {
                try { h(event); } catch { /* swallow */ }
            }
        }
    }
}
