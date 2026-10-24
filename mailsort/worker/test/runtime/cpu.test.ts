/** Workers Free CPU: real owner API reads, 10 x 12k machine claim, 100-result report and bounded Gmail writes.
 * Fetch and SQLite DO run in separate workerd isolates and retain their existing Free budgets.
 * Every mail, credential and upstream is synthetic. The classification path must make no Workers AI call.
 */
import { describe, expect, it } from 'vitest';
import {
  COLD_ISOLATES,
  connectCpuMeter,
  CPU_TEST_TIMEOUT_MS,
  FREE_CPU_MS,
  INSPECTOR_TIMEOUT_MS,
  measureInIsolates,
  summarize,
  type CpuMeter,
  type Isolate,
  type Measurement,
} from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { LABELS_MAX, TRUSTED_DOMAINS_PER_LABEL_MAX } from '../../src/limits.ts';
import { createHttpClient } from '@ziyixi/proto/http-client';
import { MailsortRunnerService, Priority, RunStatus, type ClassificationMessage } from '@ziyixi/proto/mailsort/runner/v1/mailsort_runner_service_pb';
import { PRIORITY_LABELS } from '../../src/priority.ts';
import { MAILS, message } from '../fakes/fixtures.ts';
import { accessClaims, testIssuer } from '../jwt.ts';
import { CLASSIFICATION_TOKEN, MINUTE, OBJECT_WORKER, op, PUBLIC_HOST, startHarness, SYNTHETIC_BINDINGS, T0, type Harness } from './harness.ts';

const FREE_OBJECT_CPU_MS = 30_000;
/** The fetch handler: a JWT, a CSRF token and the object's answer passed on (watch measured 2-2.2 ms cold). */
const WORKER_COLD_BOUND_MS = 0.6 * FREE_CPU_MS;
const WORKER_BOUND_MS = 0.25 * FREE_CPU_MS;
/** MailsortState: its API calls, and an alarm pass at the bounds (a few hundred ms, not the 30 s of the limit). */
const OBJECT_API_BOUND_MS = 0.01 * FREE_OBJECT_CPU_MS;
const OBJECT_ALARM_BOUND_MS = 0.05 * FREE_OBJECT_CPU_MS;
const RUNS = 7;
const HANDLER = 'fetch handler';
const OBJECT = 'MailsortState';
const ALARM = 'alarm pass: bounded Gmail writes of reported decisions';
const COLD_LABEL = "GET /api/csrf as the fetch handler's very first request";
const ISSUER = SYNTHETIC_BINDINGS['ACCESS_ISSUER'] ?? '';
const AUDIENCE = SYNTHETIC_BINDINGS['ACCESS_AUDIENCE'] ?? '';

interface SortIsolate extends Isolate {
  readonly h: Harness;
  readonly object: CpuMeter;
}

let token = '';
let jwks: unknown;

