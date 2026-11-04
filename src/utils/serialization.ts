/**
 * @file packages/vfslib/src/utils/serialization.ts
 * @desc VFS export/import serialization — bundles file content + assetdir into a
 *       self-contained YAML manifest, and reconstructs from it.
 *
 * Format: vfs-export/v1
 *
 *   format: "vfs-export/v1"
 *   file:
 *     name: "report.md"
 *     type: file
 *     tags: ["notes"]
 *     icon: "📝"
 *     metadata:
 *       ai_defaultAgent: "claude-opus-4-6"
 *     content:
 *       encoding: utf-8
 *       data: |
 *         # My Report
 *   assets:
 *     - name: "screenshot.png"
 *       content:
 *         encoding: base64
 *         data: "iVBORw0KGgo..."
 */

import YAML from 'yaml';
import type { FSFileNode, FileContent } from '../protocol';

// ── Types ──────────────────────────────────────────────────────

export interface VFSEncodedContent {
    encoding: 'utf-8' | 'base64';
    data: string;
}

export interface VFSExportFileEntry {
    name: string;
    type: 'file' | 'seqfile';
    tags?: string[];
    icon?: string;
    metadata?: Record<string, unknown>;
    content: VFSEncodedContent;
}

export interface VFSExportAsset {
    name: string;
    content: VFSEncodedContent;
}

export interface VFSExportManifest {
    format: 'vfs-export/v1';
    file: VFSExportFileEntry;
    assets?: VFSExportAsset[];
}

// ── Encoding helpers ───────────────────────────────────────────

const TEXT_EXTENSIONS = [
    '.md', '.txt', '.json', '.html', '.css', '.js', '.ts',
    '.yaml', '.yml', '.xml', '.svg', '.csv', '.log',
];

function isTextByExtension(name: string): boolean {
    const lower = name.toLowerCase();
    return TEXT_EXTENSIONS.some(ext => lower.endsWith(ext));
}

function isTextMime(mimeType?: string): boolean {
    if (!mimeType) return false;
    return (
        mimeType.startsWith('text/') ||
        mimeType === 'application/json' ||
        mimeType === 'application/xml' ||
        mimeType === 'image/svg+xml'
    );
}

