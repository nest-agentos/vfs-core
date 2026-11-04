/** Split horizontal whitespace; explicit newlines retain literal multiline search semantics. */
export function searchKeywords(query: string): string[] {
    return [...new Set(query.toLowerCase().split(/[^\S\r\n]+/u).filter(Boolean))];
}

/** All literal keywords must occur in the same caller-selected search unit. */
export function matchesKeywords(text: string, keywords: readonly string[]): boolean {
    const candidate = text.toLowerCase();
    return keywords.every(keyword => candidate.includes(keyword));
}
