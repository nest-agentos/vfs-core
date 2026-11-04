/**
 * @file packages/vfslib/src/utils/index.ts
 */

export * as pathUtils from './path';
export * from './validation';
export { generateId } from './id';
export { toBuffer, toString, toUint8Array } from './encoding';
export { guessMimeType } from './guess-mime-type';
export { pipe, type PipeOptions } from './pipe';
export {
    serialize,
    deserialize,
    decodeContent,
} from './serialization';
export type {
    VFSExportManifest,
    VFSExportFileEntry,
    VFSExportAsset,
    VFSEncodedContent,
    SerializeDeps,
} from './serialization';
