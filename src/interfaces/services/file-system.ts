import type { OperationOptions } from '../core/operation';
import type { FSCapabilities } from '../core/types';
import type { FSEventEmitter } from '../core/events';
import type { IFSDriver } from './fs-driver';
import type { IFSMetaDriver } from './fs-meta-driver';
import type { IFile } from '../IFile';

/** File operations without module identity or access to a global manager. */
export type IFileSystemDriver = IFSDriver;

/** A file consumer owns neither the backing store nor the mount table. */
export interface IFileSystem extends FSEventEmitter {
    readonly viewId: string;
    readonly revision: number;
    /** Conservative capabilities; use capabilitiesAt for heterogeneous views. */
    readonly capabilities: FSCapabilities;
    readonly driver: IFileSystemDriver;
    readonly meta: IFSMetaDriver;
    /**
     * True when this view was opened from a host-owned external directory.
     * Such views never contribute tags to settings, even if their backend
     * happens to report tag capability.
     */
    readonly external?: boolean;
    openFile(path: string): IFile;
    capabilitiesAt(path: string, options?: OperationOptions): Promise<FSCapabilities>;
    /** Rule inheritance boundary in this authorized view (defaults to its root). */
    discoveryRoot?(path: string): string;
}

export interface FileSystemContext {
    readonly fs: IFileSystem;
    readonly cwd: string;
    readonly sessionId?: string;
}

export interface FileSystemContextOwner {
    readonly context: FileSystemContext;
    release(): Promise<void>;
}
