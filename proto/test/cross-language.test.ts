/**
 * Cross-language round trips of the wire JSON profile: bytes the TypeScript codec writes, read and written
 * again by the Python codec (test/python/roundtrip.py, in a child process), must come back identical, and
 * so must messages built in Python and read here. The corpus is every valid task-intent-v1 and ops-v1 fixture, every
 * mail-received-v1 event (current and legacy), every shared edge case that reads (doubles and maps among them), and
 * messages built in each language (every
 * state with every error code, both modes). This is what lets the watch app (TypeScript) and Todofy (Python) hash, freeze and compare each other's bytes.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { create, type DescMessage } from '@bufbuild/protobuf';
import { BookCardSchema, BookSchema } from '../ts/prototest/v1/prototest_pb.ts';
import { LabelSchema, NoteSchema, ParcelSchema } from '../ts/prototest/v1/rules_pb.ts';
import {
  ErrorCode,
  Mode,
  Source,
  State,
  TaskIntentRefSchema,
  TaskIntentResultSchema,
  TaskIntentSchema,
} from '../ts/todofy/taskintent/v1/task_intent_pb.ts';
import { MailReceivedEventSchema } from '../ts/mailhero/webhook/v1/mail_received_pb.ts';
import * as ops from '../ts/ops/v1/ops_pb.ts';
import { fromWire, toWire, WireJsonError } from '../ts/wire-json.ts';
import { CASES_FILE, fixtures, mailFixtures, OPS_CONTRACT } from './fixtures.ts';

/** A task-intent-v1 message by its short name, or a fixture of prototest/v1 (doubles, maps) by its full name. */
type Name = keyof typeof SCHEMAS;

interface ReadRequest {
  readonly message: Name;
  readonly strict: boolean;
  readonly text: string;
}

interface PythonAnswer {
  readonly read: readonly ({ text: string; unrecognized: string[] } | { error: string })[];
  readonly built: readonly { message: Name; text: string }[];
}

const SCHEMAS = {
  TaskIntent: TaskIntentSchema,
  TaskIntentRef: TaskIntentRefSchema,
  TaskIntentResult: TaskIntentResultSchema,
  'prototest.v1.Book': BookSchema,
  'prototest.v1.BookCard': BookCardSchema,
  'prototest.v1.Parcel': ParcelSchema,
  'prototest.v1.Label': LabelSchema,
  'prototest.v1.Note': NoteSchema,
  'ops.v1.OpsStatus': ops.OpsStatusSchema,
  'ops.v1.GuardState': ops.GuardStateSchema,
  'ops.v1.SetGuardInput': ops.SetGuardInputSchema,
  'ops.v1.StartCanaryInput': ops.StartCanaryInputSchema,
  'ops.v1.StartCanaryResult': ops.StartCanaryResultSchema,
  'ops.v1.CanaryDelivery': ops.CanaryDeliverySchema,
  'ops.v1.CanaryResult': ops.CanaryResultSchema,
  'ops.v1.OpsReport': ops.OpsReportSchema,
  'ops.v1.OpsReportReceipt': ops.OpsReportReceiptSchema,
  'mailhero.webhook.v1.MailReceivedEvent': MailReceivedEventSchema,
} satisfies Record<string, DescMessage>;
/** ops-v1's inputs, read strictly; its outputs are read leniently. */
const OPS_INPUTS = new Set(['SetGuardInput', 'StartCanaryInput', 'OpsReport']);
// npm run test:python uses the same interpreter (todofy-core's Python); PROTO_TEST_PYTHON overrides it.
const PYTHON = (process.env['PROTO_TEST_PYTHON'] ?? 'uv run --no-project --python 3.14 python').split(' ');

