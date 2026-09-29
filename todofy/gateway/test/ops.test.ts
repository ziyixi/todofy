import { describe, expect, it } from 'vitest';
import type { GuardState } from '../../../contracts/ops-v1/ops-v1.ts';
import schema from '../../../contracts/ops-v1/ops-v1.schema.json';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import degraded from '../../../contracts/ops-v1/fixtures/OpsStatus/todofy-degraded.json';
import shed from '../../../contracts/ops-v1/fixtures/GuardState/shed-todofy.json';
import processing from '../../../contracts/ops-v1/fixtures/CanaryResult/processing-paused.json';
import daily from '../../../contracts/ops-v1/fixtures/OpsReport/daily.json';
import stored from '../../../contracts/ops-v1/fixtures/OpsReportReceipt/stored.json';
import { Ops as Exported } from '../src/index.ts';
import { Ops } from '../src/ops.ts';
import { fakes, type CoreReply } from './helpers.ts';

const SCHEMA = schema as { $defs: Record<string, unknown> };
const EVENT_ID = 'f8c1e9a0-1a98-4fb8-8ca1-4c0a3e710016';

function entrypoint(reply: CoreReply) {
  const { env, core } = fakes({}, reply);
  return { ops: new Ops({} as ExecutionContext, env), core };
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
    expect(validate(SCHEMA, 'OpsStatus', status)).toEqual([]);
    expect(core.map((call) => [call.instance, call.method, call.args])).toEqual([['inbox-v1', 'ops_status', []]]);
  });

  it('passes setGuard input on as JSON text and returns the GuardState', async () => {
    const { ops, core } = entrypoint(() => ({ ok: shed }));
    const input = { level: 'shed', reason: 'd1_reads_high', until: '2026-09-30T00:00:00Z' } as const;
    const state: GuardState = await ops.setGuard(input);
    expect(validate(SCHEMA, 'GuardState', state)).toEqual([]);
    expect(core[0]?.method).toBe('ops_set_guard');
    expect(JSON.parse(core[0]?.args[0] as string)).toEqual(input);
  });

  it('forwards canaryResult by event ID', async () => {
    const { ops, core } = entrypoint(() => ({ ok: processing }));
    expect(validate(SCHEMA, 'CanaryResult', await ops.canaryResult(EVENT_ID))).toEqual([]);
    expect(core[0]?.args).toEqual([EVENT_ID]);
  });

  it('forwards reportOps as compact JSON and returns the receipt', async () => {
    const { ops, core } = entrypoint(() => ({ ok: stored }));
    const receipt = await ops.reportOps(daily as Parameters<Ops['reportOps']>[0]);
    expect(validate(SCHEMA, 'OpsReportReceipt', receipt)).toEqual([]);
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