async function startIsolate(): Promise<SortIsolate> {
  if (token === '') {
    const issuer = await testIssuer();
    token = await issuer.sign(accessClaims(ISSUER, AUDIENCE, 'owner@example.com'));
    jwks = issuer.jwks;
  }
  const h = await startHarness({
    inspectorPort: 0,
    splitObject: true,
    aiBinding: true,
    // No bypass: Access is verified, and Google and Workers AI are reached as in production (through the fakes).
    bindings: { DEV_AUTH_BYPASS: undefined, DEV_FAKE_UPSTREAM: undefined },
    routes: new Map([[`${ISSUER}/cdn-cgi/access/certs`, () => Response.json(jwks)]]),
  });
  try {
    const meter = await connectCpuMeter(h.mf, 'mailsort');
    const object = await connectCpuMeter(h.mf, OBJECT_WORKER, 2 * INSPECTOR_TIMEOUT_MS);
    return {
      h,
      meter,
      object,
      async dispose() {
        meter.close();
        object.close();
        await h.dispose();
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}

/** The stores at their bounds, written straight into SQLite (the API would take minutes). */
async function seed(h: Harness): Promise<void> {
  for (let i = 0; i < LABELS_MAX; i++) {
    await h.sql(
      `INSERT INTO labels (id, seq, display_name, description, enabled, trust, gmail_state, create_time, update_time, etag)
       VALUES (?, ?, ?, ?, 1, 0, 'pending', ?, ?, 'e')`,
      `label-${String(i)}`,
      i + 1,
      `Category ${String(i)}`,
      `描述 ${String(i)}：weekly digest 订阅 receipt 订单 `.repeat(6).slice(0, 300),
      T0,
      T0,
    );
  }
  for (const [i, label] of PRIORITY_LABELS.entries()) {
    const gmailId = h.up.gmail.createUserLabel(label.displayName, true);
    await h.sql(`INSERT INTO labels (id, seq, display_name, description, enabled, gmail_id, gmail_state, keep_in_inbox, create_time, update_time, etag)
      VALUES (?, ?, ?, ?, 1, ?, 'linked', ?, ?, ?, 'e')`, label.id, 100 + i, label.displayName, label.description, gmailId, label.keepInInbox ? 1 : 0, T0, T0);
  }
  await h.sql(`INSERT INTO meta (key, value) VALUES ('priority_started_at', ?)`, String(T0 - 86_400_000));
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO trusted_domains (label_id, domain, origin, create_time) SELECT 'label-' || (i % ?), printf('d%04d.example.com', i), 'owner', ? FROM n`,
    LABELS_MAX * TRUSTED_DOMAINS_PER_LABEL_MAX - 1,
    LABELS_MAX,
    T0,
  );
  // 2,000 retained decisions keep owner report reads at their existing bound.
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 1999)
     INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, top_label, decider, shown, verdict, verdict_label, verdict_source, verdict_at, sender_hash, subject, sender, summary)
     SELECT printf('dddd%012d', i), printf('tddd%012d', i), ?, ? - i * 1000, CASE i % 4 WHEN 0 THEN 'applied' WHEN 1 THEN 'suggested' WHEN 2 THEN 'unsure' ELSE 'none' END,
            CASE WHEN i % 4 < 2 THEN printf('p%d', 1 + i % ?) END, printf('p%d', 1 + i % ?), 'clef', i % 8 = 2,
            CASE WHEN i % 5 = 0 THEN 'corrected' ELSE 'confirmed' END, printf('p%d', 1 + i % ?), CASE WHEN i % 2 = 0 THEN 'gmail' ELSE 'review' END, ?,
            printf('%016x', i), '主题', '发件人', '摘要'
     FROM n`,
    T0,
    T0,
    PRIORITY_LABELS.length,
    PRIORITY_LABELS.length,
    PRIORITY_LABELS.length,
    T0 - 1000,
  );

  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 199)
     INSERT INTO review (id, message_id, kind, state, suggested_label, candidates, decider, subject, sender, receive_time, create_time)
     SELECT printf('rv%014d', i), printf('dddd%012d', i), 'unsure', 'pending', 'label-1', '[{"label":"label-1","probability":0.9},{"label":"","probability":0.05},{"label":"label-2","probability":0.05}]', 'clef',
            printf('[email] 您的订单 [number] 已发货，请查收电子发票和物流信息 %d', i), '商城 <mall.example.cn>', ?, ?
     FROM n`,
    T0,
    T0,
  );
  // 30 days of flow counters, every stage and outcome for every label: far more rows than a real month.
  await h.sql(
    `WITH RECURSIVE d(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM d WHERE i < 29),
       s(stage) AS (VALUES ('clef'), ('clef-flash')),
       o(outcome) AS (VALUES ('archived'), ('kept_in_inbox'), ('suggested'), ('no_label'), ('unsure'), ('unsure_shown'), ('corrected'), ('deferred')),
       l(j) AS (SELECT 0 UNION ALL SELECT j + 1 FROM l WHERE j < ?)
     INSERT INTO flow (day, stage, outcome, label, n)
     SELECT date(?, 'unixepoch', '-' || i || ' days'), stage, outcome, 'label-' || j, 1 + (i + j) % 5 FROM d, s, o, l`,
    LABELS_MAX - 1,
    Math.floor(T0 / 1000),
  );
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 199)
     INSERT INTO ledger (id, message_id, label_id, gmail_label_id, archived, origin, state, create_time, apply_time)
     SELECT printf('lg%014d', i), printf('dddd%012d', i), 'label-1', 'Label_1', 1, 'auto', 'applied', ?, ?
     FROM n`,
    T0,
    T0,
  );
}

