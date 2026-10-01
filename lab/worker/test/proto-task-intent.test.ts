/**
 * The proto/ IDL of task-intent-v1 against Lab's view of the contract (proto/README.md). Test only:
 * nothing in src/ imports @ziyixi/proto yet, so Lab's bundle does not change. It pins that the generated
 * enums carry exactly the values Lab sends and reads (task-intent-v1.ts), and that the wire JSON profile
 * keeps the bytes Lab freezes and hashes: every intent it builds reads strictly and writes back identically.
 */
import { describe, expect, it } from 'vitest';
import type { DescEnum } from '@ziyixi/proto/protobuf';
import {
  ErrorCodeSchema,
  ModeSchema,
  SourceSchema,
  StateSchema,
  TaskIntentResultSchema,
  TaskIntentSchema,
} from '@ziyixi/proto/todofy/taskintent/v1/task_intent_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import {
  TASK_INTENT_ERROR_CODES,
  TASK_INTENT_MODES,
  TASK_INTENT_SOURCES,
  TASK_INTENT_STATES,
} from '../../../contracts/task-intent-v1/task-intent-v1.ts';
import { buildIntent, freeze, type SendCard } from '../src/intent.ts';

const results = import.meta.glob('../../../contracts/task-intent-v1/fixtures/TaskIntentResult/*.json', { import: 'default', eager: true });

const cards: SendCard[] = [
  { position: 2, paper_id: 'arxiv:2609.00002', title: 'Synthetic "quoted" <title> & more', brief: '合成简介。第二句。' },
  { position: 1, paper_id: 'arxiv:2609.00001', title: 'First synthetic paper', brief: null },
  { position: 3, paper_id: 'arxiv:hep-th/9901001', title: '合成标题', brief: '没有句号' },
];

/** The v1 wire names of an enum: the value names without the prefix, in lower case, zero value left out. */
function wireNames(desc: DescEnum): string[] {
  const prefix = (desc.sharedPrefix ?? '').length;
  return desc.values.filter((value) => value.number !== 0).map((value) => value.name.slice(prefix).toLowerCase());
}

describe('the task-intent-v1 IDL', () => {
  it.each([
    ['Source', SourceSchema, TASK_INTENT_SOURCES],
    ['Mode', ModeSchema, TASK_INTENT_MODES],
    ['State', StateSchema, TASK_INTENT_STATES],
    ['ErrorCode', ErrorCodeSchema, TASK_INTENT_ERROR_CODES],
  ] as const)('enum %s has exactly the values of task-intent-v1.ts', (_name, desc, values) => {
    expect(wireNames(desc)).toEqual([...values]);
  });

  it.each(['subtasks', 'separate'] as const)('%s: every intent Lab builds keeps its frozen bytes', (mode) => {
    for (const host of ['lab.example.com', null]) {
      const intent = buildIntent('2026-09-30', 1, mode, cards, host);
      const frozen = intent === null ? null : freeze(intent);
      if (frozen === null) throw new Error('Lab built no intent');
      const { message } = fromWire(TaskIntentSchema, JSON.parse(frozen), { strict: true });
      expect(JSON.stringify(toWire(TaskIntentSchema, message))).toBe(frozen);
    }
  });

  it.each(Object.entries(results))('%s reads leniently with nothing unrecognized', (_path, fixture) => {
    const { message, unrecognized } = fromWire(TaskIntentResultSchema, fixture);
    expect(unrecognized).toEqual([]);
    expect(toWire(TaskIntentResultSchema, message)).toEqual(fixture);
  });
});
