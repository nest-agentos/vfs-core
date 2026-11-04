/**
 * @file packages/vfs-core/src/impl/devices/null-device.ts
 */

import type { IDeviceDriver, FileContent } from '../../protocol';

export const nullDevice: IDeviceDriver = {
    handlerId: 'null',
    description: 'Discards all writes, reads return empty',
    writable: true,
    async read(): Promise<FileContent> { return ''; },
    async write(): Promise<void> { /* discard */ },
};
