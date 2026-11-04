/**
 * @file packages/vfslib/src/utils/id.ts
 * @desc 全局唯一 ID 生成
 */

let seq = 0;

export function generateId(): string {
    const ts = Date.now().toString(36);
    const s = (++seq).toString(36).padStart(4, '0');
    return `${ts}-${s}`;
}
