import { expect, it } from 'vitest';
import { matchesKeywords, searchKeywords } from '../src';

it('matches every literal keyword regardless of order, case or repeated horizontal whitespace', () => {
    const keywords = searchKeywords('  Beta\t中文　a.* BETA ');
    expect(keywords).toEqual(['beta', '中文', 'a.*']);
    expect(matchesKeywords('中文 A.* other bEtA', keywords)).toBe(true);
    expect(matchesKeywords('中文 beta axxx', keywords)).toBe(false);
    expect(matchesKeywords('a.* 中文', keywords)).toBe(false);
    expect(matchesKeywords('anything', searchKeywords('  '))).toBe(true);
});

it('preserves explicit newlines for literal multiline API queries', () => {
    expect(searchKeywords('before\nneedle')).toEqual(['before\nneedle']);
    expect(matchesKeywords('before\nneedle', searchKeywords('before\nneedle'))).toBe(true);
    expect(matchesKeywords('before needle', searchKeywords('before\nneedle'))).toBe(false);
});