function toBase64(content: ArrayBuffer): string {
    const bytes = new Uint8Array(content);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function fromBase64(b64: string): ArrayBuffer {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer as ArrayBuffer;
}

function fileContentToArrayBuffer(content: FileContent): ArrayBuffer {
    if (typeof content === 'string') {
        return new TextEncoder().encode(content).buffer as ArrayBuffer;
    }
    if (content instanceof Uint8Array) {
        return content.buffer.slice(
            content.byteOffset,
            content.byteOffset + content.byteLength,
        ) as ArrayBuffer;
    }
    return content;
}

function fileContentToString(content: FileContent): string {
    if (typeof content === 'string') return content;
    const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
    return new TextDecoder().decode(bytes);
}

// ── Serialize ──────────────────────────────────────────────────

export interface SerializeDeps {
    /** Read the main file content */
    readContent(path: string): Promise<FileContent>;
    /** List asset names inside the assetdir */
    listAssets(path: string): Promise<string[]>;
    /** Read a single asset (returns binary) */
    getAsset(path: string, name: string): Promise<FileContent | null>;
}

/**
 * Build a YAML manifest for a file that may have an assetdir.
 * Callers should first check `hasAssetDir` before calling this.
 */
export async function serialize(
    node: FSFileNode,
    deps: SerializeDeps,
): Promise<string> {
    const path = node.path;

    // ── File content ──
    const raw = await deps.readContent(path);
    const isText = isTextMime(node.mimeType) || isTextByExtension(node.name);

    const fileContent: VFSEncodedContent = isText
        ? { encoding: 'utf-8', data: fileContentToString(raw) }
        : { encoding: 'base64', data: toBase64(fileContentToArrayBuffer(raw)) };

    // ── Assets ──
    let assets: VFSExportAsset[] | undefined;
    try {
        const names = await deps.listAssets(path);
        if (names.length) {
            assets = await Promise.all(
                names.map(async (name): Promise<VFSExportAsset> => {
                    const assetRaw = await deps.getAsset(path, name);
                    const assetIsText = isTextByExtension(name);
                    const data = assetRaw
                        ? assetIsText
                            ? fileContentToString(assetRaw)
                            : toBase64(fileContentToArrayBuffer(assetRaw))
                        : '';

                    return {
                        name,
                        content: {
                            encoding: assetIsText ? 'utf-8' : 'base64',
                            data,
                        },
                    };
                }),
            );
        }
    } catch {
        // assetdir not supported by this backend — skip assets
    }

    // ── Metadata ──
    const metadata: Record<string, unknown> = {};
    if (node.metadata && Object.keys(node.metadata).length > 0) {
        // Shallow-copy own keys (skip prototype)
        for (const key of Object.keys(node.metadata)) {
            metadata[key] = node.metadata[key];
        }
    }

    const manifest: VFSExportManifest = {
        format: 'vfs-export/v1',
        file: {
            name: node.name,
            type: node.type as 'file' | 'seqfile',
            ...(node.tags.length ? { tags: [...node.tags] } : {}),
            ...(node.icon ? { icon: node.icon } : {}),
            ...(Object.keys(metadata).length ? { metadata } : {}),
            content: fileContent,
        },
        ...(assets?.length ? { assets } : {}),
    };

    return YAML.stringify(manifest, { lineWidth: 0 });
}

// ── Deserialize ────────────────────────────────────────────────

/**
 * Parse a YAML manifest string back into structured data.
 * Throws on invalid format or version mismatch.
 */
export function deserialize(yamlStr: string): VFSExportManifest {
    const parsed: unknown = YAML.parse(yamlStr);

    if (!isUnknownRecord(parsed)) {
        throw new Error('无效的导出文件：内容为空');
    }

    if (parsed.format !== 'vfs-export/v1') {
        throw new Error(
            `不支持的导出格式版本: ${formatLabel(parsed.format)}`,
        );
    }

    if (!isExportManifest(parsed)) {
        throw new Error('无效的导出文件：缺少必要字段');
    }

    return parsed;
}

function isExportManifest(value: unknown): value is VFSExportManifest {
    if (!isUnknownRecord(value)) return false;
    if (value.format !== 'vfs-export/v1' || !isExportFile(value.file)) return false;
    return value.assets === undefined ||
        (Array.isArray(value.assets) && value.assets.every(isExportAsset));
}

function isExportFile(value: unknown): value is VFSExportFileEntry {
    if (!isUnknownRecord(value) || !isEncodedContent(value.content)) return false;
    if (typeof value.name !== 'string') return false;
    if (value.type !== 'file' && value.type !== 'seqfile') return false;
    if (value.tags !== undefined && !isStringArray(value.tags)) return false;
    if (value.icon !== undefined && typeof value.icon !== 'string') return false;
    return value.metadata === undefined || isUnknownRecord(value.metadata);
}

function isExportAsset(value: unknown): value is VFSExportAsset {
    return isUnknownRecord(value) &&
        typeof value.name === 'string' &&
        isEncodedContent(value.content);
}

function isEncodedContent(value: unknown): value is VFSEncodedContent {
    return isUnknownRecord(value) &&
        (value.encoding === 'utf-8' || value.encoding === 'base64') &&
        typeof value.data === 'string';
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function formatLabel(value: unknown): string {
    return typeof value === 'string' && value ? value : '未知';
}

/**
 * Decode VFSEncodedContent back to a format suitable for VFS write operations.
 * utf-8 → string, base64 → ArrayBuffer
 */
export function decodeContent(
    encoded: VFSEncodedContent,
): string | ArrayBuffer {
    if (encoded.encoding === 'utf-8') {
        return encoded.data;
    }
    return fromBase64(encoded.data);
}
