// @file: common/src/eventbus/event-buffer.ts

import type { IEventEmitter, Handler, AnyHandler, Unsubscribe } from './types';

/**
 * Transactional event buffer — accumulates emits and either flushes (commit)
 * or discards (rollback) them as a unit. Idempotent after settlement.
 *
 * Implements IEventEmitter so it can act as a drop-in emit target (e.g. in
 * DirectoryContext._emitTarget during a transaction). The on/once/onAny methods are
 * no-ops (subscriptions go on the real bus, not the buffer).
 */
export class EventBuffer<M extends object> implements IEventEmitter<M> {
  private buffer: Array<{
    type: keyof M & string;
    payload: M[keyof M & string];
    meta: Record<string, unknown>;
  }> = [];
  private settled = false;

  constructor(
    private readonly target: IEventEmitter<M>,
    private readonly baseMeta: Record<string, unknown> = {},
  ) {}

  // ── IEventEmitter.emit: buffer the call instead of dispatching immediately ──

  emit<K extends keyof M & string>(
    type: K,
    payload: M[K],
    meta?: Record<string, unknown>,
  ): void {
    if (this.settled) return;
    this.buffer.push({ type, payload: payload as M[keyof M & string], meta: meta ?? {} });
  }

  // ── IEventEmitter.on / once / onAny: delegate to target (subscriptions are not buffered) ──

  on<K extends keyof M & string>(type: K, handler: Handler<M[K]>): Unsubscribe {
    return this.target.on(type, handler);
  }

  once<K extends keyof M & string>(type: K, handler: Handler<M[K]>): Unsubscribe {
    return this.target.once(type, handler);
  }

  onAny(handler: AnyHandler<M>): Unsubscribe {
    return this.target.onAny(handler);
  }

  // ── Transaction control ──────────────────────────────────────────────────

  /** Flush all buffered events to the target, then seal. */
  commit(): void {
    if (this.settled) return;
    this.settled = true;
    for (const { type, payload, meta } of this.buffer) {
      this.target.emit(type, payload as M[typeof type], {
        ...this.baseMeta,
        fromTransaction: true,
        ...meta,
      });
    }
    this.buffer = [];
  }

  /** Discard all buffered events without dispatching. */
  rollback(): void {
    this.settled = true;
    this.buffer = [];
  }
}
