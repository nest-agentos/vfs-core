import { FSError } from './errors';

export interface OperationOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}

export type OperationOutcome = 'not-started' | 'not-committed' | 'committed' | 'partial' | 'unknown';

export class FSOperationCancelledError extends FSError {
    constructor(readonly outcome: OperationOutcome = 'not-started', readonly timedOut = false) {
        super(timedOut ? 'ETIMEDOUT' : 'ECANCELLED', timedOut ? 'Operation timed out' : 'Operation cancelled');
    }
}

export function checkOperation(options?: OperationOptions): void {
    if (options?.signal?.aborted) {
        const reason = options.signal.reason;
        throw reason instanceof FSOperationCancelledError ? reason : new FSOperationCancelledError();
    }
}
