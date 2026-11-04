# Durable event journal

`SeqEventJournal<T>` is optional durable infrastructure, separate from synchronous `EventBus` and `EventBuffer`. It accepts an authorized `IFileSystem`, a journal path and a candidate stream ID supplied by the host. Reopening preserves the stored stream ID. User identity and application notification policy are outside this library.

```ts
const journal = await SeqEventJournal.open<Fact>(fs, '/events.seq', newStreamId);
const baseline = await journal.baseline();
await journal.transaction(async tx => {
  await tx.records.setEntry('/business.seq', 'status', 'complete');
  await tx.append(operationId, {type: 'completed'});
  await tx.setState('consumer/source', sourceSequence);
});
const page = await journal.read(baseline, 100);
```

All transaction records must resolve to the same transactional SeqFile backend. Atomic business/event publication requires writing both through the provided transaction. A callback after a separate business commit does not close the crash window.

`onChange` is a local commit hint, never a durable acknowledgment. Each consumer owns its cursor. Register the hint before reading; query after reconnection even if no hint was received. Other journal instances can read committed records but their local hint listeners are not broadcast automatically. `close()` releases local observers; filesystem lifetime remains host-owned.

Default retention is 1000 entries, configurable from 1 to 10000. Event JSON is limited to 16384 UTF-16 code units and a read page to 200 records. Duplicate IDs with the same value return the retained event; conflicting values reject with ECONFLICT. Deduplication only spans retained events; durable source consumers must atomically advance a separate source checkpoint to prevent reinsertion after retention.

`read()` without a cursor starts at the earliest retained event. Foreign stream IDs, pruned cursors and future cursors reject with ECONFLICT; consumers must load a new snapshot and baseline. Journal state is application-owned and not automatically pruned; hosts must bound checkpoint/notification state and avoid storing bodies or credentials.
