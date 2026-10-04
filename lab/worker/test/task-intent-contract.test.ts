/**
 * contracts/task-intent-v1 on Lab's side: the fixtures against the schema (with ops-v1's dependency-free
 * validator, the same subset Todofy's Python jsonschema check must agree with), the generated types of
 * proto/todofy/taskintent/v1/task_intent.proto and the wire JSON profile against the schema on every
 * fixture, and the constants of task-intent-v1.ts against the schema. Lab is the proposer: the intents it
 * builds and the results it stores must pass the same checks.
 */
import { describe, expect, it } from 'vitest';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import schema from '../../../contracts/task-intent-v1/task-intent-v1.schema.json';
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
import { asResult, buildIntent, freeze, type SendCard } from '../src/intent.ts';

const valid = import.meta.glob('../../../contracts/task-intent-v1/fixtures/*/*.json', { import: 'default', eager: true });
const invalid = import.meta.glob('../../../contracts/task-intent-v1/fixtures/invalid/*/*.json', { import: 'default', eager: true });
const DEFS = ['TaskIntent', 'TaskIntentRef', 'TaskIntentResult'] as const;
type Def = (typeof DEFS)[number];
const MESSAGES: Record<Def, DescMessage> = { TaskIntent: TaskIntentSchema, TaskIntentRef: TaskIntentRefSchema, TaskIntentResult: TaskIntentResultSchema };
// The invalid fixtures the wire profile reads: each breaks only a value rule (a length, a pattern, a range,
// a count), which the schema holds (Lab's freeze for intents, asResult for results); the codec sees every other.
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

function defOf(path: string): Def {
  const match = /fixtures\/(?:invalid\/)?([^/]+)\/[^/]+\.json$/.exec(path);
  const def = DEFS.find((d) => d === match?.[1]);
  if (def === undefined) throw new Error(`fixture outside a known $defs folder: ${path}`);
  return def;
}

function fileOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

type Json = Record<string, unknown>;
const defs = (schema as { $defs: Record<string, Json> }).$defs;
const props = (name: string) => (defs[name]?.['properties'] ?? {}) as Record<string, Json>;

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
      expect(Object.keys(valid).some((path) => defOf(path) === def), def).toBe(true);
      expect(Object.keys(invalid).some((path) => defOf(path) === def), def).toBe(true);
    }
  });

  it('accepts every valid fixture', () => {
    for (const [path, value] of Object.entries(valid)) expect(validate(schema, defOf(path), value), path).toEqual([]);
  });

  it('refuses every invalid fixture', () => {
    for (const [path, value] of Object.entries(invalid)) expect(validate(schema, defOf(path), value).length, path).toBeGreaterThan(0);
  });

  it('keeps every intent id unique across the valid intent fixtures', () => {
    const ids = Object.entries(valid)
      .filter(([path]) => defOf(path) === 'TaskIntent')
      .map(([, value]) => (value as { intent_id: string }).intent_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses the Watch deployment supplied by the caller and keeps the Lab host fixed', () => {
    const hosts = taskIntentUrlHosts('watch.example.test');
    expect(hosts['watch']).toContain('watch.example.test');
    expect(hosts['watch']).not.toContain('watch.ziyixi.science');
    expect(hosts['lab']).toEqual(['arxiv.org']);
  });

  it('links only to hosts the source may use', () => {
    for (const [path, value] of Object.entries(valid)) {
      if (defOf(path) !== 'TaskIntent') continue;
      const intent = value as { source: string; items: { url?: string }[] };
      for (const item of intent.items) {
        if (item.url !== undefined) expect(taskIntentUrlHosts('watch.ziyixi.science')[intent.source]).toContain(new URL(item.url).hostname);
      }
    }
  });
});

describe('the codec and the schema agree on every fixture', () => {
  it.each(Object.entries(valid))('%s reads and keeps its compact bytes', (path, value) => {
    const def = defOf(path);
    // Inputs strictly, outputs (which carry null) leniently with nothing unrecognized.
    const read = fromWire(MESSAGES[def], value, { strict: def !== 'TaskIntentResult' });
    expect(read.unrecognized).toEqual([]);
    expect(JSON.stringify(toWire(MESSAGES[def], read.message))).toBe(JSON.stringify(value));
  });

  it.each(Object.entries(invalid))('%s: the codec sees it unless only a value rule breaks', (path, value) => {
    const def = defOf(path);
    let seen: boolean;
    try {
      seen = fromWire(MESSAGES[def], value, { strict: def !== 'TaskIntentResult' }).unrecognized.length > 0;
    } catch (error) {
      if (!(error instanceof WireJsonError)) throw error;
      seen = true;
    }
    expect(seen).toBe(!VALUE_RULES_ONLY.has(fileOf(path)));
  });

  it.each(Object.entries(invalid).filter(([path]) => defOf(path) === 'TaskIntentResult'))(
    '%s: Lab refuses it, or reads past an addition a newer Todofy may make',
    (path, value) => {
      const intent = (value as { intent_id: string }).intent_id;
      // An unknown field or error code is open (outputs); an unknown state takes the default branch.
      const read = (() => {
        try {
          return fromWire(TaskIntentResultSchema, value);
        } catch {
          return null;
        }
      })();
      const openAddition = read !== null && read.unrecognized.length > 0 && read.message.state !== State.UNSPECIFIED;
      expect(asResult(value, intent) !== null, path).toBe(openAddition);
    },
  );
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

describe('every intent Lab builds', () => {
  const cards: SendCard[] = [
    { position: 2, paper_id: 'arxiv:2609.00002', title: 'Synthetic "quoted" <title> & more', brief: '合成简介。第二句。' },
    { position: 1, paper_id: 'arxiv:2609.00001', title: 'First synthetic paper', brief: null },
    { position: 3, paper_id: 'arxiv:hep-th/9901001', title: '合成标题', brief: '没有句号' },
  ];

  it.each(['subtasks', 'separate'] as const)('%s: passes the schema and reads strictly back to its frozen bytes', (mode) => {
    for (const host of ['lab.example.com', null]) {
      const intent = buildIntent('2026-09-30', 1, mode, cards, host);
      const frozen = intent === null ? null : freeze(intent);
      if (frozen === null) throw new Error('Lab built no intent');
      expect(validate(schema, 'TaskIntent', JSON.parse(frozen))).toEqual([]);
      const { message } = fromWire(TaskIntentSchema, JSON.parse(frozen), { strict: true });
      expect(JSON.stringify(toWire(TaskIntentSchema, message))).toBe(frozen);
    }
  });
});
