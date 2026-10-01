/**
 * task_intent.proto mirrors contracts/task-intent-v1 exactly (test/python/test_task_intent.py is the
 * Python twin): the enum and field sets equal the JSON Schema's, every valid fixture reads (strict for
 * inputs, lenient for outputs) and writes back to the same compact bytes, a strict read refuses what the
 * structure can see, and a newer producer's answer reads leniently into the default branch.
 */
import { describe, expect, test } from 'vitest';
import type { DescEnum, DescMessage } from '@bufbuild/protobuf';
import {
  ErrorCode,
  ErrorCodeSchema,
  ModeSchema,
  SourceSchema,
  State,
  StateSchema,
  TaskIntentItemSchema,
  TaskIntentParentSchema,
  TaskIntentRefSchema,
  TaskIntentResultSchema,
  TaskIntentSchema,
  type TaskIntentResult,
} from '../ts/todofy/taskintent/v1/task_intent_pb.ts';
import { fromWire, toWire, WireJsonError } from '../ts/wire-json.ts';
import { fixtures, SCHEMA } from './fixtures.ts';

function wireNames(desc: DescEnum): string[] {
  const prefix = (desc.sharedPrefix ?? '').length;
  return desc.values.filter((v) => v.number !== 0).map((v) => v.name.slice(prefix).toLowerCase());
}

function fieldNames(desc: DescMessage): string[] {
  return [...desc.fields].sort((a, b) => a.number - b.number).map((f) => f.name);
}

/** The shape of a consumer's branch on the state: every known state, then a default. */
function branch(result: TaskIntentResult): string {
  switch (result.state) {
    case State.PENDING:
    case State.PAUSED:
      return 'poll';
    case State.CREATED:
    case State.DUPLICATE:
      return 'done';
    case State.FAILED:
    case State.REJECTED:
    case State.NOT_FOUND:
      return 'final';
    default:
      return 'unknown_poll_later';
  }
}

// The invalid TaskIntent fixtures a strict read refuses on its own; every other one breaks a value rule.
const STRUCTURAL = new Set(['missing-parent.json', 'unknown-item-field.json', 'unknown-mode.json', 'unknown-source.json', 'unknown-top-field.json']);

describe('the IDL equals the JSON Schema', () => {
  test.each([
    ['Source', SourceSchema],
    ['Mode', ModeSchema],
    ['State', StateSchema],
    ['ErrorCode', ErrorCodeSchema],
  ] as const)('enum %s: same values in the same order, zero value *_UNSPECIFIED', (def, desc) => {
    expect(wireNames(desc)).toEqual(SCHEMA.$defs[def]?.enum);
    expect(desc.values[0]?.name.endsWith('_UNSPECIFIED')).toBe(true);
  });

  test.each([
    ['Parent', TaskIntentParentSchema],
    ['Item', TaskIntentItemSchema],
    ['TaskIntent', TaskIntentSchema],
    ['TaskIntentRef', TaskIntentRefSchema],
    ['TaskIntentResult', TaskIntentResultSchema],
  ] as const)('message %s: same fields in the same order', (def, desc) => {
    expect(fieldNames(desc)).toEqual(Object.keys(SCHEMA.$defs[def]?.properties ?? {}));
  });
});

describe('every fixture round-trips byte for byte', () => {
  test.each(fixtures('TaskIntent'))('TaskIntent $name (strict read)', ({ value }) => {
    const { message } = fromWire(TaskIntentSchema, value, { strict: true });
    expect(JSON.stringify(toWire(TaskIntentSchema, message))).toBe(JSON.stringify(value));
  });

  test.each(fixtures('TaskIntentRef'))('TaskIntentRef $name (strict read)', ({ value }) => {
    const { message } = fromWire(TaskIntentRefSchema, value, { strict: true });
    expect(JSON.stringify(toWire(TaskIntentRefSchema, message))).toBe(JSON.stringify(value));
  });

  test.each(fixtures('TaskIntentResult'))('TaskIntentResult $name (lenient read)', ({ value }) => {
    const { message, unrecognized } = fromWire(TaskIntentResultSchema, value);
    expect(unrecognized).toEqual([]);
    expect(JSON.stringify(toWire(TaskIntentResultSchema, message))).toBe(JSON.stringify(value));
  });
});

describe('a strict read refuses what the structure can see', () => {
  test.each(fixtures('TaskIntent', true).filter((f) => STRUCTURAL.has(f.name)))('$name', ({ value }) => {
    expect(() => fromWire(TaskIntentSchema, value, { strict: true })).toThrow(WireJsonError);
  });

  test('value rules stay with the contract: a strict read is not a validation', () => {
    const valueRules = fixtures('TaskIntent', true).filter((f) => !STRUCTURAL.has(f.name));
    expect(valueRules.map((f) => f.name)).toEqual(expect.arrayContaining(['http-url.json', 'too-many-items.json']));
    for (const { value } of valueRules) expect(() => fromWire(TaskIntentSchema, value, { strict: true })).not.toThrow();
  });
});

describe('a newer producer, an older consumer', () => {
  // A newer Todofy: one more state, one more error code and one more field than this IDL knows.
  const newer = {
    ...(fixtures('TaskIntentResult').find((f) => f.name === 'created.json')?.value ?? {}),
    state: 'archived',
    error_code: 'quota_exhausted',
    hint_code: 'synthetic_hint',
  };

  test('a lenient read (an output) takes the default branch and says what it skipped', () => {
    const { message, unrecognized } = fromWire(TaskIntentResultSchema, newer);
    expect(unrecognized).toEqual(['state', 'error_code', 'hint_code']);
    expect(message.state).toBe(State.UNSPECIFIED);
    expect(message.errorCode).toBe(ErrorCode.UNSPECIFIED);
    expect(branch(message)).toBe('unknown_poll_later');
    expect(message.tasksCreated).toBe(4);
  });

  test('a strict read (an input) refuses the same additions', () => {
    expect(() => fromWire(TaskIntentResultSchema, newer, { strict: true })).toThrow(WireJsonError);
  });
});
