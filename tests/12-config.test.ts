/**
 * ConfigService: get, set, delete, setBatch, getAll, onChange, type helpers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshMem } from './helpers';
import { createVFS } from '../src/impl/factory';
import type { IVFSManager, IConfigService } from '@itookit/vfs-core';

interface ConfigVFS {
    manager: IVFSManager;
    config: IConfigService;
    dispose: () => Promise<void>;
}

async function setupConfig(): Promise<ConfigVFS> {
    const { manager, config } = await createVFS({
        rootBackend: freshMem(),
    });
    return {
        manager,
        config,
        dispose: () => manager.dispose(),
    };
}

describe('ConfigService (Memory backend)', () => {
    let cv: ConfigVFS;
    beforeEach(async () => { cv = await setupConfig(); });
    afterEach(async () => { await cv.dispose(); });

    it('set and get string value', async () => {
        await cv.config.set('app', 'theme', 'dark');
        expect(await cv.config.get('app', 'theme')).toBe('dark');
    });

    it('get returns null for missing key', async () => {
        expect(await cv.config.get('app', 'nonexistent')).toBeNull();
    });

    it('getString returns default for missing key', async () => {
        expect(await cv.config.getString('app', 'missing', 'default-val')).toBe('default-val');
    });

    it('getNumber parses numeric value', async () => {
        await cv.config.set('app', 'timeout', '30');
        expect(await cv.config.getNumber('app', 'timeout', 0)).toBe(30);
    });

    it('getNumber returns default for non-numeric', async () => {
        await cv.config.set('app', 'bad', 'not-a-number');
        expect(await cv.config.getNumber('app', 'bad', 99)).toBe(99);
    });

    it('getBoolean parses true', async () => {
        await cv.config.set('app', 'enabled', 'true');
        expect(await cv.config.getBoolean('app', 'enabled', false)).toBe(true);
    });

    it('getBoolean parses "1"', async () => {
        await cv.config.set('app', 'flag', '1');
        expect(await cv.config.getBoolean('app', 'flag', false)).toBe(true);
    });

    it('getBoolean returns false for "false"', async () => {
        await cv.config.set('app', 'off', 'false');
        expect(await cv.config.getBoolean('app', 'off', true)).toBe(false);
    });

    it('getJson parses JSON value', async () => {
        await cv.config.set('app', 'colors', JSON.stringify(['red', 'green']));
        const colors = await cv.config.getJson<string[]>('app', 'colors', []);
        expect(colors).toEqual(['red', 'green']);
    });

    it('getJson returns default for invalid JSON', async () => {
        await cv.config.set('app', 'broken', '{invalid');
        const result = await cv.config.getJson('app', 'broken', 'fallback');
        expect(result).toBe('fallback');
    });

    it('setBatch writes multiple keys at once', async () => {
        await cv.config.setBatch('db', { host: 'localhost', port: '5432', name: 'mydb' });
        expect(await cv.config.get('db', 'host')).toBe('localhost');
        expect(await cv.config.get('db', 'port')).toBe('5432');
        expect(await cv.config.get('db', 'name')).toBe('mydb');
    });

    it('getAll returns all key-value pairs in a config', async () => {
        await cv.config.setBatch('all-test', { a: '1', b: '2' });
        const all = await cv.config.getAll('all-test');
        expect(all).toEqual({ a: '1', b: '2' });
    });

    it('getAll returns empty object for non-existent config', async () => {
        const all = await cv.config.getAll('ghost-config');
        expect(all).toEqual({});
    });

    it('delete removes a key', async () => {
        await cv.config.set('del', 'k', 'v');
        await cv.config.delete('del', 'k');
        expect(await cv.config.get('del', 'k')).toBeNull();
    });

    it('set overwrites existing value', async () => {
        await cv.config.set('ow', 'x', 'first');
        await cv.config.set('ow', 'x', 'second');
        expect(await cv.config.get('ow', 'x')).toBe('second');
    });

    it('onChange fires when a key is set', async () => {
        const events: Array<{ key: string; newValue?: string }> = [];
        cv.config.onChange('watch', (e) => events.push({ key: e.key, newValue: e.newValue }));
        await cv.config.set('watch', 'mykey', 'myvalue');
        expect(events).toHaveLength(1);
        expect(events[0].key).toBe('mykey');
        expect(events[0].newValue).toBe('myvalue');
    });

    it('onChange fires when a key is deleted', async () => {
        await cv.config.set('wdel', 'k', 'v');
        const events: Array<{ key: string; newValue?: string }> = [];
        cv.config.onChange('wdel', (e) => events.push({ key: e.key, newValue: e.newValue }));
        await cv.config.delete('wdel', 'k');
        expect(events).toHaveLength(1);
        expect(events[0].newValue).toBeUndefined();
    });

    it('onChange unsubscribe stops receiving events', async () => {
        const events: unknown[] = [];
        const unsub = cv.config.onChange('unsub', (e) => events.push(e));
        await cv.config.set('unsub', 'k', 'v1');
        unsub();
        await cv.config.set('unsub', 'k', 'v2');
        expect(events).toHaveLength(1);
    });

    it('multiple config namespaces are independent', async () => {
        await cv.config.set('ns1', 'key', 'from-ns1');
        await cv.config.set('ns2', 'key', 'from-ns2');
        expect(await cv.config.get('ns1', 'key')).toBe('from-ns1');
        expect(await cv.config.get('ns2', 'key')).toBe('from-ns2');
    });

    it('initialConfigs is seeded at createVFS time', async () => {
        const { manager, config } = await createVFS({
            rootBackend: freshMem(),
            initialConfigs: {
                defaults: { language: 'zh-CN', version: '1.0' },
            },
        });
        try {
            expect(await config.get('defaults', 'language')).toBe('zh-CN');
            expect(await config.get('defaults', 'version')).toBe('1.0');
        } finally {
            await manager.dispose();
        }
    });
});
