/**
 * contracts/ops-v1 from the dashboard's side, byte for byte: every input it sends the apps (SetGuardInput,
 * StartCanaryInput) and every answer it keeps after reading one (what its reader returns, which
 * HomeState stores and the page shows), for fixed synthetic state and for every fixture, valid or not (the
 * reader tolerates some invalid outputs by the contract's consumer rules, and refuses the rest as null). A
 * refactor of the client (its move onto the generated proto types and codec, for one) must not change one byte:
 * every case is compared as compact JSON with test/golden/ops-v1.json, which the code before that move wrote.
 * `UPDATE_GOLDEN=1 npx vitest run test/ops-golden.test.ts` rewrites it; only for an intended change of the
 * contract, never to make a refactor pass.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { SetGuardInputSchema, StartCanaryInputSchema } from '@ziyixi/proto/ops/v1/ops_pb';
import { expect, test } from 'vitest';
import { scheduledRunId, manualRunId } from '../src/canary.ts';
import { guardInput } from '../src/guard.ts';
import type { OpsApp } from '../src/api-types.ts';
import { asCanaryDelivery, asCanaryResult, asGuardState, asStartCanaryResult, asStatus, conform, OPS_APPS } from '../src/ops-client.ts';

/** A file path next to this test (the Workers URL type is not Node's, so paths are strings). */
const path = (relative: string): string => decodeURIComponent(new URL(relative, import.meta.url).pathname);
const GOLDEN = path('golden/ops-v1.json');
const FIXTURES = path('../../../contracts/ops-v1/fixtures/');
const NOW = Date.parse('2026-09-29T23:30:00.000Z');
const HOUR = 3_600_000;

/** Every fixture file as [`<invalid/>Def/name`, parsed value]. */
function fixtures(): [string, string, unknown][] {
  const out: [string, string, unknown][] = [];
  for (const prefix of ['', 'invalid/']) {
    const root = `${FIXTURES}${prefix}`;
    for (const def of readdirSync(root).filter((name) => name !== 'invalid').sort()) {
      for (const file of readdirSync(`${root}${def}`).sort()) {
        out.push([`${prefix}${def}/${file}`, def, JSON.parse(readFileSync(`${root}${def}/${file}`, 'utf8'))]);
      }
    }
  }
  return out;
}

/** What the dashboard keeps of an answer: the conformer each wrapper of ops-client.ts uses. */
const READERS: Readonly<Record<string, ((value: unknown) => unknown) | undefined>> = {
  GuardState: asGuardState,
  StartCanaryResult: asStartCanaryResult,
  CanaryDelivery: asCanaryDelivery,
  CanaryResult: asCanaryResult,
  // The app the dashboard called is the one the answer must name: the fixture's own when the dashboard binds it. A
  // name it does not bind (OpsStatus.app is open on the wire) can only come from a binding of another app: refused.
  OpsStatus: (value) => {
    const app = (value as { app?: unknown }).app;
    return asStatus((OPS_APPS as readonly unknown[]).includes(app) ? (app as OpsApp) : 'mail-hero')(value);
  },
  // Inputs the dashboard sends: the same schema check, as its own tests run on what it builds.
  SetGuardInput: (value) => conform(SetGuardInputSchema, value),
  StartCanaryInput: (value) => conform(StartCanaryInputSchema, value),
  // OpsReportReceipt: Home's own digest record, never sent or read (the digest is a task in Tasks since 2026-10-21).
};

const statusOk = JSON.parse(readFileSync(`${FIXTURES}OpsStatus/mail-hero-ok.json`, 'utf8')) as Record<string, unknown>;

function cases(): Record<string, unknown> {
  const out: Record<string, unknown> = {
    'input/guard-shed': guardInput({ level: 'shed', reason: 'quota_d1_rows_read', until: NOW + 2 * HOUR, source: 'auto' }, NOW),
    'input/guard-shed-capped': guardInput({ level: 'shed', reason: 'owner_shed', until: NOW + 72 * HOUR, source: 'owner' }, NOW),
    'input/guard-normal': guardInput({ level: 'normal', reason: 'quota_normal', until: null, source: 'auto' }, NOW),
    'input/start-scheduled': { run_id: scheduledRunId(NOW) },
    'input/start-manual': { run_id: manualRunId(NOW) },
  };
  for (const [name, def, value] of fixtures()) out[`read/${name}`] = READERS[def]?.(value) ?? null;
  // A newer producer: fields and codes this build does not know yet.
  out['read/newer/status-extra-fields'] = asStatus('mail-hero')({ ...statusOk, next_field: 1, guard: { ...(statusOk.guard as object), hint: 'x' } });
  out['read/newer/start-new-reason'] = asStartCanaryResult({ event_id: null, state: 'unavailable', reason: 'consumer_down', retry_hint: 3 });
  out['read/newer/result-new-waiting-code'] = asCanaryResult({ state: 'processing', waiting_code: 'gemini_paused' });
  out['read/newer/delivery-new-error-code'] = asCanaryDelivery({ state: 'failed', attempts: 2, error_code: 'tls_handshake' });
  out['read/newer/delivery-new-state'] = asCanaryDelivery({ state: 'retrying', attempts: 2 });
  return out;
}

test('every input and every answer kept is byte for byte the golden one', () => {
  const actual = cases();
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(actual)).toEqual(Object.keys(golden));
  for (const [name, value] of Object.entries(actual)) {
    expect(JSON.stringify(value), name).toBe(JSON.stringify(golden[name]));
  }
});
