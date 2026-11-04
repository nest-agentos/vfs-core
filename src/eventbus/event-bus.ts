// @file: common/src/eventbus/event-bus.ts

import type {
  AnyHandler,
  EventBusOptions,
  EventMeta,
  Handler,
  IEventBus,
  IEventChannel,
  IEventEmitter,
  Unsubscribe,
} from './types';

// ─── helpers ────────────────────────────────────────────────────────────────

function safeCall<P>(
  fn: Handler<P>,
  payload: P,
  meta: EventMeta,
  onError: (err: unknown, type: string) => void,
): void {
  try {
    fn(payload, meta);
  } catch (err) {
    onError(err, meta.type);
  }
}

const defaultOnError = (err: unknown, type: string): void =>
  console.error(`[EventBus] handler error on "${type}":`, err);

// ─── ChannelImpl ─────────────────────────────────────────────────────────────

class ChannelImpl<M extends object> implements IEventChannel<M> {
  private local = new Map<string, Set<Handler<unknown>>>();
  private localAny = new Set<AnyHandler<M>>();
  private closed = false;

  constructor(
    public readonly key: string,
    private parent: EventBus<M>,
    private onError: (err: unknown, type: string) => void,
  ) {}

  emit<K extends keyof M & string>(
    type: K,
    payload: M[K],
    extra?: Record<string, unknown>,
  ): void {
    if (this.closed) return;
    const meta: EventMeta = { type, timestamp: Date.now(), channel: this.key, ...extra };
    this.dispatchLocal(type, payload, meta);
    this.parent['dispatchBus'](type, payload, meta);
  }

  on<K extends keyof M & string>(type: K, handler: Handler<M[K]>): Unsubscribe {
    let set = this.local.get(type);
    if (!set) { set = new Set(); this.local.set(type, set); }
    const storedHandler = handler as Handler<unknown>;
    set.add(storedHandler);
    return () => this.local.get(type)?.delete(storedHandler);
  }

  once<K extends keyof M & string>(type: K, handler: Handler<M[K]>): Unsubscribe {
    const un = this.on(type, (p, m) => { un(); handler(p, m); });
    return un;
  }

  onAny(handler: AnyHandler<M>): Unsubscribe {
    this.localAny.add(handler);
    return () => this.localAny.delete(handler);
  }

  /** Clear all local handlers without closing the channel (keeps gate open). */
  clearLocal(): void {
    this.local.clear();
    this.localAny.clear();
  }

  close(): void {
    this.closed = true;
    this.clearLocal();
  }

  private dispatchLocal<K extends keyof M & string>(
    type: K,
    payload: M[K],
    meta: EventMeta,
  ): void {
    const set = this.local.get(type);
    if (set) {
      for (const h of [...set]) safeCall(h, payload, meta, this.onError);
    }
    for (const h of [...this.localAny]) safeCall(h, payload, meta, this.onError);
  }
}

// ─── EventBus ────────────────────────────────────────────────────────────────

export class EventBus<M extends object> implements IEventBus<M> {
  private topics = new Map<string, Set<Handler<unknown>>>();
  private anyHandlers = new Set<AnyHandler<M>>();
  private channels = new Map<string, ChannelImpl<M>>();

  // coalesce state
  private coalesceSet: Set<string>;
  private pending = new Map<string, M[keyof M]>();
  private pendingMeta = new Map<string, Record<string, unknown>>();
  private scheduled = false;

  private readonly onError: (err: unknown, type: string) => void;

  constructor(opts: EventBusOptions<M> = {}) {
    this.coalesceSet = new Set(opts.coalesce ?? []);
    this.onError = opts.onError ?? defaultOnError;
  }

  // ── emit ──────────────────────────────────────────────────────────────────

  emit<K extends keyof M & string>(
    type: K,
    payload: M[K],
    extra?: Record<string, unknown>,
  ): void {
    if (this.coalesceSet.has(type)) {
      this.pending.set(type, payload);
      if (extra) this.pendingMeta.set(type, extra);
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => this.flush());
      }
      return;
    }
    const meta: EventMeta = { type, timestamp: Date.now(), ...extra };
    this.dispatchBus(type, payload, meta);
  }

  private flush(): void {
    this.scheduled = false;
    const batch = new Map(this.pending);
    const batchMeta = new Map(this.pendingMeta);
    this.pending.clear();
    this.pendingMeta.clear();
    for (const [type, payload] of batch) {
      const extra = batchMeta.get(type);
      const meta: EventMeta = { type, timestamp: Date.now(), ...extra };
      this.dispatchBus(type as (keyof M & string), payload as M[keyof M & string], meta);
    }
  }

  // Called by ChannelImpl to reach bus-level handlers without triggering coalesce again.
  private dispatchBus<K extends keyof M & string>(
    type: K,
    payload: M[K],
    meta: EventMeta,
  ): void {
    const set = this.topics.get(type);
    if (set) {
      for (const h of [...set]) safeCall(h, payload, meta, this.onError);
    }
    for (const h of [...this.anyHandlers]) safeCall(h, payload, meta, this.onError);
  }

  // ── subscribe ─────────────────────────────────────────────────────────────

  on<K extends keyof M & string>(type: K, handler: Handler<M[K]>): Unsubscribe {
    let set = this.topics.get(type);
    if (!set) { set = new Set(); this.topics.set(type, set); }
    const storedHandler = handler as Handler<unknown>;
    set.add(storedHandler);
    return () => this.topics.get(type)?.delete(storedHandler);
  }

  once<K extends keyof M & string>(type: K, handler: Handler<M[K]>): Unsubscribe {
    const un = this.on(type, (p, m) => { un(); handler(p, m); });
    return un;
  }

  onAny(handler: AnyHandler<M>): Unsubscribe {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  // ── channel ───────────────────────────────────────────────────────────────

  channel(key: string): IEventChannel<M> {
    let ch = this.channels.get(key);
    if (!ch) {
      ch = new ChannelImpl<M>(key, this, this.onError);
      this.channels.set(key, ch);
    }
    return ch;
  }

  closeChannel(key: string): void {
    this.channels.get(key)?.close();
    this.channels.delete(key);
  }

  hasChannel(key: string): boolean {
    return this.channels.has(key);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  clear(): void {
    this.topics.clear();
    this.anyHandlers.clear();
    for (const ch of this.channels.values()) ch.close();
    this.channels.clear();
    this.pending.clear();
    this.pendingMeta.clear();
    this.scheduled = false;
  }

  stats(): { topics: number; handlers: number; channels: number } {
    let handlers = this.anyHandlers.size;
    for (const set of this.topics.values()) handlers += set.size;
    return { topics: this.topics.size, handlers, channels: this.channels.size };
  }
}

// Re-export IEventEmitter so consumers can depend on the interface only.
export type { IEventBus, IEventChannel, IEventEmitter };
