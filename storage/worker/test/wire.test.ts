import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { BatchCreateManifestSchema, BatchCreateResponseSchema, ObjectMetadataSchema, ListObjectsResponseSchema } from '@ziyixi/proto/storage/objects/v1/objects_pb';
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

  it('roundtrips bounded batch manifests and confirmations without binary JSON fields', () => {
    const manifestBytes = readFileSync(new NodeURL('../../../contracts/storage-objects-v1/fixtures/manifest.json', import.meta.url), 'utf8');
    const responseBytes = readFileSync(new NodeURL('../../../contracts/storage-objects-v1/fixtures/response.json', import.meta.url), 'utf8');
    expect(JSON.stringify(toWire(BatchCreateManifestSchema, fromWire(BatchCreateManifestSchema, JSON.parse(manifestBytes) as never, { strict: true }).message))).toBe(manifestBytes);
    expect(JSON.stringify(toWire(BatchCreateResponseSchema, fromWire(BatchCreateResponseSchema, JSON.parse(responseBytes) as never, { strict: true }).message))).toBe(responseBytes);
    const item = { key: 'raw/synthetic.json.gz', size_bytes: 3, content_hash: 'b'.repeat(64) };
    const manifest = { objects: [item], content_hash: 'c'.repeat(64) };
    const decoded = fromWire(BatchCreateManifestSchema, manifest, { strict: true }).message;
    expect(toWire(BatchCreateManifestSchema, decoded)).toEqual(manifest);
    const response = { objects: [{ key: item.key, revision: 'abc123', size_bytes: 3, content_hash: item.content_hash }] };
    expect(toWire(BatchCreateResponseSchema, fromWire(BatchCreateResponseSchema, response, { strict: true }).message)).toEqual(response);
    expect(() => fromWire(BatchCreateManifestSchema, { ...manifest, objects: Array.from({ length: 32 }, () => item) }, { strict: true })).not.toThrow();
    for (const invalid of [
      { ...manifest, unknown: 'refused' },
      { ...manifest, objects: [{ ...item, bytes: 'not-a-payload-field' }] },
      { ...manifest, objects: [{ ...item, size_bytes: 0 }] },
      { ...manifest, objects: [{ ...item, size_bytes: 33554433 }] },
      { ...manifest, objects: Array.from({ length: 33 }, () => item) },
    ]) expect(() => fromWire(BatchCreateManifestSchema, invalid, { strict: true })).toThrow();
    expect(() => fromWire(BatchCreateResponseSchema, { objects: Array.from({ length: 33 }, () => response.objects[0]) }, { strict: true })).toThrow();
  });
});
