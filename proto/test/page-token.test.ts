/** AIP-158 page tokens (ts/page-token.ts): opaque, bound to the list parameters, refused when tampered with. */
import { describe, expect, test } from 'vitest';
import { decodePageToken, encodePageToken, MAX_TOKEN_CHARS, PageTokenError } from '../ts/page-token.ts';

describe('page tokens', () => {
  const cursor = { at: 1_790_000_000_000, id: 'w-35773' };

  test('round trip with the same parameters, whatever their order', () => {
    const token = encodePageToken(cursor, { filter: '"graph neural"', parent: '' });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain('2609.35773'); // not the readable cursor
    expect(decodePageToken(token, { parent: '', filter: '"graph neural"' })).toEqual(cursor);
  });

  test('non-ASCII parameters and cursors survive', () => {
    const token = encodePageToken(['书', 3], { filter: '"图"' });
    expect(decodePageToken(token, { filter: '"图"' })).toEqual(['书', 3]);
  });

  test('a token made for other parameters is refused', () => {
    const token = encodePageToken(cursor, { filter: 'a' });
    expect(() => decodePageToken(token, { filter: 'b' })).toThrow(PageTokenError);
    expect(() => decodePageToken(token, {})).toThrow(PageTokenError);
    expect(() => decodePageToken(token, { filter: 'a', parent: 'x' })).toThrow(PageTokenError);
  });

  test('a hand-made, truncated or oversized token is refused', () => {
    const token = encodePageToken(cursor, {});
    const forged = btoa(JSON.stringify({ v: 1, c: cursor, p: 'ffffffff' })).replace(/=+$/, '');
    for (const bad of ['', '1790000000000~w-35773', token.slice(0, -3), `${token}!`, forged, 'e30', 'bnVsbA', 'A'.repeat(MAX_TOKEN_CHARS + 1)]) {
      expect(() => decodePageToken(bad, {}), bad.slice(0, 40)).toThrow(PageTokenError);
    }
  });

  test('a cursor too large for a token is refused when encoding', () => {
    expect(() => encodePageToken('x'.repeat(MAX_TOKEN_CHARS), {})).toThrow(PageTokenError);
  });
});
