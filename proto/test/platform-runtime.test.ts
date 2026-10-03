/** Browser and Python consumers share the bounded runtime observations and persisted release wire profile. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, test } from 'vitest';
import * as runtime from '../ts/platform/runtime/v1/runtime_pb.ts';
import * as service from '../ts/platform/runtime/v1/runtime_service_pb.ts';
import type * as wire from '../ts/platform/runtime/v1/runtime_wire.ts';
import { fromWire, toWire, WireJsonError } from '../ts/wire-json.ts';

const FIXTURES = join(import.meta.dirname, '../../contracts/platform-runtime-v1/fixtures');
const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RELEASE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const target = { workload_key: 'newsletter', source_sha: 'a'.repeat(40), image_digest: `sha256:${'b'.repeat(64)}`, request_id: REQUEST_ID };

describe('platform runtime wire profile', () => {
  test('ready, unknown and missing fixtures round-trip in the browser codec', () => {
    for (const name of readdirSync(FIXTURES).filter((name) => name.endsWith('.json')).sort()) {
      const value: unknown = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
      const read = fromWire(runtime.NodeStatusSchema, value, { strict: true });
      expect(read.unrecognized).toEqual([]);
      const written = toWire(runtime.NodeStatusSchema, read.message);
      expectTypeOf(written).toEqualTypeOf<wire.NodeStatus>();
      expect(written, name).toEqual(value);
    }
  });

  test('a release creation carries immutable aliases and identities, never arbitrary commands', () => {
    const value = { release_id: RELEASE_ID, request_id: REQUEST_ID, release: { targets: [target] } };
    expect(toWire(service.CreateReleaseRequestSchema, fromWire(service.CreateReleaseRequestSchema, value, { strict: true }).message)).toEqual(value);
    for (const invalid of [
      { ...value, release_id: 'not-a-uuid' },
      { ...value, release: { targets: Array.from({ length: 17 }, () => target) } },
      { ...value, release: { targets: [{ ...target, image_digest: 'latest' }] } },
      { ...value, release: { targets: [target], commands: ['not accepted'] } },
    ]) expect(() => fromWire(service.CreateReleaseRequestSchema, invalid, { strict: true })).toThrow(WireJsonError);
  });

  test('operation summaries are bounded and carry no second workload or target list', () => {
    const value = { name: `releases/${RELEASE_ID}`, request_id: REQUEST_ID, phase: 'held', etag: 'revision-3', update_time: '2026-10-03T00:00:00Z', error_code: 'DRAIN_UNKNOWN' };
    expect(toWire(runtime.ReleaseSummarySchema, fromWire(runtime.ReleaseSummarySchema, value, { strict: true }).message)).toEqual(value);
    for (const invalid of [{ ...value, phase: 'auto_resume' }, { ...value, targets: [target] },
      { ...value, error_code: '/private/path' }, { ...value, update_time: null }]) {
      expect(() => fromWire(runtime.ReleaseSummarySchema, invalid, { strict: true })).toThrow(WireJsonError);
    }
  });
});
