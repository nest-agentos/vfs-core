// @file: common/src/eventbus/types.ts

export type Unsubscribe = () => void;

/**
 * Message attributes — extensible per-domain metadata attached to every event.
 * Consumers can carry viewId, mountId, nodeId, fromTransaction, channel key, etc.
 */
export interface EventMeta {
  readonly type: string;
  readonly timestamp: number;
  readonly channel?: string;
  readonly [key: string]: unknown;
}

export type Handler<P> = (payload: P, meta: EventMeta) => void;
export type AnyHandler<M extends object> = (
  payload: M[keyof M],
  meta: EventMeta,
) => void;

/**
 * Core pub/sub surface shared by EventBus and EventChannel.
 */
export interface IEventEmitter<M extends object> {
  emit<K extends keyof M & string>(
    type: K,
    payload: M[K],
    meta?: Record<string, unknown>,
  ): void;
  on<K extends keyof M & string>(type: K, handler: Handler<M[K]>): Unsubscribe;
  once<K extends keyof M & string>(type: K, handler: Handler<M[K]>): Unsubscribe;
  onAny(handler: AnyHandler<M>): Unsubscribe;
}

/**
 * Top-level typed event bus.
 * Channel = isolated namespace with its own lifecycle (closed channel drops emits silently).
 */
export interface IEventBus<M extends object> extends IEventEmitter<M> {
  /** Idempotent — returns existing channel if already open. */
  channel(key: string): IEventChannel<M>;
  /** Close channel: clears all local handlers, subsequent emits are no-ops. */
  closeChannel(key: string): void;
  hasChannel(key: string): boolean;
  /** Clear all topics, anyHandlers, and channels on this bus. */
  clear(): void;
  stats(): { topics: number; handlers: number; channels: number };
}

/**
 * Isolated sub-bus scoped by a string key.
 * Emitting on a channel delivers to:
 *   1. channel-local handlers (fast path, O(1) per handler)
 *   2. parent bus-level handlers (including onAny)
 */
export interface IEventChannel<M extends object> extends IEventEmitter<M> {
  readonly key: string;
  /**
   * Clear all local handlers without closing the channel (gate stays open).
   * Use this when you want to detach current listeners while allowing
   * future emits to continue (e.g. session UI refresh without stopping background tasks).
   */
  clearLocal(): void;
}

export interface EventBusOptions<M extends object> {
  /**
   * High-frequency event coalescing via queueMicrotask.
   * Same-tick emits keep only the latest payload (overwrite semantics).
   */
  coalesce?: (keyof M & string)[];
  /** Called when a handler throws; default: console.error. */
  onError?: (err: unknown, type: string) => void;
}
