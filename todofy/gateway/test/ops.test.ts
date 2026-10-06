import { describe, expect, it } from 'vitest';
import { CanaryResultSchema, GuardStateSchema, OpsReportReceiptSchema, OpsStatusSchema } from '@ziyixi/proto/ops/v1/ops_pb';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { fromWire } from '@ziyixi/proto/wire-json';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import degraded from '../../../contracts/ops-v1/fixtures/OpsStatus/todofy-degraded.json';
import shed from '../../../contracts/ops-v1/fixtures/GuardState/shed-todofy.json';
import processing from '../../../contracts/ops-v1/fixtures/CanaryResult/processing-paused.json';
import daily from '../../../contracts/ops-v1/fixtures/OpsReport/daily.json';
import stored from '../../../contracts/ops-v1/fixtures/OpsReportReceipt/stored.json';
import intentSchema from '../../../contracts/task-intent-v1/task-intent-v1.schema.json';
import type { TaskIntentService } from '@ziyixi/proto/todofy/taskintent/v1/task_intent_pb';
import type { WireObject, WireService } from '@ziyixi/proto/wire-json';
import type { DescMessage } from '@ziyixi/proto/protobuf';
import subtasks from '../../../contracts/task-intent-v1/fixtures/TaskIntent/subtasks-3.json';
import watchRefFixture from '../../../contracts/task-intent-v1/fixtures/TaskIntentRef/watch.json';
import pendingNew from '../../../contracts/task-intent-v1/fixtures/TaskIntentResult/pending-new.json';
import created from '../../../contracts/task-intent-v1/fixtures/TaskIntentResult/created.json';
import watchDigest from '../../../contracts/task-intent-v1/fixtures/TaskIntent/watch-digest.json';
import { Intents as ExportedIntents, Ops as Exported } from '../src/index.ts';
import { Intents, Ops } from '../src/ops.ts';
import { fakes, type CoreReply } from './helpers.ts';

const INTENT_SCHEMA = intentSchema as { $defs: Record<string, unknown> };
const EVENT_ID = 'f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710016';

function entrypoint(reply: CoreReply) {
  const { env, core } = fakes({}, reply);
  return { ops: new Ops({} as ExecutionContext, env), core };
}

