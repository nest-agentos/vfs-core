import {FSError} from './interfaces/core/errors';
import type {IIOStream} from './interfaces/io';
import type {SeqRowCommands, SeqRowCommand} from './interfaces/capabilities/seq-rows';
export * from './interfaces/capabilities/seq-rows';
export * from './interfaces/capabilities/seq-control';
export {seqKeys} from './utils/seq-keys';
export {SEQ_FIELD_PREFIX} from './interfaces/capabilities/seq-file';

/** Typed facade for the common control entry; drivers still validate untrusted inputs. */
export async function seqRowControl<C extends SeqRowCommand>(file: Pick<IIOStream,'ioctl'>, command: C,
    input: SeqRowCommands[C]['input']): Promise<SeqRowCommands[C]['output']> {
    if (!file.ioctl) throw new FSError('ECAPABILITY','File control is unavailable','seq.rows');
    return await file.ioctl(command,input) as SeqRowCommands[C]['output'];
}
