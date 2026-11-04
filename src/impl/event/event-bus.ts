/**
 * @file packages/vfs-core/src/impl/event/event-bus.ts
 * @desc Typed VFS event bus — re-exports the unified core and provides FS-specific aliases.
 */
import type { FSEventPayloadMap } from '../../protocol';
import { EventBus as CoreEventBus, EventBuffer as CoreEventBuffer } from '../../eventbus';

/** VFS 专用事件总线 — 类型化为 FSEventPayloadMap。 */
export class FSEventBus extends CoreEventBus<FSEventPayloadMap> {}

/** VFS 事务事件缓冲。 */
export class TransactionEventBuffer extends CoreEventBuffer<FSEventPayloadMap> {}
