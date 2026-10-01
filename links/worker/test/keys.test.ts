import { describe, expect, it } from 'vitest';
import { asciiLower, continuationPath, normalizeKey, parseShortPath } from '../src/keys.ts';
import { KEY_PATTERN, RESERVED_KEYS } from '../src/limits.ts';

describe('normalizeKey', () => {
  it('stores keys in lower case and accepts the pattern', () => {
    expect(normalizeKey('GH')).toEqual({ key: 'gh' });
    expect(normalizeKey('a')).toEqual({ key: 'a' });
    expect(normalizeKey('0-day')).toEqual({ key: '0-day' });
    expect(normalizeKey('x'.repeat(63))).toEqual({ key: 'x'.repeat(63) });
  });

  it('refuses anything else as invalid', () => {
    for (const input of ['', '-a', 'a_b', 'a.b', 'a b', 'x'.repeat(64), 'é', 'ǅ', 'a/b', 'a+', '%61']) {
      expect(normalizeKey(input), input).toEqual({ problem: 'INVALID_KEY' });
    }
  });

  it('names every reserved key as reserved, whatever its case', () => {
    for (const key of RESERVED_KEYS) {
      expect(normalizeKey(key), key).toEqual({ problem: 'RESERVED_KEY' });
      expect(normalizeKey(key.toUpperCase()), key).toEqual({ problem: 'RESERVED_KEY' });
    }
    expect([...RESERVED_KEYS].sort()).toEqual(['.well-known', '_', 'api', 'cdn-cgi', 'favicon.ico', 'robots.txt', 's', 'search', 'v1']);
  });

  it('folds ASCII letters only (the Kelvin sign is no k)', () => {
    expect(asciiLower('AbCK')).toBe('abcK');
    expect(normalizeKey('K')).toEqual({ problem: 'INVALID_KEY' });
    expect(KEY_PATTERN.test('k')).toBe(true);
  });
});

describe('parseShortPath', () => {
  it('splits the key, the preview mark and the raw rest', () => {
    expect(parseShortPath('/gh')).toEqual({ key: 'gh', preview: false, rest: '' });
    expect(parseShortPath('/GH/')).toEqual({ key: 'gh', preview: false, rest: '' });
    expect(parseShortPath('/gh/ziyixi/todofy')).toEqual({ key: 'gh', preview: false, rest: 'ziyixi/todofy' });
    expect(parseShortPath('/gh+')).toEqual({ key: 'gh', preview: true, rest: '' });
    expect(parseShortPath('/gh+/a%20b')).toEqual({ key: 'gh', preview: true, rest: 'a%20b' });
  });

  it('also ends the key at an encoded space (a browser site search: `s gh a/b`)', () => {
    expect(parseShortPath('/gh%20ziyixi/todofy')).toEqual({ key: 'gh', preview: false, rest: 'ziyixi/todofy' });
    expect(parseShortPath('/q%20some%20words')).toEqual({ key: 'q', preview: false, rest: 'some%20words' });
    expect(parseShortPath('/q+%20x')).toEqual({ key: 'q', preview: true, rest: 'x' });
    expect(parseShortPath('/gh/a%20b')).toEqual({ key: 'gh', preview: false, rest: 'a%20b' });
    expect(parseShortPath('/%20gh')).toBeNull();
  });

  it('is null for a path without a usable key', () => {
    for (const path of ['/', '', 'gh', '/_', '/_/', '/api', '/s/x', '/robots.txt', '/favicon.ico', '/.well-known/x', '/cdn-cgi/x', '/%67h', '/gh++', '/+', '/a_b']) {
      expect(parseShortPath(path), path).toBeNull();
    }
  });

  it('builds the continuation from the request alone', () => {
    expect(continuationPath({ key: 'gh', preview: false, rest: '' })).toBe('/_/k/gh');
    expect(continuationPath({ key: 'gh', preview: true, rest: 'a/b%20c' })).toBe('/_/k/gh+/a/b%20c');
  });
});
