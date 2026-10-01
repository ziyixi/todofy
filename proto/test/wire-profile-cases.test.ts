/**
 * The shared edge cases of the wire JSON profile (testdata/wire-profile-cases.json). The Python twin,
 * test/python/test_wire_profile_cases.py, runs the same file, so the two codecs give the same verdict and
 * the same bytes on every case: timestamps, integer spellings, enum look-alikes, missing REQUIRED fields.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { DescMessage } from '@bufbuild/protobuf';
import { TaskIntentRefSchema, TaskIntentResultSchema, TaskIntentSchema } from '../ts/todofy/taskintent/v1/task_intent_pb.ts';
import { fromWire, toWire, WireJsonError } from '../ts/wire-json.ts';
import { CASES_FILE } from './fixtures.ts';

interface Case {
  readonly name: string;
  readonly message: 'TaskIntent' | 'TaskIntentRef' | 'TaskIntentResult';
  readonly strict: boolean;
  readonly input: unknown;
  readonly wire?: unknown;
  readonly unrecognized?: readonly string[];
  readonly error?: true;
}

const { cases } = JSON.parse(readFileSync(CASES_FILE, 'utf8')) as { cases: Case[] };
const SCHEMAS: Record<Case['message'], DescMessage> = {
  TaskIntent: TaskIntentSchema,
  TaskIntentRef: TaskIntentRefSchema,
  TaskIntentResult: TaskIntentResultSchema,
};

describe('wire profile edge cases shared with Python', () => {
  test('the file has every case, each under its own name', () => {
    // 34 when this suite was ported from the spike; cases are only ever added (test/python checks the same).
    expect(cases.length).toBeGreaterThanOrEqual(34);
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });

  test.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const schema = SCHEMAS[c.message];
    if (c.error === true) {
      expect(() => fromWire(schema, c.input, { strict: c.strict })).toThrow(WireJsonError);
      return;
    }
    const read = fromWire(schema, c.input, { strict: c.strict });
    expect(read.unrecognized).toEqual(c.unrecognized);
    expect(JSON.stringify(toWire(schema, read.message))).toBe(JSON.stringify(c.wire));
  });
});
