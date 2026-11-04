/** Minimal authorized filesystem port for search and file suggestions. */
export interface FileDiscoveryEntry {
    path: string;
    name: string;
    type: string;
    size?: number;
}

export interface FileDiscoverySource {
    list(path: string): Promise<readonly FileDiscoveryEntry[]>;
    stat(path: string): Promise<FileDiscoveryEntry | null>;
    readIgnoreFile(path: string): Promise<string | null>;
    /** Absolute POSIX boundary; rules never inherit across this boundary. */
    rootFor(path: string): string;
}

export interface FileDiscoveryOptions {
    /** Bypass ignore rules and built-in exclusions, without changing access rights. */
    includeIgnored?: boolean;
    /** Explicit caller exclusions still apply when includeIgnored is true. */
    excludeDirectories?: readonly string[];
    signal?: AbortSignal;
}
