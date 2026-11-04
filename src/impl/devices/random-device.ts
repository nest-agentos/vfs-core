/**
 * @file packages/vfs-core/src/impl/devices/random-device.ts
 */

import type { IDeviceDriver, FileContent } from '../../protocol';

export const randomDevice: IDeviceDriver = {
    handlerId: 'random',
    description: 'Random byte generator',
    writable: false,

    async read(): Promise<FileContent> {
        const buf = new Uint8Array(256);
        if (typeof globalThis.crypto !== 'undefined') {
            globalThis.crypto.getRandomValues(buf);
        } else {
            for (let i = 0; i < buf.length; i++) {
                buf[i] = Math.floor(Math.random() * 256);
            }
        }
        return buf.buffer as ArrayBuffer;
    },

    async write(): Promise<void> {
        throw new Error('/dev/random is read-only');
    },
};
