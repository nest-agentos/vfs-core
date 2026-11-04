/**
 * @file packages/vfs-core/src/impl/devices/DeviceHandle.ts
 * @desc 设备会话句柄 — 绑定 IDeviceDriver 与 DeviceContext。
 */

import type { IDeviceHandle, DeviceContext, IDeviceDriver, FileContent } from '../../protocol';

export class DeviceHandle implements IDeviceHandle {
    constructor(
        private readonly driver: IDeviceDriver,
        public readonly ctx: DeviceContext,
    ) {}

    read(): Promise<FileContent> { return this.driver.read(this.ctx); }

    write(content: FileContent): Promise<void> {
        if (!this.driver.writable) throw new Error("Device '" + this.driver.handlerId + "' is read-only");
        return this.driver.write(this.ctx, content);
    }

    async *readStream(): AsyncIterable<string | ArrayBuffer> {
        if (!this.driver.readStream) throw new Error("Device '" + this.driver.handlerId + "' is not streamable");
        yield* this.driver.readStream(this.ctx);
    }

    ioctl(command: string | number, arg?: unknown): Promise<unknown> {
        if (!this.driver.ioctl) throw new Error("Device '" + this.driver.handlerId + "' does not support ioctl");
        return this.driver.ioctl(this.ctx, command, arg);
    }

    async close(): Promise<void> { await this.driver.close?.(this.ctx); }
}
