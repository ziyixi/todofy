/**
 * contracts/ops-v1 from the dashboard's side, byte for byte: every input it sends the apps (SetGuardInput,
 * StartCanaryInput, OpsReport) and every answer it keeps after reading one (what its reader returns, which
 * HomeState stores and the page shows), for fixed synthetic state and for every fixture, valid or not (the
 * reader tolerates some invalid outputs by the contract's consumer rules, and refuses the rest as null). A
 * refactor of the client (its move onto the generated proto types and codec, for one) must not change one byte:
 * every case is compared as compact JSON with test/golden/ops-v1.json, which the code before that move wrote.
 * `UPDATE_GOLDEN=1 npx vitest run test/ops-golden.test.ts` rewrites it; only for an intended change of the
 * contract, never to make a refactor pass.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { scheduledRunId, manualRunId } from '../src/canary.ts';
import { buildReport, finalizeItems, type Candidate } from '../src/digest.ts';
import { guardInput } from '../src/guard.ts';
import { asCanaryDelivery, asCanaryResult, asGuardState, asReceipt, asStartCanaryResult, asStatus, conform } from '../src/ops-client.ts';

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
  OpsReportReceipt: asReceipt,
  // The app the dashboard called is the one the answer must name (the fixture's own, here).
  OpsStatus: (value) => asStatus((value as { app: Parameters<typeof asStatus>[0] }).app)(value),
  // Inputs the dashboard sends: the same schema check, as its own tests run on what it builds.
  SetGuardInput: (value) => conform('SetGuardInput', value),
  StartCanaryInput: (value) => conform('StartCanaryInput', value),
  OpsReport: (value) => conform('OpsReport', value),
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
  const candidates: Candidate[] = [
    { source: 'mail-hero', code: 'endpoint_blocked', severity: 'critical', since: '2026-09-29T10:02:11.000Z', metrics: { waiting_deliveries: 3, current_blocked: 1 } },
    { source: 'todofy', code: 'gemini_budget_80', severity: 'warning', metrics: { percent: 82.4, used_tokens: 2_460_000, reserved_tokens: 12_000, budget_tokens: 3_000_000 } },
    { source: 'cloudflare', code: 'd1_rows_read_high', severity: 'warning', metrics: { percent: 81.5, used: 4_075_000, limit: 5_000_000, projected_percent: 97.25 } },
    { source: 'dashboard', code: 'canary_skipped', severity: 'warning', since: '2026-09-29T22:31:40.000Z', metrics: { no_endpoint: 1 } },
    { source: 'lab', code: 'neuron_cap_hit', severity: 'warning', metrics: { used: 4996.2, cap: 5000, 'Not A Code': 1 } },
    { source: 'mail-hero', code: 'guard_shed', severity: 'info', metrics: { seconds_left: 3600 } },
  ];
  const items = finalizeItems(candidates, new Map([['todofy:gemini_budget_80', NOW - 5 * HOUR]]), NOW);
  out['input/report'] = buildReport(items, NOW, 'https://home.example.com/');
  out['input/report-no-url'] = buildReport(items.slice(0, 2), NOW, null);
  out['input/report-empty'] = buildReport([], NOW, 'https://home.example.com/');
  for (const [name, def, value] of fixtures()) out[`read/${name}`] = READERS[def]?.(value) ?? null;
  // A newer producer: fields and codes this build does not know yet.
  out['read/newer/status-extra-fields'] = asStatus('mail-hero')({ ...statusOk, next_field: 1, guard: { ...(statusOk.guard as object), hint: 'x' } });
  out['read/newer/start-new-reason'] = asStartCanaryResult({ event_id: null, state: 'unavailable', reason: 'consumer_down', retry_hint: 3 });
  out['read/newer/result-new-waiting-code'] = asCanaryResult({ state: 'processing', waiting_code: 'gemini_paused' });
  out['read/newer/delivery-new-error-code'] = asCanaryDelivery({ state: 'failed', attempts: 2, error_code: 'tls_handshake' });
  out['read/newer/delivery-new-state'] = asCanaryDelivery({ state: 'retrying', attempts: 2 });
  // Lab's status before its move onto the generated types: the same fields, its keys in another order.
  const { version, app, generated_at, last_backup_at, ui_url, capabilities, ...rest } = JSON.parse(
    readFileSync(`${FIXTURES}OpsStatus/lab-degraded.json`, 'utf8'),
  ) as Record<string, unknown>;
  out['read/newer/lab-key-order'] = asStatus('lab')({ version, app, generated_at, last_backup_at, ui_url, capabilities, ...rest });
  return out;
}

test('every input and every answer kept is byte for byte the golden one', () => {
  const actual = cases();
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  expect(Object.keys(actual)).toEqual(Object.keys(golden));
  for (const [name, value] of Object.entries(actual)) expect(JSON.stringify(value), name).toBe(JSON.stringify(golden[name]));
});
