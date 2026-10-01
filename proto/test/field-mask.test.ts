/** google.protobuf.FieldMask in the wire profile and the AIP-134 update rule (ts/field-mask.ts). */
import { describe, expect, test } from 'vitest';
import { FieldMaskError, formatFieldMask, parseFieldMask, updatePaths } from '../ts/field-mask.ts';

describe('the wire form', () => {
  test('comma-separated snake_case paths; an empty string has none', () => {
    expect(parseFieldMask('send_mode,author.display_name')).toEqual(['send_mode', 'author.display_name']);
    expect(parseFieldMask('')).toEqual([]);
    expect(parseFieldMask('*')).toEqual(['*']);
    expect(formatFieldMask(['send_mode', 'author.display_name'])).toBe('send_mode,author.display_name');
    expect(formatFieldMask([])).toBe('');
  });

  test('anything else is refused, in both directions', () => {
    for (const text of ['sendMode', 'a,,b', ',a', 'a ', 'a.', '.a', 'labels["x"]', 'a.*', '1a']) {
      expect(() => parseFieldMask(text), text).toThrow(FieldMaskError);
    }
    for (const paths of [[''], ['Send'], ['a,b'], ['a', '']]) expect(() => formatFieldMask(paths), String(paths)).toThrow(FieldMaskError);
  });
});

describe('the update rule (AIP-134)', () => {
  test('no mask, no paths or exactly * replace every field', () => {
    expect(updatePaths(undefined)).toBe('*');
    expect(updatePaths({ paths: [] })).toBe('*');
    expect(updatePaths({ paths: ['*'] })).toBe('*');
    expect(updatePaths({ paths: ['*', '*'] })).toBe('*');
  });

  test('other masks name their fields once, in order', () => {
    expect(updatePaths({ paths: ['b', 'a', 'b'] })).toEqual(['b', 'a']);
  });

  test('* with other paths is refused', () => {
    expect(() => updatePaths({ paths: ['*', 'a'] })).toThrow(FieldMaskError);
  });
});
