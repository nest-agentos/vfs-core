/**
 * @file packages/vfs-core/src/interfaces/IFile.ts
 * @desc Universal file handle — treats a file and its companion assetdir as a single unit.
 *
 * Layer contract:
 *  - High-level ops (read/write/copy/move/delete/rename): fully transparent to callers.
 *  - Low-level raw ops (readRaw/writeRaw): always access the main file's literal bytes,
 *    bypassing any subclass format logic.
 *  - Assetdir access: file.asset("name") returns an AssetObj — a lightweight handle for
 *    files inside the companion assetdir. All internal files, attachments, and config
 *    files use the same uniform API (no readInternal/putAsset distinction).
 *
 * Create via IFileSystem.openFile(path) or a format-specific file factory.
 */
import type { ReadOptions, WriteOptions } from './core/options';
import type { FSNode } from './core/types';
import type { FSEventType, FSEvent } from './core/events';
import type { IIOStream } from './io';

/**
 * Lightweight handle for a sub-file inside the companion assetdir.
 * Does NOT represent a full IFile — no metadata/tags/lifecycle/events.
 */
export interface AssetObj {
    /** File name (relative within assetdir, e.g. "img.png", "msg-001.chat") */
    readonly name: string;

    /** Read content; returns null when the file does not exist */
    read(): Promise<ArrayBuffer | null>;

    /** Read content as UTF-8 text; returns null when the file does not exist */
    readText(): Promise<string | null>;

    /**
     * Write content. Creates the assetdir if it does not exist.
     * @returns Reference string for embedding in documents (e.g. "@asset/img.png")
     */
    write(content: Uint8Array | ArrayBuffer | string): Promise<string>;

    /** Delete this sub-file (no-op when it does not exist) */
    delete(): Promise<void>;

    /** Check whether this sub-file exists */
    exists(): Promise<boolean>;
}

export interface IFile extends IIOStream {
    // ========== Identity ==========
    readonly path: string;
    getName(): Promise<string>;
    getPath(): Promise<string>;
    getNode(): Promise<FSNode>;

    // ========== Metadata ==========
    getIcon(): Promise<string>;
    getTags(): Promise<string[]>;
    setTags(tags: string[]): Promise<void>;

    // ========== High-level content ==========
    read(options?: ReadOptions): Promise<string | ArrayBuffer>;
    write(content: string | ArrayBuffer, options?: WriteOptions): Promise<void>;

    // ========== Lifecycle ==========
    rename(newName: string): Promise<void>;
    copy(destDirNodeId: string, newName?: string): Promise<IFile>;
    move(destDirNodeId: string): Promise<void>;
    delete(): Promise<void>;

    // ========== Low-level: raw main-file access ==========
    readRaw(options?: ReadOptions): Promise<string | ArrayBuffer>;
    writeRaw(content: string | ArrayBuffer, options?: WriteOptions): Promise<void>;

    // ========== Assetdir ==========
    /** Get a handle to a sub-file in the companion assetdir */
    asset(name: string): AssetObj;

    /** List all sub-file names inside the companion assetdir */
    listAssets(): Promise<string[]>;

    /** Returns true when this file has a companion assetdir */
    hasAssetDir(): Promise<boolean>;

    // ========== Events ==========
    on<E extends FSEventType>(event: E, callback: (event: FSEvent<E>) => void): () => void;
}
