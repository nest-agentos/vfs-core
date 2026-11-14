import type {EnginePort} from './EnginePort';
import {FSError, SEQ_CONTROL_COMMANDS, type SeqControlCommand} from '../../protocol';
import {operationId} from '../../utils/operation-id';

export async function seqRowOperation<T>(fs: EnginePort, path: string, command: SeqControlCommand, run: () => Promise<T>): Promise<T> {
    const started = Date.now(), identity = {operationId:operationId(), operation:'ioctl' as const, paths:[path],
        command:Object.hasOwn(SEQ_CONTROL_COMMANDS,command) ? command : 'unsupported', stage:'records.control'};
    fs.emit('operation:started',identity);
    try {
        const result = await run(), rows = (result as {rows?:unknown})?.rows ?? (result as {keys?:unknown})?.keys;
        fs.emit('operation:finished',{...identity,outcome:'success',durationMs:Date.now()-started,
            ...(Array.isArray(rows) ? {count:rows.length} : {})});
        return result;
    } catch (error) {
        fs.emit('operation:finished',{...identity,outcome:'failure',durationMs:Date.now()-started,errorCode:error instanceof FSError ? error.code : 'EIO'});
        throw error;
    }
}
