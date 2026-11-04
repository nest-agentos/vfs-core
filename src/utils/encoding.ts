/**
 * @file packages/vfslib/src/utils/encoding.ts
 * @desc 内容编解码工具
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBuffer(content: string | ArrayBuffer | Uint8Array): ArrayBuffer {
    if (typeof content === 'string') {
        return encoder.encode(content).buffer as ArrayBuffer;
    }
    if (content instanceof Uint8Array) {
        return content.buffer.slice(
            content.byteOffset,
            content.byteOffset + content.byteLength,
        ) as ArrayBuffer;
    }
    return content;
}

export function toString(data: ArrayBuffer): string {
    return decoder.decode(data);
}

export function toUint8Array(data: ArrayBuffer): Uint8Array {
    return new Uint8Array(data);
}
