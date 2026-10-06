/**
 * contracts/task-intent-v1 on the proposer's side, for every fixture: the schema with ops-v1's dependency-free
 * validator (the same keyword subset Todofy's Python jsonschema check must agree with), the generated types of
 * proto/todofy/taskintent/v1/task_intent.proto and the wire JSON profile against the schema, and the constants of
 * task-intent-v1.ts against the schema. test/todofy.test.ts checks what this app builds and reads.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import { TASK_INTENT_LIMITS, taskIntentUrlHosts, TASK_INTENT_VERSION } from '../../../contracts/task-intent-v1/task-intent-v1.ts';
import type { DescMessage } from '@ziyixi/proto/protobuf';
import {
  ErrorCode,
  ErrorCodeSchema,
  Mode,
  ModeSchema,
  Source,
  SourceSchema,
  State,
  StateSchema,
  TaskIntentRefSchema,
  TaskIntentResultSchema,
  TaskIntentSchema,
} from '@ziyixi/proto/todofy/taskintent/v1/task_intent_pb';
import { fromWire, toWire, wireEnum, WireJsonError } from '@ziyixi/proto/wire-json';

/** A file next to this test (the Workers URL type is not Node's, so paths are strings). */
const path = (relative: string): string => decodeURIComponent(new URL(relative, import.meta.url).pathname);
const CONTRACT = path('../../../contracts/task-intent-v1/');
const DEFS = ['TaskIntent', 'TaskIntentRef', 'TaskIntentResult'] as const;
type Def = (typeof DEFS)[number];
type Json = Record<string, unknown>;
const MESSAGES: Record<Def, DescMessage> = { TaskIntent: TaskIntentSchema, TaskIntentRef: TaskIntentRefSchema, TaskIntentResult: TaskIntentResultSchema };
const schema = JSON.parse(readFileSync(`${CONTRACT}task-intent-v1.schema.json`, 'utf8')) as { $defs: Record<string, Json> };
const defs = schema.$defs;
const props = (name: string) => (defs[name]?.['properties'] ?? {}) as Record<string, Json>;

/** Every fixture of `folder` (fixtures/ or fixtures/invalid/) as [def/file, def, value]. */
function fixtures(folder: string): [string, Def, unknown][] {
  return DEFS.flatMap((def) =>
    readdirSync(`${CONTRACT}${folder}${def}`)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file): [string, Def, unknown] => [`${def}/${file}`, def, JSON.parse(readFileSync(`${CONTRACT}${folder}${def}/${file}`, 'utf8'))]),
  );
}
const valid = fixtures('fixtures/');
const invalid = fixtures('fixtures/invalid/');

// The invalid fixtures the wire profile reads: each breaks only a value rule (a length, a pattern, a range, a count),
// which the schema and Todofy's own checks hold; the codec sees every other.
const VALUE_RULES_ONLY = new Set([
  'description-too-long.json',
  'duplicate-items.json',
  'empty-title.json',
  'http-url.json',
  'intent-id-uppercase.json',
  'newline-in-title.json',
  'no-items.json',
  'parent-title-too-long.json',
  'tab-in-description.json',
  'too-many-items.json',
  'trailing-newline-in-title.json',
  'url-with-query.json',
  'wrong-version.json',
  'too-many-tasks.json',
  'zero-retry-after.json',
]);

describe('the dependency-free validator (contracts/ops-v1/validate.mjs)', () => {
  it('refuses keywords and references it does not implement, so a schema edit cannot be skipped silently', () => {
    expect(() => validate({ $defs: { X: { if: { type: 'string' } } } }, 'X', 'a')).toThrow(/does not implement the keyword "if"/);
    expect(() => validate({ $defs: { X: { $ref: 'other.json#/$defs/Y' } } }, 'X', 'a')).toThrow(/unsupported \$ref/);
    expect(() => validate({ $defs: {} }, 'Missing', 'a')).toThrow(/no \$defs entry Missing/);
  });
});