/** Whether `value` keeps ops-v1's rules as a producer writes them (a strict read; it throws otherwise). */
function valid(schema: DescMessage, value: unknown): boolean {
  return fromWire(schema, value, { strict: true }).unrecognized.length === 0;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

describe('the Ops entrypoint (contracts/ops-v1)', () => {
  it('is exported by the Worker next to its default handlers', () => {
    expect(Exported).toBe(Ops);
  });

  it('answers status() with the core value, which must validate as OpsStatus', async () => {
    const { ops, core } = entrypoint(() => ({ ok: degraded }));
    const status = await ops.status();
    expect(status).toEqual(degraded);
    expect(valid(OpsStatusSchema, status)).toBe(true);
    expect(core.map((call) => [call.instance, call.method, call.args])).toEqual([['inbox-v1', 'ops_status', []]]);
  });

  it('passes setGuard input on as JSON text and returns the GuardState', async () => {
    const { ops, core } = entrypoint(() => ({ ok: shed }));
    const input = { level: 'shed', reason: 'd1_reads_high', until: '2026-09-30T00:00:00Z' } as const;
    const state: wire.GuardState = await ops.setGuard(input);
    expect(valid(GuardStateSchema, state)).toBe(true);
    expect(core[0]?.method).toBe('ops_set_guard');
    expect(JSON.parse(core[0]?.args[0] as string)).toEqual(input);
  });

  it('forwards canaryResult by event ID', async () => {
    const { ops, core } = entrypoint(() => ({ ok: processing }));
    expect(valid(CanaryResultSchema, await ops.canaryResult(EVENT_ID))).toBe(true);
    expect(core[0]?.args).toEqual([EVENT_ID]);
  });

  it('forwards reportOps as compact JSON and returns the receipt', async () => {
    const { ops, core } = entrypoint(() => ({ ok: stored }));
    const receipt = await ops.reportOps(daily as Parameters<Ops['reportOps']>[0]);
    expect(valid(OpsReportReceiptSchema, receipt)).toBe(true);
    expect(core[0]?.args).toEqual([JSON.stringify(daily)]);
  });

  it.each(['invalid_input', 'busy', 'unavailable'])('rejects with the core error code %s', async (code) => {
    const { ops } = entrypoint(() => ({ error: code }));
    expect(await rejection(ops.status())).toBe(code);
    expect(await rejection(ops.setGuard({ level: 'normal', reason: 'ok', until: null }))).toBe(code);
    expect(await rejection(ops.canaryResult(EVENT_ID))).toBe(code);
    expect(await rejection(ops.reportOps({ generated_at: '2026-09-29T23:40:00Z', items: [] }))).toBe(code);
  });

  it('rejects unavailable when the core call itself fails', async () => {
    const { ops } = entrypoint(() => {
      throw new Error('PythonError: Traceback (most recent call last) ...');
    });
    expect(await rejection(ops.status())).toBe('unavailable');
    expect(await rejection(ops.canaryResult(EVENT_ID))).toBe('unavailable');
  });

  it('refuses what it cannot pass on without waking the core', async () => {
    const { ops, core } = entrypoint(() => ({ ok: stored }));
    expect(await rejection(ops.canaryResult(7 as unknown as string))).toBe('invalid_input');
    expect(await rejection(ops.setGuard(undefined as unknown as { level: 'normal'; reason: string; until: null }))).toBe(
      'invalid_input',
    );
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(await rejection(ops.setGuard(cyclic as never))).toBe('invalid_input');
    // Over the 8 KiB bound as compact JSON (ops-v1 OPS_LIMITS.reportMaxBytes).
    const item = { source: 'dashboard', code: 'x'.repeat(40), severity: 'warning', since: '2026-09-29T00:00:00Z' };
    const metrics = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`m${String(i)}_${'y'.repeat(30)}`, i]));
    const big = { generated_at: '2026-09-29T23:40:00Z', items: Array.from({ length: 20 }, () => ({ ...item, metrics })) };
    expect(new TextEncoder().encode(JSON.stringify(big)).byteLength).toBeGreaterThan(8192);
    expect(await rejection(ops.reportOps(big as never))).toBe('invalid_input');
    expect(core).toEqual([]);
  });
});

describe('task intents are not on the Ops entrypoint (contracts/task-intent-v1)', () => {
  it('has only the ops-v1 methods: a proposer binds Intents', () => {
    const methods = Object.getOwnPropertyNames(Ops.prototype).filter((name) => name !== 'constructor' && name !== 'call');
    expect(methods.sort()).toEqual(['canaryResult', 'reportOps', 'setGuard', 'status']);
    const { ops } = entrypoint(() => ({ ok: created }));
    for (const name of ['proposeTasks', 'taskIntentStatus']) expect(name in ops).toBe(false);
  });
});

