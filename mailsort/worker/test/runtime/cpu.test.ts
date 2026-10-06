/**
 * CPU inside workerd against Workers Free (../../../docs/design.md §8), measured and calibrated by the shared meter
 * (tools/workerd-cpu/workerd-cpu.mts). MailsortState runs in a Worker of its own (HarnessOptions.splitObject), as on
 * Cloudflare, so the two limits are measured apart:
 *
 * - the fetch handler (10 ms per request): Access (an RS256 verification), CSRF, one call to the object and its answer
 *   passed through, for the heaviest answers (24 labels, a page of 50 review items, a page of 50 ledger entries, the
 *   accuracy report over 2,000 decisions, the status);
 * - MailsortState (30 s per invocation): those API calls, and the alarm path at its bounds: three history pages of 100
 *   records, DRAIN_MAX mails decided with the nearest of EXAMPLES_MAX embedded examples, Clef, and a live write each.
 *
 * No dev bypass: Access is verified as in production. Bounds are milliseconds of the reference machine.
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
import { DRAIN_MAX, EXAMPLES_MAX, LABELS_MAX } from '../../src/limits.ts';
import { MAILS, message } from '../fakes/fixtures.ts';
import { accessClaims, testIssuer } from '../jwt.ts';
import { MINUTE, OBJECT_WORKER, op, PUBLIC_HOST, startHarness, SYNTHETIC_BINDINGS, T0, type Harness } from './harness.ts';

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
const ALARM = `alarm pass: 3 history pages, ${String(DRAIN_MAX)} mails, ${String(EXAMPLES_MAX)} examples`;
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
      `INSERT INTO labels (id, seq, display_name, description, enabled, live, trust, threshold, gmail_state, create_time, update_time, etag)
       VALUES (?, ?, ?, ?, 1, 1, 0, 0, 'pending', ?, ?, 'e')`,
      `label-${String(i)}`,
      i + 1,
      `标签${String(i)}`,
      `描述 ${String(i)}：weekly digest 订阅 receipt 订单 `.repeat(6).slice(0, 300),
      T0,
      T0,
    );
  }
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO examples (id, label_id, summary, origin, message_id, embedding, create_time)
     SELECT printf('ex%06d', i), 'label-' || (i % ?), printf('示例邮件 %d · Weekly digest · Sender <example.com> · 本周订阅内容摘要', i), 'correction', printf('ffff%012d', i), randomblob(4096), ?
     FROM n`,
    EXAMPLES_MAX - 1,
    LABELS_MAX,
    T0,
  );
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 1999)
     INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, top_label, decider, verdict, verdict_label, subject, sender, summary)
     SELECT printf('dddd%012d', i), printf('tddd%012d', i), ?, ?, CASE WHEN i % 3 = 0 THEN 'applied' ELSE 'suggested' END, 'label-' || (i % ?), 'label-' || (i % ?), 'clef',
            CASE WHEN i % 5 = 0 THEN 'corrected' ELSE 'confirmed' END, 'label-' || (i % ?), '主题', '发件人', '摘要'
     FROM n`,
    T0,
    T0,
    LABELS_MAX,
    LABELS_MAX,
    LABELS_MAX,
  );
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 199)
     INSERT INTO review (id, message_id, kind, state, suggested_label, candidates, decider, subject, sender, receive_time, create_time)
     SELECT printf('rv%014d', i), printf('dddd%012d', i), 'suggestion', 'pending', 'label-1', '[{"label":"label-1","probability":0.9},{"label":"","probability":0.05},{"label":"label-2","probability":0.05}]', 'clef',
            printf('[email] 您的订单 [number] 已发货，请查收电子发票和物流信息 %d', i), '商城 <mall.example.cn>', ?, ?
     FROM n`,
    T0,
    T0,
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

  // The alarm path at its bounds: the install pass, then 300 history records (3 pages) with DRAIN_MAX new mails.
  let clock = T0;
  await h.step(clock);
  await h.sql(`INSERT INTO meta (key, value) VALUES ('settings', '{"mode":"live"}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  for (let i = 0; i < DRAIN_MAX; i++) h.up.gmail.deliver(message({ ...MAILS.newsletterZh, id: `cc00000000000${String(i).padStart(3, '0')}`, receivedAt: T0 }));
  for (let i = 0; i < 300 - DRAIN_MAX; i++) h.up.gmail.ownerModify(`cc00000000000${String(i % DRAIN_MAX).padStart(3, '0')}`, i % 2 === 0 ? ['STARRED'] : [], i % 2 === 0 ? [] : ['STARRED']);
  clock += 5 * MINUTE;
  let decided = 0;
  const alarm = summarize(ALARM, [
    await object.cpu(async () => {
      decided = (await h.step(clock)).decided ?? 0;
    }),
  ]);
  expect(decided).toBe(DRAIN_MAX);

  const api = [
    ...(await both(`GET labels (${String(LABELS_MAX)})`, () => expectOk('/api/v1/labels'))),
    ...(await both('GET reviewItems (a page of 50)', () => expectOk('/api/v1/reviewItems'))),
    ...(await both('GET ledgerEntries (a page of 50)', () => expectOk('/api/v1/ledgerEntries'))),
    ...(await both('GET accuracyReport (2,000 decisions)', () => expectOk('/api/v1/accuracyReport'))),
    ...(await both('GET serviceStatus', () => expectOk('/api/v1/serviceStatus'))),
    ...(await both('PATCH settings (mask)', () =>
      expectOk(`/api/v1/settings?update_mask=default_threshold&request_id=${op()}`, { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ name: 'settings', default_threshold: 0.85 }) }),
    )),
  ];
  return [cold, alarm, ...api];
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
    expect(reference.size).toBe(1 + 1 + 2 * 6);
  });
});
