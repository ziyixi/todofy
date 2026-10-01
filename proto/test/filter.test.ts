/** The AIP-160 subset (ts/filter.ts) against the shared cases in testdata/filter-cases.json. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FilterError, parseLiteralFilter, quoteLiteral } from '../ts/filter.ts';

interface Cases {
  readonly max_literals: number;
  readonly parse: readonly { readonly name: string; readonly filter: string; readonly literals?: readonly string[]; readonly error?: true }[];
  readonly quote: readonly { readonly name: string; readonly text: string; readonly filter: string }[];
}

const cases = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'testdata', 'filter-cases.json'), 'utf8')) as Cases;

describe('parse', () => {
  test('every case has its own name', () => {
    expect(new Set(cases.parse.map((c) => c.name)).size).toBe(cases.parse.length);
  });

  test.each(cases.parse.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    if (c.error === true) expect(() => parseLiteralFilter(c.filter, cases.max_literals)).toThrow(FilterError);
    else expect(parseLiteralFilter(c.filter, cases.max_literals)).toEqual(c.literals);
  });
});

describe('quote', () => {
  test.each(cases.quote.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(quoteLiteral(c.text)).toBe(c.filter);
    // What a search box sends parses back to the trimmed text, as one literal.
    expect(parseLiteralFilter(c.filter, 1)).toEqual(c.text.trim() === '' ? [] : [c.text.trim()]);
  });
});
