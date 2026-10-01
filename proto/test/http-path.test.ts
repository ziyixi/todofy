/**
 * Path templates (ts/http-path.ts): the grammar's edges, the specificity order and expand-then-match round
 * trips. The request-level behaviour (matching, binding, encoding) is in testdata/http-cases.json.
 */
import { describe, expect, test } from 'vitest';
import { compareSpecificity, expandTemplate, matchTemplate, parseTemplate, PathTemplateError, sameShape, splitPath } from '../ts/http-path.ts';

describe('parseTemplate', () => {
  test('reads variables, wildcards and the verb', () => {
    const template = parseTemplate('/v1/{book.name=shelves/*/books/*}/x:archive');
    expect(template.verb).toBe('archive');
    expect(template.segments.map((s) => (s.kind === 'literal' ? s.value : s.kind))).toEqual(['v1', 'shelves', 'wildcard', 'books', 'wildcard', 'x']);
    expect(template.variables).toEqual([{ fieldPath: ['book', 'name'], start: 1, end: 5 }]);
    expect(parseTemplate('/seeds:import').verb).toBe('import');
    expect(parseTemplate('/v1/{shelf}').variables).toEqual([{ fieldPath: ['shelf'], start: 1, end: 2 }]);
  });

  test.each([
    ['no leading slash', 'v1/books'],
    ['an empty segment', '/v1//books'],
    ['a trailing slash', '/v1/books/'],
    ['** before the end', '/v1/**/books'],
    ['a nested variable', '/v1/{a={b}}'],
    ['an unclosed variable', '/v1/{name'],
    ['a variable inside a segment', '/v1/x{name}'],
    ['a field path that is not snake_case', '/v1/{bookName}'],
    ['a field bound twice', '/v1/{name}/{name}'],
    ['two verbs', '/v1/x:a:b'],
    ['a literal that needs encoding', '/v1/a b'],
    ['an empty verb', '/v1/x:'],
  ])('refuses %s', (_name, source) => {
    expect(() => parseTemplate(source)).toThrow(PathTemplateError);
  });
});

describe('specificity', () => {
  test('literals before * before **, decided at the first difference', () => {
    const sources = ['/v1/{name=**}', '/v1/a/*', '/v1/*/b', '/v1/a/b', '/v1/a/**'];
    const sorted = sources.map(parseTemplate).sort(compareSpecificity).map((t) => t.source);
    expect(sorted).toEqual(['/v1/a/b', '/v1/a/*', '/v1/a/**', '/v1/*/b', '/v1/{name=**}']);
  });

  test('templates that match the same paths have the same shape whatever their variables', () => {
    expect(sameShape(parseTemplate('/v1/{name=decks/*}'), parseTemplate('/v1/decks/{deck}'))).toBe(true);
    expect(sameShape(parseTemplate('/v1/{name=decks/*}'), parseTemplate('/v1/{name=decks/*}:send'))).toBe(false);
  });
});

describe('expand, then match', () => {
  test.each([
    ['/v1/{name=decks/*}:decide', 'name', 'decks/2026-09-30'],
    ['/v1/{name=files/**}', 'name', 'files/a/b c/ü.txt'],
    ['/v1/shelves/{shelf}', 'shelf', 'a/b:c d%e'],
  ])('%s round-trips %s', (source, field, value) => {
    const template = parseTemplate(source);
    const path = expandTemplate(template, new Map([[field, value]]));
    const split = splitPath(path);
    expect(split).not.toBeNull();
    expect(matchTemplate(template, split ?? { segments: [], verb: undefined })?.get(field)).toBe(value);
  });

  test('expansion encodes everything but the unreserved characters', () => {
    expect(expandTemplate(parseTemplate('/v1/{id}'), new Map([['id', "a!*'()~._-z"]]))).toBe("/v1/a%21%2A%27%28%29~._-z");
  });

  test('a value that would reach another route is refused', () => {
    const template = parseTemplate('/v1/{name=decks/*}');
    for (const value of ['decks', 'decks/a/b', 'seeds/a', 'decks/', '']) {
      expect(() => expandTemplate(template, new Map([['name', value]]))).toThrow(PathTemplateError);
    }
  });

  test('a dot segment is refused: fetch would remove or resolve it and send another path', () => {
    // new URL('/api/v1/decks/../summary', base) is /api/v1/summary: the request would reach another route.
    expect(new URL('/api/v1/decks/../summary', 'https://a.example.com').pathname).toBe('/api/v1/summary');
    const cases: [string, string][] = [
      ['/api/v1/{name=decks/*}', 'decks/..'],
      ['/api/v1/{name=decks/*}', 'decks/.'],
      ['/api/v1/{name=decks/*/summary}', 'decks/../summary'],
      ['/api/v1/{name=likedPapers/*}', 'likedPapers/..'],
      ['/v1/{parent=shelves/*}/books', 'shelves/..'],
      ['/v1/{name=files/**}', 'files/a/../b'],
      ['/v1/{id}', '..'],
      ['/v1/{id}', '.'],
    ];
    for (const [source, value] of cases) {
      const variable = parseTemplate(source).variables[0]?.fieldPath.join('.') ?? '';
      expect(() => expandTemplate(parseTemplate(source), new Map([[variable, value]])), `${source} ${value}`).toThrow(PathTemplateError);
    }
    // Dots inside a segment, and a single-segment value whose slash is encoded, are ordinary text.
    expect(expandTemplate(parseTemplate('/v1/{id}'), new Map([['id', '..a']]))).toBe('/v1/..a');
    expect(expandTemplate(parseTemplate('/v1/{id}'), new Map([['id', 'a/..']]))).toBe('/v1/a%2F..');
  });
});
