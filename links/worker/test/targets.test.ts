import { describe, expect, it } from 'vitest';
import { LOCATION_MAX, TARGET_MAX } from '../src/limits.ts';
import { checkTarget, destination, restSegments } from '../src/targets.ts';

const HOST = 's.example.com';

describe('checkTarget', () => {
  it('stores EXACT and APPEND targets as the URL parser writes them', () => {
    expect(checkTarget('https://example.com', 'exact', HOST)).toBe('https://example.com/');
    expect(checkTarget('HTTPS://Example.COM/a?b=1#c', 'append', HOST)).toBe('https://example.com/a?b=1#c');
    expect(checkTarget('https://例子.example/路径', 'exact', HOST)).toBe('https://xn--fsqu00a.example/%E8%B7%AF%E5%BE%84');
  });

  it('refuses anything but an https URL without credentials on another host', () => {
    for (const target of [
      '',
      'http://example.com/',
      'ftp://example.com/',
      'javascript:alert(1)',
      'data:text/html,x',
      '//example.com/',
      'example.com',
      'https://user@example.com/',
      'https://user:pass@example.com/',
      'https://s.example.com/x',
      'https://S.EXAMPLE.COM./x',
      'https://example.com/ a',
      'https://example.com/\na',
      'https://example.com/\u0000',
      `https://example.com/${'a'.repeat(TARGET_MAX)}`,
      'https://example.com/{path}',
    ]) {
      expect(checkTarget(target, 'exact', HOST), target).toBeNull();
    }
  });

  it('takes a TEMPLATE with exactly one {path} after the authority, as written', () => {
    expect(checkTarget('https://example.com/{path}', 'template', HOST)).toBe('https://example.com/{path}');
    expect(checkTarget('https://example.com/search?q={path}&x=1', 'template', HOST)).toBe('https://example.com/search?q={path}&x=1');
    expect(checkTarget('https://example.com#{path}', 'template', HOST)).toBe('https://example.com#{path}');
    for (const target of [
      'https://example.com/',
      'https://example.com/{path}/{path}',
      'https://{path}.example.com/',
      'https://example.com{path}',
      'https://example{path}/x',
      'https://a{path}@example.com/',
      'https://example.com\\{path}',
      'https://s.example.com/{path}',
    ]) {
      expect(checkTarget(target, 'template', HOST), target).toBeNull();
    }
  });
});

describe('restSegments', () => {
  it('decodes each segment and keeps empty ones', () => {
    expect(restSegments('')).toEqual([]);
    expect(restSegments('a/b%20c/')).toEqual(['a', 'b c', '']);
    expect(restSegments('%E4%BD%A0')).toEqual(['你']);
  });

  it('refuses malformed escapes, dot segments, hidden separators and control characters', () => {
    for (const rest of ['%', '%zz', '.', '..', 'a/../b', '%2e%2e', 'a%2Fb', 'a%5Cb', 'a\\b', '%00', '%0A']) {
      expect(restSegments(rest), rest).toBeNull();
    }
  });
});

describe('destination', () => {
  it('EXACT: the target, and no path after the key', () => {
    expect(destination('https://example.com/x', 'exact', '')).toEqual({ url: 'https://example.com/x' });
    expect(destination('https://example.com/x', 'exact', 'y')).toEqual({ problem: 'NO_PATH' });
  });

  it('APPEND: the rest encoded segment by segment after the target path; query and fragment stay', () => {
    expect(destination('https://example.com/', 'append', '')).toEqual({ url: 'https://example.com/' });
    expect(destination('https://example.com/', 'append', 'ziyixi/todofy')).toEqual({ url: 'https://example.com/ziyixi/todofy' });
    expect(destination('https://example.com/a/', 'append', 'b%20c/d')).toEqual({ url: 'https://example.com/a/b%20c/d' });
    expect(destination('https://example.com/a?x=1#f', 'append', 'b')).toEqual({ url: 'https://example.com/a/b?x=1#f' });
    expect(destination('https://example.com/a', 'append', '%3F%23')).toEqual({ url: 'https://example.com/a/%3F%23' });
  });

  it('TEMPLATE: {path} replaced in the path segment-wise, in the query as one value', () => {
    expect(destination('https://example.com/u/{path}/x', 'template', 'a/b c')).toEqual({ url: 'https://example.com/u/a/b%20c/x' });
    expect(destination('https://example.com/search?q={path}', 'template', 'a/b c&d=1')).toEqual({ url: 'https://example.com/search?q=a%2Fb%20c%26d%3D1' });
    expect(destination('https://example.com/search?q={path}', 'template', '')).toEqual({ url: 'https://example.com/search?q=' });
  });

  it('never leaves the target origin, whatever the request path holds', () => {
    const attacks = ['@evil.example', '%40evil.example', '/evil.example', '%2F%2Fevil.example', '..%2F..%2Fevil', '\\evil.example', 'https:%2F%2Fevil.example', '%0d%0aLocation:%20x'];
    for (const rest of attacks) {
      for (const [target, mode] of [
        ['https://example.com/', 'append'],
        ['https://example.com/{path}', 'template'],
        ['https://example.com{path}'.replace('{path}', '/{path}'), 'template'],
        ['https://example.com/?u={path}', 'template'],
      ] as const) {
        const result = destination(target, mode, rest);
        if ('url' in result) {
          const url = new URL(result.url);
          expect(url.origin, `${target} + ${rest}`).toBe('https://example.com');
          expect(url.username + url.password).toBe('');
          expect(result.url).not.toMatch(/[\r\n]/);
        }
      }
    }
    // An empty first segment (`/<key>//evil.example`) stays a path of the target's host.
    expect(destination('https://example.com/', 'append', '/evil.example')).toEqual({ url: 'https://example.com//evil.example' });
  });

  it('refuses a malformed rest and a URL longer than LOCATION_MAX', () => {
    expect(destination('https://example.com/', 'append', 'a/../b')).toEqual({ problem: 'BAD_PATH' });
    expect(destination('https://example.com/', 'append', '%zz')).toEqual({ problem: 'BAD_PATH' });
    expect(destination('https://example.com/', 'append', 'é'.repeat(LOCATION_MAX / 4))).toEqual({ problem: 'BAD_PATH' });
  });
});
