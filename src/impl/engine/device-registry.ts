/**
 * @file packages/vfs-core/src/impl/engine/device-registry.ts
 * @desc 设备驱动注册表
 */

import type { IDeviceDriver, IDeviceManager } from '../../protocol';
import { FSDeviceNotFoundError, FSAlreadyExistsError, FSDeviceFrozenError } from '../../protocol';

export class DeviceRegistry implements IDeviceManager {
    private readonly drivers = new Map<string, IDeviceDriver>();
    private _frozen = false;

    register(driver: IDeviceDriver): void {
        if (this._frozen) throw new FSDeviceFrozenError('register');
        if (this.drivers.has(driver.handlerId)) {
            throw new FSAlreadyExistsError(driver.handlerId, 'device:register');
        }
        this.drivers.set(driver.handlerId, driver);
    }

    unregister(handlerId: string): void {
        if (this._frozen) throw new FSDeviceFrozenError('unregister');
        this.drivers.delete(handlerId);
    }

    has(handlerId: string): boolean {
        return this.drivers.has(handlerId);
    }

    get(handlerId: string): IDeviceDriver {
        const driver = this.drivers.get(handlerId);
        if (!driver) {
            throw new FSDeviceNotFoundError(handlerId);
        }
        return driver;
    }

    list(): string[] {
        return [...this.drivers.keys()];
    }

    freeze(): void {
        this._frozen = true;
    }

    isFrozen(): boolean {
        return this._frozen;
    }

    async initAll(): Promise<void> {
        for (const driver of this.drivers.values()) {
            await driver.init?.();
        }
    }

    async disposeAll(): Promise<void> {
        for (const driver of this.drivers.values()) {
            await driver.dispose?.();
        }
        this.drivers.clear();
        this._frozen = false;
    }
}
