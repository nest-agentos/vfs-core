import {SEQ_ROW_COMMANDS,type SeqRowCommand} from './seq-rows';
export interface SeqKeyQuery {keyPrefix?: string; after?: string; limit: number;}
export interface SeqKeyPage {keys: string[]; next?: string;}
export type SeqControlCommand = SeqRowCommand | 'seq.keys.page.v1';
export const SEQ_CONTROL_COMMANDS: Readonly<Record<SeqControlCommand,'read' | 'write'>> = Object.freeze({
    ...SEQ_ROW_COMMANDS,'seq.keys.page.v1':'read',
});
