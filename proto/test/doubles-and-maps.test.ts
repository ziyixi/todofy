/**
 * Doubles and maps beyond what JSON can spell (Python twin: test/python/test_doubles_and_maps.py). The shared
 * cases (testdata/wire-profile-cases.json) are JSON, which has no NaN or infinity; hand-built messages do, and
 * the codec refuses them on both sides.
 */
import { describe, expect, test } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { BookSchema, Genre } from '../ts/prototest/v1/prototest_pb.ts';
import { fromWire, toWire, WireJsonError } from '../ts/wire-json.ts';

describe('doubles and maps', () => {
  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('%s is refused on write', (value) => {
    expect(() => toWire(BookSchema, create(BookSchema, { rating: value }))).toThrow(WireJsonError);
    expect(() => toWire(BookSchema, create(BookSchema, { editionRatings: [value] }))).toThrow(WireJsonError);
  });

  test('a non-finite double is refused on read (a hand-built input; JSON.parse never yields one)', () => {
    expect(() => fromWire(BookSchema, { rating: Number.NaN })).toThrow(WireJsonError);
    expect(() => fromWire(BookSchema, { edition_ratings: [Number.POSITIVE_INFINITY] })).toThrow(WireJsonError);
  });

  test('a zero enum map value cannot be written', () => {
    expect(() => toWire(BookSchema, create(BookSchema, { regionalGenres: { eu: Genre.UNSPECIFIED } }))).toThrow(WireJsonError);
  });

  test('map entries set in any order write the same bytes', () => {
    const first = JSON.stringify(toWire(BookSchema, create(BookSchema, { copies: { b: 1, a: 2 } })));
    const second = JSON.stringify(toWire(BookSchema, create(BookSchema, { copies: { a: 2, b: 1 } })));
    expect(first).toBe(second);
    expect(first).toBe('{"copies":{"a":2,"b":1}}');
  });

  test('the writer refuses scalars a reader would refuse (create() does not check them)', () => {
    expect(() => toWire(BookSchema, create(BookSchema, { pages: 1.5 }))).toThrow(WireJsonError);
    expect(() => toWire(BookSchema, create(BookSchema, { pages: 2 ** 31 }))).toThrow(WireJsonError);
    expect(() => toWire(BookSchema, create(BookSchema, { copies: { a: -0.5 } }))).toThrow(WireJsonError);
    expect(() => toWire(BookSchema, { ...create(BookSchema), title: 7 as unknown as string })).toThrow(WireJsonError);
  });

  test('a __proto__ map key is an ordinary entry', () => {
    const read = fromWire(BookSchema, JSON.parse('{"labels": {"__proto__": "x", "a": "y"}}'), { strict: true });
    expect(Object.getPrototypeOf(read.message.labels)).toBe(Object.prototype);
    expect(JSON.stringify(toWire(BookSchema, read.message))).toBe('{"labels":{"__proto__":"x","a":"y"}}');
  });
});