/** TypeScript's read and write of `text`: the compact bytes, or null when the read throws. */
function viaTypeScript(message: Name, text: string, strict: boolean): string | null {
  try {
    const schema: DescMessage = SCHEMAS[message];
    return JSON.stringify(toWire(schema, fromWire(schema, JSON.parse(text), { strict }).message, { lenient: !strict }));
  } catch (error) {
    if (error instanceof WireJsonError) return null;
    throw error;
  }
}

/** Messages built in TypeScript: every state with every error code (and none), both modes, a ref. */
function builtInTypeScript(): ReadRequest[] {
  const out: ReadRequest[] = [];
  const states = Object.values(State).filter((s) => s !== State.UNSPECIFIED);
  for (const state of states) {
    for (const code of Object.values(ErrorCode)) {
      const result = create(TaskIntentResultSchema, {
        version: 'task-intent-v1',
        source: Source.WATCH,
        intentId: `digest-2026-09-30-${String(state)}`,
        state,
        recorded: state !== State.NOT_FOUND && state !== State.REJECTED,
        tasksTotal: 31,
        tasksCreated: code % 32,
        errorCode: code,
        updatedAt: { seconds: 1_790_776_987n, nanos: code % 2 === 1 ? 250_000_000 : 0 },
        ...(code === ErrorCode.UNSPECIFIED ? {} : { retryAfterSeconds: 86_400 - code }),
      });
      out.push({ message: 'TaskIntentResult', strict: false, text: JSON.stringify(toWire(TaskIntentResultSchema, result)) });
    }
  }
  for (const mode of [Mode.SUBTASKS, Mode.SEPARATE]) {
    const intent = create(TaskIntentSchema, {
      version: 'task-intent-v1',
      source: Source.WATCH,
      intentId: 'digest-2026-09-30',
      mode,
      parent: { title: '网页监视 · "合成" <示例>', description: '' },
      items: [
        { title: 'A synthetic watch', url: 'https://watch.example.test/watches/w1' },
        { title: '合成标题\u2003全角', description: '第一行\n第二行 \\ 反斜杠' },
      ],
    });
    out.push({ message: 'TaskIntent', strict: true, text: JSON.stringify(toWire(TaskIntentSchema, intent)) });
  }
  out.push({
    message: 'TaskIntentRef',
    strict: true,
    text: JSON.stringify(toWire(TaskIntentRefSchema, create(TaskIntentRefSchema, { version: 'task-intent-v1', source: Source.WATCH, intentId: 'x' }))),
  });
  // An ops-v1 status as a producer builds it: counters and metrics in the producer's own order (keep_order), doubles.
  const status = create(ops.OpsStatusSchema, {
    version: 'ops-v1',
    app: 'todofy',
    generatedAt: '2026-09-29T15:00:00Z',
    health: ops.Health.DEGRADED,
    modes: { maintenance: false, processing_paused: true, backup_active: false },
    guard: { level: ops.GuardLevel.NORMAL },
    signals: [{ code: 'gemini_budget_80', severity: ops.Severity.WARNING, metrics: { percent: 82.4, used_tokens: 2_460_000, zeta: 0.0001 } }],
    counters: { zeta: 1, alpha: 2.5, middle: 3_865_470_566 },
    capabilities: ['canary_consumer', 'guard'],
  });
  out.push({ message: 'ops.v1.OpsStatus', strict: false, text: JSON.stringify(toWire(ops.OpsStatusSchema, status)) });
  return out;
}

