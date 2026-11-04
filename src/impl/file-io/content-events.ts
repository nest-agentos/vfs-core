import type { IFileSystem, FSEvent, FSContentPayload, FSContentFinishedPayload } from '../../protocol';
import { FSEventBus } from '../event/event-bus';
const buses = new WeakMap<IFileSystem, FSEventBus>();
function bus(fs: IFileSystem): FSEventBus {
    let value = buses.get(fs);
    if (!value) buses.set(fs, value = new FSEventBus());
    return value;
}
export function onContentEvent(fs: IFileSystem, callback: (event: FSEvent) => void): () => void {
    return bus(fs).onAny((payload, meta) => callback({ type: meta.type, payload,
        timestamp: meta.timestamp, viewId: fs.viewId } as FSEvent));
}
export function emitContentEvent(fs: IFileSystem, type: 'content:started' | 'content:finished',
    payload: FSContentPayload | FSContentFinishedPayload): void {
    if (type === 'content:started') bus(fs).emit(type, payload);
    else bus(fs).emit(type, payload as FSContentFinishedPayload);
}
