/** UTF-8 binary ordering, matching SQLite BINARY for valid Unicode strings. */
export function compareUtf8(left: string, right: string): number {
    if (left === right) return 0;
    const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
    for (let i = 0; i < Math.min(a.length,b.length); i++) if (a[i] !== b[i]) return a[i]-b[i];
    return a.length-b.length;
}
