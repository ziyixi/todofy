import { describe, expect, it } from 'vitest';
import { CanaryResultSchema, GuardStateSchema, OpsStatusSchema } from '@ziyixi/proto/ops/v1/ops_pb';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { fromWire } from '@ziyixi/proto/wire-json';
import type { DescMessage } from '@ziyixi/proto/protobuf';
import degraded from '../../../contracts/ops-v1/fixtures/OpsStatus/todofy-degraded.json';
import shed from '../../../contracts/ops-v1/fixtures/GuardState/shed-todofy.json';
import processing from '../../../contracts/ops-v1/fixtures/CanaryResult/processing-paused.json';
import * as entrypoints from '../src/index.ts';
import { Ops } from '../src/ops.ts';
import { fakes, type CoreReply } from './helpers.ts';

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
    expect(entrypoints.Ops).toBe(Ops);
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

  it.each(['invalid_input', 'busy', 'unavailable'])('rejects with the core error code %s', async (code) => {
    const { ops } = entrypoint(() => ({ error: code }));
    expect(await rejection(ops.status())).toBe(code);
    expect(await rejection(ops.setGuard({ level: 'normal', reason: 'ok', until: null }))).toBe(code);
    expect(await rejection(ops.canaryResult(EVENT_ID))).toBe(code);
  });

  it('rejects unavailable when the core call itself fails', async () => {
    const { ops } = entrypoint(() => {
      throw new Error('PythonError: Traceback (most recent call last) ...');
    });
    expect(await rejection(ops.status())).toBe('unavailable');
    expect(await rejection(ops.canaryResult(EVENT_ID))).toBe('unavailable');
  });

  it('refuses what it cannot pass on without waking the core', async () => {
    const { ops, core } = entrypoint(() => ({ ok: shed }));
    expect(await rejection(ops.canaryResult(7 as unknown as string))).toBe('invalid_input');
    expect(await rejection(ops.setGuard(undefined as unknown as { level: 'normal'; reason: string; until: null }))).toBe(
      'invalid_input',
    );
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(await rejection(ops.setGuard(cyclic as never))).toBe('invalid_input');
    expect(core).toEqual([]);
  });
});

describe('the entrypoints other Workers bind', () => {
  it('are Ops and Mail, and the retired ones for one release: no ops digest on Ops', () => {
    const methods = Object.getOwnPropertyNames(Ops.prototype).filter((name) => name !== 'constructor' && name !== 'call');
    expect(methods.sort()).toEqual(['canaryResult', 'setGuard', 'status']);
    const named = Object.keys(entrypoints).filter((name) => name !== 'default');
    expect(named.sort()).toEqual(['Intents', 'Mail', 'MailApi', 'Ops', 'Planning']);
  });

  it('refuses every call of a retired entrypoint without waking the core', async () => {
    const { env, core } = fakes({}, () => ({ ok: shed }));
    for (const Retired of [entrypoints.Planning, entrypoints.MailApi]) {
      const entry = new Retired({ props: { source: 'tasks' } } as ExecutionContext<never>, env);
      expect(entry.fetch().status).toBe(404);
    }
    // unavailable keeps the old Watch sink's proposals open for its successor, which sends them to Tasks.
    const intents = new entrypoints.Intents({ props: { source: 'watch' } } as ExecutionContext<never>, env);
    expect(await rejection(intents.proposeTasks())).toBe('unavailable');
    expect(await rejection(intents.taskIntentStatus())).toBe('unavailable');
    expect(core).toEqual([]);
  });
});