describe('the Intents entrypoint: task intents of the one source its binding names (contracts/task-intent-v1)', () => {
  const watchIntent: WireObject = watchDigest;
  const watchRef: WireObject = { version: 'task-intent-v1', source: 'watch', intent_id: 'digest-2026-10-01' };
  const intent: WireObject = subtasks;
  const ref: WireObject = watchRefFixture;

  function intents(props: unknown, reply: CoreReply = () => ({ ok: pendingNew })) {
    const { env, core } = fakes({}, reply);
    return { entry: new Intents({ props } as ExecutionContext<never>, env), core };
  }

  it('is exported, and has only the two task-intent-v1 methods', () => {
    expect(ExportedIntents).toBe(Intents);
    const methods = Object.getOwnPropertyNames(Intents.prototype).filter((name) => name !== 'constructor' && !name.startsWith('bound'));
    expect(methods.sort()).toEqual(['proposeTasks', 'taskIntentStatus']);
    const { entry } = intents({ source: 'watch' });
    for (const name of ['status', 'setGuard', 'canaryResult', 'reportOps']) expect(name in entry).toBe(false);
  });

  it("forwards the binding's own source to the core", async () => {
    const { entry, core } = intents({ source: 'watch' });
    expect(await entry.proposeTasks(watchIntent)).toEqual(pendingNew);
    await entry.taskIntentStatus(watchRef);
    expect(core.map((call) => [call.method, call.args])).toEqual([
      ['task_intent_propose', [JSON.stringify(watchIntent)]],
      ['task_intent_status', [JSON.stringify(watchRef)]],
    ]);
  });

  it('implements the generated TaskIntentService as Workers RPC methods', () => {
    const { entry } = intents({ source: 'watch' });
    const declared: WireService<typeof TaskIntentService> = entry;
    expect(typeof declared.proposeTasks).toBe('function');
    expect(typeof declared.taskIntentStatus).toBe('function');
  });

  it('forwards proposeTasks as compact JSON and returns the core value, a valid TaskIntentResult', async () => {
    const { entry, core } = intents({ source: 'watch' });
    const result = await entry.proposeTasks(intent);
    expect(result).toEqual(pendingNew);
    expect(validate(INTENT_SCHEMA, 'TaskIntentResult', result)).toEqual([]);
    expect(core.map((call) => [call.instance, call.method, call.args])).toEqual([
      ['inbox-v1', 'task_intent_propose', [JSON.stringify(intent)]],
    ]);
  });

  it('forwards taskIntentStatus by reference', async () => {
    const { entry, core } = intents({ source: 'watch' }, () => ({ ok: created }));
    expect(validate(INTENT_SCHEMA, 'TaskIntentResult', await entry.taskIntentStatus(ref))).toEqual([]);
    expect(core.map((call) => [call.method, call.args])).toEqual([['task_intent_status', [JSON.stringify(ref)]]]);
  });

  it.each(['invalid_input', 'busy', 'unavailable'])('rejects with the core error code %s', async (code) => {
    const { entry } = intents({ source: 'watch' }, () => ({ error: code }));
    expect(await rejection(entry.proposeTasks(intent))).toBe(code);
    expect(await rejection(entry.taskIntentStatus(ref))).toBe(code);
  });

  it('rejects unavailable when the core call itself fails', async () => {
    const { entry } = intents({ source: 'watch' }, () => {
      throw new Error('PythonError: Traceback (most recent call last) ...');
    });
    expect(await rejection(entry.proposeTasks(intent))).toBe('unavailable');
    expect(await rejection(entry.taskIntentStatus(ref))).toBe('unavailable');
  });

  it('refuses input of its source over 64 KiB or not JSON without waking the core', async () => {
    const { entry, core } = intents({ source: 'watch' });
    const item = { title: 'x'.repeat(300), url: 'https://watch.ziyixi.science/watches/w2609-00001', description: 'y'.repeat(1000) };
    const items = Array.from({ length: 60 }, (_, i) => ({ ...item, title: `${String(i)} ${item.title}` }));
    const big = { ...intent, items };
    expect(new TextEncoder().encode(JSON.stringify(big)).byteLength).toBeGreaterThan(65536);
    expect(await rejection(entry.proposeTasks(big))).toBe('invalid_input');
    const cyclic: Record<string, unknown> = { ...ref };
    cyclic['self'] = cyclic;
    expect(await rejection(entry.taskIntentStatus(cyclic as never))).toBe('invalid_input');
    expect(core).toEqual([]);
  });

  it.each([
    ['another source', { source: 'watch' }, intentOf('other')],
    ['no props', undefined, intentOf('watch')],
    ['props without a source', {}, intentOf('watch')],
    ['an empty source', { source: '' }, intentOf('')],
    ['a source that is not text', { source: 1 }, intentOf('watch')],
  ])('refuses %s with invalid_input before waking the core', async (_, props, input) => {
    const { entry, core } = intents(props);
    expect(await rejection(entry.proposeTasks(input))).toBe('invalid_input');
    expect(await rejection(entry.taskIntentStatus({ ...watchRef, source: input['source'] ?? null }))).toBe('invalid_input');
    expect(await rejection(entry.proposeTasks(undefined as unknown as WireObject))).toBe('invalid_input');
    expect(core).toEqual([]);
  });

  function intentOf(source: string): WireObject {
    return { ...watchDigest, source };
  }
});