/** Everything TypeScript writes: the fixtures and the shared cases after a TypeScript read, then its own messages. */
function corpus(): ReadRequest[] {
  const out: ReadRequest[] = [];
  for (const [message, strict] of [
    ['TaskIntent', true],
    ['TaskIntentRef', true],
    ['TaskIntentResult', false],
  ] as const) {
    for (const { text } of fixtures(message)) {
      const written = viaTypeScript(message, text, strict);
      if (written === null) throw new Error(`a valid ${message} fixture does not read`);
      out.push({ message, strict, text: written });
    }
  }
  for (const def of ['OpsStatus', 'GuardState', 'SetGuardInput', 'StartCanaryInput', 'StartCanaryResult', 'CanaryDelivery', 'CanaryResult', 'OpsReport', 'OpsReportReceipt'] as const) {
    const message = `ops.v1.${def}` as const;
    const strict = OPS_INPUTS.has(def);
    for (const { text } of fixtures(def, false, OPS_CONTRACT)) {
      const written = viaTypeScript(message, text, strict);
      if (written === null) throw new Error(`a valid ${def} fixture does not read`);
      out.push({ message, strict, text: written });
    }
  }
  // mail-received-v1: every golden event, current and frozen, as a consumer reads it (leniently).
  for (const { text } of [...mailFixtures(), ...mailFixtures(true)]) {
    const written = viaTypeScript('mailhero.webhook.v1.MailReceivedEvent', text, false);
    if (written === null) throw new Error('a mail-received-v1 fixture does not read');
    out.push({ message: 'mailhero.webhook.v1.MailReceivedEvent', strict: false, text: written });
  }
  const { cases } = JSON.parse(readFileSync(CASES_FILE, 'utf8')) as { cases: { message: Name; strict: boolean; input: unknown; error?: true }[] };
  for (const c of cases) {
    if (c.error === true) continue;
    const written = viaTypeScript(c.message, JSON.stringify(c.input), c.strict);
    if (written === null) throw new Error(`a reading case does not read: ${JSON.stringify(c.input)}`);
    out.push({ message: c.message, strict: c.strict, text: written });
  }
  return [...out, ...builtInTypeScript()];
}

let requests: ReadRequest[] = [];
let python: PythonAnswer = { read: [], built: [] };

beforeAll(() => {
  requests = corpus();
  const [command = 'python3', ...args] = PYTHON;
  const run = spawnSync(command, [...args, join(import.meta.dirname, 'python', 'roundtrip.py')], {
    cwd: join(import.meta.dirname, 'python'),
    input: JSON.stringify({ read: requests }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`roundtrip.py failed (${String(run.status)}): ${run.stderr}`);
  python = JSON.parse(run.stdout) as PythonAnswer;
}, 120_000);

describe('TypeScript writes, Python reads and writes the same bytes', () => {
  test('every corpus entry', () => {
    // 18 task-intent fixtures, 37 ops-v1 fixtures, the reading shared cases, 7 x 14 results, 2 intents, 1 ref, 1 status.
    expect(requests.length).toBeGreaterThan(18 + 37 + 98 + 4);
    expect(python.read).toHaveLength(requests.length);
    requests.forEach((request, i) => {
      expect(python.read[i], `${request.message} ${request.text}`).toEqual({ text: request.text, unrecognized: [] });
    });
  });

  test('every valid fixture keeps its compact bytes in both languages', () => {
    for (const message of ['TaskIntent', 'TaskIntentRef', 'TaskIntentResult'] as const) {
      for (const { name, value } of fixtures(message)) {
        const text = JSON.stringify(value);
        const i = requests.findIndex((r) => r.message === message && r.text === text);
        expect(i, `${message}/${name}`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('Python writes, TypeScript reads and writes the same bytes', () => {
  test('every message built in Python', () => {
    // 7 states x 14 codes, 2 intents, 1 ref, 1 ops status.
    expect(python.built).toHaveLength(7 * 14 + 2 + 1 + 1);
    for (const { message, text } of python.built) {
      const strict = message !== 'TaskIntentResult' && message !== 'ops.v1.OpsStatus';
      const read = fromWire(SCHEMAS[message], JSON.parse(text), { strict });
      expect(read.unrecognized).toEqual([]);
      expect(JSON.stringify(toWire(SCHEMAS[message], read.message)), text).toBe(text);
    }
  });

  test('the same messages built in both languages are the same bytes', () => {
    const ours = builtInTypeScript().map((r) => r.text);
    expect(python.built.map((b) => b.text)).toEqual(ours);
  });
});