describe('task-intent-v1 fixtures', () => {
  it('has fixtures for every definition, valid and invalid', () => {
    for (const def of DEFS) {
      expect(valid.some(([, d]) => d === def), def).toBe(true);
      expect(invalid.some(([, d]) => d === def), def).toBe(true);
    }
  });

  it('accepts every valid fixture', () => {
    for (const [name, def, value] of valid) expect(validate(schema, def, value), name).toEqual([]);
  });

  it('refuses every invalid fixture', () => {
    for (const [name, def, value] of invalid) expect(validate(schema, def, value).length, name).toBeGreaterThan(0);
  });

  it('keeps every intent id unique across the valid intent fixtures', () => {
    const ids = valid.filter(([, def]) => def === 'TaskIntent').map(([, , value]) => (value as { intent_id: string }).intent_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses the Watch deployment supplied by the caller', () => {
    const hosts = taskIntentUrlHosts('watch.example.test');
    expect(hosts).toEqual({ watch: ['watch.example.test'] });
  });

  it('links only to hosts the source may use', () => {
    for (const [name, def, value] of valid) {
      if (def !== 'TaskIntent') continue;
      const intent = value as { source: string; items: { url?: string }[] };
      for (const item of intent.items) {
        if (item.url !== undefined) expect(taskIntentUrlHosts('watch.ziyixi.science')[intent.source], name).toContain(new URL(item.url).hostname);
      }
    }
  });
});

describe('the codec and the schema agree on every fixture', () => {
  it.each(valid)('%s reads and keeps its compact bytes', (_name, def, value) => {
    // Inputs strictly, outputs (which carry null) leniently with nothing unrecognized.
    const read = fromWire(MESSAGES[def], value, { strict: def !== 'TaskIntentResult' });
    expect(read.unrecognized).toEqual([]);
    expect(JSON.stringify(toWire(MESSAGES[def], read.message))).toBe(JSON.stringify(value));
  });

  it.each(invalid)('%s: the codec sees it unless only a value rule breaks', (name, def, value) => {
    let seen: boolean;
    try {
      seen = fromWire(MESSAGES[def], value, { strict: def !== 'TaskIntentResult' }).unrecognized.length > 0;
    } catch (error) {
      if (!(error instanceof WireJsonError)) throw error;
      seen = true;
    }
    expect(seen).toBe(!VALUE_RULES_ONLY.has(name.slice(name.indexOf('/') + 1)));
  });
});

describe('the generated enums and the task-intent-v1.ts constants', () => {
  it('match the schema', () => {
    expect(defs['Version']?.['const']).toBe(TASK_INTENT_VERSION);
    expect(defs['Source']?.['enum']).toEqual(wireEnum(SourceSchema, Source).names);
    expect(defs['Mode']?.['enum']).toEqual(wireEnum(ModeSchema, Mode).names);
    expect(defs['State']?.['enum']).toEqual(wireEnum(StateSchema, State).names);
    expect(defs['ErrorCode']?.['enum']).toEqual(wireEnum(ErrorCodeSchema, ErrorCode).names);
    expect(Object.keys(taskIntentUrlHosts('watch.ziyixi.science'))).toEqual(wireEnum(SourceSchema, Source).names);
    const items = props('TaskIntent')['items'] ?? {};
    expect(items['maxItems']).toBe(TASK_INTENT_LIMITS.itemsMax);
    expect(defs['ParentTitle']?.['maxLength']).toBe(TASK_INTENT_LIMITS.parentTitleMax);
    expect(defs['ItemTitle']?.['maxLength']).toBe(TASK_INTENT_LIMITS.itemTitleMax);
    expect(defs['BlockText']?.['maxLength']).toBe(TASK_INTENT_LIMITS.descriptionMax);
    expect(defs['HttpsUrl']?.['maxLength']).toBe(TASK_INTENT_LIMITS.urlMax);
    expect(props('TaskIntentResult')['tasks_total']?.['maximum']).toBe(TASK_INTENT_LIMITS.tasksMax);
    expect(props('TaskIntentResult')['tasks_created']?.['maximum']).toBe(TASK_INTENT_LIMITS.tasksMax);
    const retry = (props('TaskIntentResult')['retry_after_seconds']?.['anyOf'] as Json[] | undefined)?.[0];
    expect([retry?.['minimum'], retry?.['maximum']]).toEqual([1, TASK_INTENT_LIMITS.retryAfterMaxSeconds]);
  });
});
