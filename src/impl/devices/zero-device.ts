/**
 * @file packages/vfs-core/src/impl/devices/zero-device.ts
 */

import type { IDeviceDriver, FileContent } from '../../protocol';

export const zeroDevice: IDeviceDriver = {
    handlerId: 'zero',
    description: 'Returns zero bytes on read',
    writable: false,

    async read(): Promise<FileContent> {
        return new ArrayBuffer(256);
    },

    async write(): Promise<void> {
        throw new Error('/dev/zero is read-only');
    },
};