async function session({ h, meter: worker, object }: SortIsolate, index: number): Promise<Measurement[]> {
  const headers = { 'cf-access-jwt-assertion': token };
  let csrf = new Response();
  const cold = await worker.measure(COLD_LABEL, async () => {
    csrf = await h.fetch('/api/csrf', { headers });
  }, 1);
  const csrfToken = (await csrf.json<{ token: string }>()).token;
  if (index !== COLD_ISOLATES - 1) return [cold];
  const mutationHeaders = { ...headers, 'content-type': 'application/json', origin: `https://${PUBLIC_HOST}`, 'x-csrf-token': csrfToken, cookie: (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
  await seed(h);

  async function expectOk(path: string, init: RequestInit = {}): Promise<void> {
    const response = await h.fetch(path, { headers, ...init });
    await response.arrayBuffer();
    if (response.status !== 200) throw new Error(`${path}: ${String(response.status)}`);
  }

  async function both(label: string, run: () => Promise<void>): Promise<Measurement[]> {
    const workerSamples: number[] = [];
    const objectSamples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      let inner = 0;
      workerSamples.push(
        await worker.cpu(async () => {
          inner = await object.cpu(run);
        }),
      );
      objectSamples.push(inner);
    }
    const result = [summarize(`${label}: ${HANDLER}`, workerSamples), summarize(`${label}: ${OBJECT}`, objectSamples)];
    console.log(`cpu ${label}: fetch handler first ${(result[0]?.first ?? 0).toFixed(2)} ms, median ${(result[0]?.median ?? 0).toFixed(2)} ms; ${OBJECT} first ${(result[1]?.first ?? 0).toFixed(2)} ms, median ${(result[1]?.median ?? 0).toFixed(2)} ms`);
    return result;
  }

  await h.step(T0);
  await h.sql(`INSERT INTO meta (key, value) VALUES ('settings', '{"mode":"live"}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  const machine = createHttpClient(MailsortRunnerService, call => h.fetch(call.url, {
    method: call.httpMethod, headers: { authorization: `Bearer ${CLASSIFICATION_TOKEN}`, 'content-type': 'application/json' },
    ...(call.body === undefined ? {} : { body: call.body }),
  }));
  for (let i = 0; i < 100; i++) h.up.gmail.deliver(message({ ...MAILS.newsletterZh,
    text: '合'.repeat(12_000), id: `cc${i.toString(16).padStart(14, '0')}`, receivedAt: T0 }));
  let runId = op();
  const messages: ClassificationMessage[] = [];
  const scan = await machine.claimClassification({ runId });
  runId = scan.runId;
  expect(scan.nextPageToken).not.toBe('');
  const claim = await both('POST machine claim (10 x 12k body page)', async () => {
    const answer = await machine.claimClassification({ runId, pageToken: scan.nextPageToken });
    runId = answer.runId;
    expect(answer.messages).toHaveLength(10);
    expect(answer.messages.every(item => item.body.length === 12_000)).toBe(true);
  });
  let pageToken = '';
  do {
    const page = await machine.claimClassification({ runId, pageToken });
    messages.push(...page.messages); pageToken = page.nextPageToken;
  } while (pageToken !== '');
  expect(messages).toHaveLength(100);
  const report = { runId, requestId: op(), results: messages.map(item => ({ messageId: item.messageId, priority: Priority.P2, reason: '两三天内查看即可。' })),
    status: RunStatus.COMPLETED, model: 'gpt-6.1-sol', effort: 'medium', promptSha: 'a'.repeat(64), inputTokens: 12000, outputTokens: 2000 };
  const reported = await both('POST machine report (100 decisions)', async () => {
    const answer = await machine.reportClassification(report);
    expect(answer.acceptedCount).toBe(100);
  });
  const before = h.up.gmail.calls.filter(call => call.url.endsWith('/modify')).length;
  const alarm = summarize(ALARM, [await object.cpu(async () => { await h.step(T0 + MINUTE); })]);
  const applied = h.up.gmail.calls.filter(call => call.url.endsWith('/modify')).length - before;
  expect(applied).toBe(5);
  expect(await h.sql(`SELECT count(*) AS n FROM decisions WHERE decider = 'codex'`)).toEqual([{ n: 100 }]);
  expect(h.up.ai.calls).toHaveLength(0);

  const api = [
    ...(await both(`GET labels (${String(LABELS_MAX)}, with their trusted domains)`, () => expectOk('/api/v2/labels'))),
    ...(await both('GET reviewItems (a page of 50)', () => expectOk('/api/v2/reviewItems'))),
    ...(await both('GET ledgerEntries (a page of 50)', () => expectOk('/api/v2/ledgerEntries'))),
    ...(await both('GET labelReport (2,000 decisions)', () => expectOk('/api/v2/labelReport'))),
    ...(await both('GET serviceStatus', () => expectOk('/api/v2/serviceStatus'))),
    ...(await both('GET mailFlows/last-30-days (11,520 counters)', () => expectOk('/api/v2/mailFlows/last-30-days'))),
    ...(await both('PATCH settings (mask)', () =>
      expectOk(`/api/v2/settings?update_mask=run_write_limit&request_id=${op()}`, { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ name: 'settings', run_write_limit: 10 }) }),
    )),
  ];
  return [cold, alarm, ...claim, ...reported, ...api];
}

describe('CPU (Workers Free: 10 ms per request, 30 s per Durable Object invocation)', () => {
  it('the fetch handler stays far below 10 ms and MailsortState far below 30 s, on the alarm path too', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
    const { reference } = await measureInIsolates(COLD_ISOLATES, startIsolate, session);
    const get = (label: string): Measurement => {
      const measurement = reference.get(label);
      if (measurement === undefined) throw new Error(`not measured: ${label}`);
      return measurement;
    };
    console.log(`cpu bounds (reference ms): fetch handler first < ${WORKER_COLD_BOUND_MS.toFixed(1)}, median < ${WORKER_BOUND_MS.toFixed(1)}; ${OBJECT} API < ${OBJECT_API_BOUND_MS.toFixed(0)}, alarm < ${OBJECT_ALARM_BOUND_MS.toFixed(0)}`);
    expect(get(COLD_LABEL).first, COLD_LABEL).toBeLessThan(WORKER_COLD_BOUND_MS);
    for (const { label, first, median } of reference.values()) {
      if (label.endsWith(`: ${HANDLER}`)) {
        expect(first, `${label}, first run`).toBeLessThan(WORKER_COLD_BOUND_MS);
        expect(median, `${label}, warm median`).toBeLessThan(WORKER_BOUND_MS);
      } else if (label.endsWith(`: ${OBJECT}`)) {
        expect(first, label).toBeLessThan(OBJECT_API_BOUND_MS);
      }
    }
    expect(get(ALARM).first, ALARM).toBeLessThan(OBJECT_ALARM_BOUND_MS);
    expect(reference.size).toBe(1 + 1 + 2 * 9);
  });
});
