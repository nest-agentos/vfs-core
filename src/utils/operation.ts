import { checkOperation, FSOperationCancelledError, FSError, type OperationOptions } from '../protocol';

/** A scope owns its timer/listeners, never the parent signal or a shared transport. */
export function operationScope(options: OperationOptions = {}, lifetime?: AbortSignal) {
    const controller = new AbortController();
    const started = performance.now();
    const parents = [options.signal, lifetime].filter((s): s is AbortSignal => !!s);
    const listeners = parents.map(signal => ({ signal, abort: () => controller.abort(signal.reason) }));
    for (const { signal, abort } of listeners) {
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener('abort', abort, { once: true });
    }
    const budget = options.timeoutMs;
    if (budget !== undefined && (!Number.isFinite(budget) || budget < 0)) {
        for (const { signal, abort } of listeners) signal.removeEventListener('abort', abort);
        throw new FSError('EINVAL', 'Invalid operation timeout');
    }
    const timer = budget === undefined ? undefined : setTimeout(() => controller.abort(new FSOperationCancelledError('not-started', true)), budget);
    if (budget === 0) controller.abort(new FSOperationCancelledError('not-started', true));
    return {
        options: { signal: controller.signal, get timeoutMs() { return budget === undefined ? undefined : Math.max(0, budget - (performance.now() - started)); } },
        remaining: () => budget === undefined ? undefined : Math.max(0, budget - (performance.now() - started)),
        dispose: () => { clearTimeout(timer); for (const { signal, abort } of listeners) signal.removeEventListener('abort', abort); },
    };
}

export async function withOperation<T>(options: OperationOptions | undefined,
    run: (options: OperationOptions) => Promise<T>, lifetime?: AbortSignal): Promise<T> {
    const scope = operationScope(options, lifetime);
    try { checkOperation(scope.options); return await run(scope.options); }
    finally { scope.dispose(); }
}
