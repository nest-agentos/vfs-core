/**
 * @file packages/vfs-core/src/interfaces/services/config-service.ts
 * @desc 配置服务接口
 *
 * 从 IVFSManager 剥离，遵循 SRP。
 * 内部依赖 IFileSystem 的 __config 模块实现存储，
 * 但消费方不需要知道底层是 seqfile 还是 JSON。
 */

export interface ConfigFileDescriptor {
    /** 配置文件名（如 'app', 'theme', 'sync'） */
    name: string;
    description?: string;
    readonly?: boolean;
}

export interface ConfigChangeEvent {
    configName: string;
    key: string;
    oldValue?: string;
    newValue?: string;
}

export interface IConfigService {
    listConfigs(): Promise<ConfigFileDescriptor[]>;

    // ── 读取 ──

    get(configName: string, key: string): Promise<string | null>;
    getString(configName: string, key: string, defaultValue: string): Promise<string>;
    getNumber(configName: string, key: string, defaultValue: number): Promise<number>;
    getBoolean(configName: string, key: string, defaultValue: boolean): Promise<boolean>;
    getJson<T>(configName: string, key: string, defaultValue: T): Promise<T>;
    getAll(configName: string): Promise<Record<string, string>>;

    // ── 写入 ──

    set(configName: string, key: string, value: string): Promise<void>;
    setBatch(configName: string, entries: Record<string, string>): Promise<void>;
    delete(configName: string, key: string): Promise<void>;

    // ── 订阅 ──

    onChange(
        configName: string,
        handler: (event: ConfigChangeEvent) => void,
    ): () => void;
}
