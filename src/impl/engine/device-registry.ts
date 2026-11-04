/**
 * @file packages/vfs-core/src/impl/engine/device-registry.ts
 * @desc 设备驱动注册表
 */

import type { IDeviceDriver, IDeviceManager } from '../../protocol';
import { FSDeviceNotFoundError, FSAlreadyExistsError, FSDeviceFrozenError } from '../../protocol';

export class DeviceRegistry implements IDeviceManager {
    private readonly drivers = new Map<string, IDeviceDriver>();
    private _frozen = false;
    private closing?: Promise<void>;
    private readonly readiness = new Map<string, Promise<void>>();

    register(driver: IDeviceDriver): void {
        if (this.closing || this._frozen) throw new FSDeviceFrozenError('register');
        if (this.drivers.has(driver.handlerId)) {
            throw new FSAlreadyExistsError(driver.handlerId, 'device:register');
        }
        this.drivers.set(driver.handlerId, driver);
    }

    unregister(handlerId: string): void {
        if (this.closing || this._frozen) throw new FSDeviceFrozenError('unregister');
        this.drivers.delete(handlerId);
        this.readiness.delete(handlerId);
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

    async ready(path: string): Promise<void> {
        if (this.closing) throw new FSDeviceFrozenError('ready');
        if (path !== '/dev' && !path.startsWith('/dev/')) return;
        const handler = path.split('/')[2];
        const drivers = handler ? [this.drivers.get(handler)] : [...this.drivers.values()];
        await Promise.all(drivers.map(driver => {
            if (!driver?.ready) return;
            let pending = this.readiness.get(driver.handlerId);
            if (!pending) {
                pending = Promise.resolve().then(() => driver.ready!());
                this.readiness.set(driver.handlerId, pending);
            }
            return pending;
        }));
    }

    async initAll(): Promise<void> {
        for (const driver of this.drivers.values()) {
            await driver.init?.();
        }
    }

    disposeAll(): Promise<void> {
        this.closing ??= this.disposeDrivers();
        return this.closing;
    }

    private async disposeDrivers(): Promise<void> {
        await Promise.allSettled(this.readiness.values());
        this.readiness.clear();
        const results = await Promise.allSettled([...this.drivers.values()].map(driver => driver.dispose?.()));
        this.drivers.clear();
        this._frozen = false;
        const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, 'Device cleanup failed');
    }
}
