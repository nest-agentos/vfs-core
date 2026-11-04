/**
 * @file packages/vfs-core/src/impl/factory.ts
 * @desc VFS 工厂
 */

import type {
    VFSFactoryOptions,
    VFSInstance,
} from '../protocol';

import { VFSEngine } from './engine/vfs-engine';
import { VFSManager } from './services/VFSManager';
import { ConfigService } from './services/ConfigService';
import { nullDevice, zeroDevice, randomDevice } from './devices';

export async function createVFS(options: VFSFactoryOptions): Promise<VFSInstance> {
    const engine = new VFSEngine(options.rootBackend);
    if (options.filenamePattern) {
        engine.setFilenamePattern(options.filenamePattern);
    }

    // Register user plugins (before init)
    if (options.plugins) {
        for (const plugin of options.plugins) {
            engine.plugins.register(plugin);
        }
    }

    // Create manager and initialize (bootstraps /dev/ directory)
    const manager = new VFSManager(engine);
    // Wire the mount router into the engine so all path-based operations
    // route to the correct backend (e.g. LocalFSBackend for /module/home).
    engine.setMountRouter(manager.mounts.router);
    try {
        await manager.initialize();

        // Register built-in devices → creates /dev/null, /dev/zero, /dev/random
        await manager.registerDevice(nullDevice);
        await manager.registerDevice(zeroDevice);
        await manager.registerDevice(randomDevice);

        // Register user devices → creates /dev/<handlerId> for each
        if (options.devices) {
            for (const device of options.devices) {
                await manager.registerDevice(device);
            }
        }

        // Mount additional backends: independent backends prepare together, registration keeps
        // the declared order (and therefore mount ids and listMounts order).
        if (options.additionalMounts) {
            await manager.mounts.mountBackends(options.additionalMounts.map(mount => ({
                path: mount.path, backend: mount.backend, options: mount.options,
            })));
        }

        // Create config service
        const configFiles = await manager.openFileSystem('/etc');
        const config = new ConfigService(() => configFiles);

        // Write initial configs (only if not already present)
        if (options.initialConfigs) {
            for (const [configName, entries] of Object.entries(options.initialConfigs)) {
                const existing = await config.getAll(configName);
                if (Object.keys(existing).length === 0) {
                    await config.setBatch(configName, entries);
                }
            }
        }

        return { manager, config };
    } catch (error) {
        try { await manager.dispose(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Filesystem startup and cleanup failed'); }
        throw error;
    }
}
