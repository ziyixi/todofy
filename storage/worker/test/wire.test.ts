import { describe, expect, it } from 'vitest';
import { ObjectMetadataSchema, ListObjectsResponseSchema } from '@ziyixi/proto/storage/objects/v1/objects_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';

describe('public wire bytes', () => {
  it('roundtrips the fixed four-field metadata and an empty listing without losing zeros', () => {
    const fixture = '{"key":"datasets/part.bin","revision":"abc123","size_bytes":0,"content_hash":"' + 'b'.repeat(64) + '"}';
    const object = fromWire(ObjectMetadataSchema, JSON.parse(fixture) as never, { strict: true }).message;
    expect(JSON.stringify(toWire(ObjectMetadataSchema, object))).toBe(fixture);
    const listing = fromWire(ListObjectsResponseSchema, { objects: [], next_cursor: '' }, { strict: true }).message;
    expect(JSON.stringify(toWire(ListObjectsResponseSchema, listing))).toBe('{"objects":[],"next_cursor":""}');
  });

  it('rejects invalid provider metadata under both strict and lenient reads', () => {
    const valid = { key: 'datasets/part.bin', revision: 'abc123', size_bytes: 3, content_hash: 'b'.repeat(64) };
    for (const invalid of [{ ...valid, size_bytes: 33554433 }, { ...valid, content_hash: 'plain-sha-not-a-dropbox-hash' }, { ...valid, key: 'id:outside' }, { ...valid, revision: '*' }]) {
      for (const strict of [true, false]) expect(() => fromWire(ObjectMetadataSchema, invalid, { strict })).toThrow();
    }
  });
});
