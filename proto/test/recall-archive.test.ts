/**
 * recall-archive-v1 (contracts/recall-archive-v1): its fixtures against the codec of proto/recall/archive/v1. Every
 * valid fixture round-trips byte for byte through a strict read, every invalid one is refused by strict and lenient
 * reads alike, a change of a newer kind (fixtures/future/) passes a consumer's lenient read on its envelope, and the
 * sample archive is what applying the first page to an empty store writes.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ArchiveStateSchema, ChangePageSchema, ChangeSchema } from '../ts/recall/archive/v1/archive_pb.ts';
import { fromWire, toWire, WireJsonError } from '../ts/wire-json.ts';

const FIXTURES = join(import.meta.dirname, '../../contracts/recall-archive-v1/fixtures');
const SCHEMAS = { ArchiveState: ArchiveStateSchema, Change: ChangeSchema, ChangePage: ChangePageSchema } as const;
type Def = keyof typeof SCHEMAS;

function files(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : [];
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface BlobRef {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

describe('recall-archive-v1 fixtures', () => {
  test('every valid fixture round-trips byte for byte through a strict read', () => {
    for (const def of Object.keys(SCHEMAS) as Def[]) {
      const names = files(join(FIXTURES, def));
      expect(names.length, def).toBeGreaterThan(0);
      for (const name of names) {
        const text = readFileSync(join(FIXTURES, def, name), 'utf8');
        const read = fromWire(SCHEMAS[def], JSON.parse(text), { strict: true });
        expect(read.unrecognized, `${def}/${name}`).toEqual([]);
        expect(`${JSON.stringify(toWire(SCHEMAS[def], read.message), null, 2)}\n`, `${def}/${name}`).toBe(text);
      }
    }
  });

  test('every invalid fixture is refused, by a consumer lenient read too', () => {
    let count = 0;
    for (const def of Object.keys(SCHEMAS) as Def[]) {
      for (const name of files(join(FIXTURES, 'invalid', def))) {
        const value: unknown = JSON.parse(readFileSync(join(FIXTURES, 'invalid', def, name), 'utf8'));
        expect(() => fromWire(SCHEMAS[def], value, { strict: true }), `${def}/${name}`).toThrow(WireJsonError);
        expect(() => fromWire(SCHEMAS[def], value), `${def}/${name}`).toThrow(WireJsonError);
        count += 1;
      }
    }
    expect(count).toBe(12);
  });

  test('a change of a newer kind passes a lenient read on its envelope, and its blob matches it', () => {
    const value = JSON.parse(readFileSync(join(FIXTURES, 'future/Change/star.json'), 'utf8')) as { blobs: BlobRef[] };
    expect(() => fromWire(ChangeSchema, value, { strict: true })).toThrow(WireJsonError);
    const read = fromWire(ChangeSchema, value);
    expect(read.unrecognized).toEqual(expect.arrayContaining(['kind', 'star']));
    for (const blob of value.blobs) {
      const bytes = readFileSync(join(FIXTURES, 'future/blobs', blob.path));
      expect([bytes.length, sha256(bytes)]).toEqual([blob.size_bytes, blob.sha256]);
    }
  });

  test('the sample archive is the first page applied to an empty store', () => {
    const page = JSON.parse(readFileSync(join(FIXTURES, 'ChangePage/first-page.json'), 'utf8')) as {
      changes: { seq: number; blobs: BlobRef[] }[];
    };
    const archive = join(FIXTURES, 'archive');
    expect(readFileSync(join(archive, 'VERSION'), 'utf8')).toBe('recall-archive-v1\n');
    // One day file, one compact line per record (the highest seq), in seq order.
    const lines = readFileSync(join(archive, 'changes/2026/10/10.jsonl'), 'utf8');
    expect(lines).toBe(`${page.changes.map((change) => JSON.stringify(change)).join('\n')}\n`);
    for (const line of lines.trimEnd().split('\n')) {
      const read = fromWire(ChangeSchema, JSON.parse(line), { strict: true });
      expect(JSON.stringify(toWire(ChangeSchema, read.message))).toBe(line);
    }
    const synced = readFileSync(join(FIXTURES, 'ArchiveState/synced.json'), 'utf8');
    expect(readFileSync(join(archive, 'state.json'), 'utf8')).toBe(synced);
    const blobs = page.changes.flatMap((change) => change.blobs);
    expect(blobs.length).toBe(1);
    for (const blob of blobs) {
      const bytes = readFileSync(join(archive, 'blobs', blob.path));
      expect([bytes.length, sha256(bytes)]).toEqual([blob.size_bytes, blob.sha256]);
    }
  });
});
