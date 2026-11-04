/**
 * @file packages/vfs-core/src/impl/engine/plugin-pipeline.ts
 * @desc Koa 风格中间件管道
 */

import type {
    IPlugin,
    IPluginManager,
    PluginInfo,
    MiddlewareHandler,
    OperationContext,
    FSOperationType,
} from '../../protocol';

export class PluginPipeline implements IPluginManager {
    private readonly plugins = new Map<string, IPlugin>();

    register(plugin: IPlugin): void {
        if (this.plugins.has(plugin.info.name)) {
            throw new Error(`Plugin '${plugin.info.name}' already registered`);
        }
        this.plugins.set(plugin.info.name, plugin);
    }

    unregister(pluginName: string): void {
        this.plugins.delete(pluginName);
    }

    has(pluginName: string): boolean {
        return this.plugins.has(pluginName);
    }

    getInfo(pluginName: string): PluginInfo | null {
        return this.plugins.get(pluginName)?.info ?? null;
    }

    list(): PluginInfo[] {
        return [...this.plugins.values()].map((p) => ({ ...p.info }));
    }

    async execute(
        operation: FSOperationType,
        ctx: OperationContext,
        coreOp: () => Promise<void>,
    ): Promise<void> {
        const handlers = this.collectHandlers(operation);
        await compose(handlers, coreOp)(ctx);
    }

    async initAll(): Promise<void> {
        for (const plugin of this.plugins.values()) {
            await plugin.init?.();
        }
    }

    async disposeAll(): Promise<void> {
        for (const plugin of this.plugins.values()) {
            await plugin.dispose?.();
        }
        this.plugins.clear();
    }

    private collectHandlers(operation: FSOperationType): MiddlewareHandler[] {
        const result: Array<{ priority: number; handler: MiddlewareHandler }> = [];

        for (const plugin of this.plugins.values()) {
            for (const mw of plugin.middleware) {
                const ops = mw.operations;
                if (!ops || ops.length === 0 || ops.includes(operation)) {
                    result.push({
                        priority: mw.priority ?? 100,
                        handler: mw.handler,
                    });
                }
            }
        }

        result.sort((a, b) => a.priority - b.priority);
        return result.map((r) => r.handler);
    }
}

function compose(
    middlewares: MiddlewareHandler[],
    core: () => Promise<void>,
): (ctx: OperationContext) => Promise<void> {
    return (ctx: OperationContext) => {
        let index = -1;

        function dispatch(i: number): Promise<void> {
            if (i <= index) {
                return Promise.reject(new Error('next() called multiple times'));
            }
            index = i;

            if (i === middlewares.length) {
                return core();
            }

            return middlewares[i](ctx, () => dispatch(i + 1));
        }

        return dispatch(0);
    };
}
