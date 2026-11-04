export function guessMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
        // 图片
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'svg': 'image/svg+xml',
        'webp': 'image/webp',
        'bmp': 'image/bmp',
        'ico': 'image/x-icon',

        // Office文档
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt': 'application/vnd.ms-powerpoint',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

        'txt': 'text/plain',
        'md': 'text/markdown',

        // 代码
        'json': 'application/json',
        'js': 'text/javascript',
        'ts': 'text/typescript',
        'py': 'text/x-python',
        'html': 'text/html',
        'css': 'text/css',
        'xml': 'application/xml',
        'yaml': 'text/yaml',
        'yml': 'text/yaml',

        // 音视频
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'ogg': 'audio/ogg',

        // 视频
        'mp4': 'video/mp4',
        'webm': 'video/webm',

        // 压缩
        'zip': 'application/zip',
        'gz': 'application/gzip',
        'tar': 'application/x-tar',
        'rar': 'application/x-rar-compressed',
        '7z': 'application/x-7z-compressed',
    };
    return map[ext || ''] || 'application/octet-stream';
}
