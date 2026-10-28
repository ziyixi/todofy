/**
 * CPU inside workerd against Workers Free (../../../docs/design.md §8), measured and calibrated by the shared meter
 * (tools/workerd-cpu/workerd-cpu.mts). MailsortState runs in a Worker of its own (HarnessOptions.splitObject), as on
 * Cloudflare, so the two limits are measured apart:
 *
 * - the fetch handler (10 ms per request): Access (an RS256 verification), CSRF, one call to the object and its answer
 *   passed through, for the heaviest answers (24 labels with their historical trusted domains, a page of 50 review
 *   items, a page of 50 ledger entries, the label report over 2,000 decisions, the status, 30 days of flow counters, the
 *   stored replay summary with REPLAY_CASES_MAX cases) and a settings update;
 * - MailsortState (30 s per invocation): those API calls, and the alarm path at its bounds: three history pages of 100
 *   records and DRAIN_MAX mails decided in one model request, with a live write each; the heaviest step of the daily
 *   backup of that store (2,000 examples with 4 KiB embeddings among it), and of its restore into the store emptied.
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
import { DRAIN_MAX, LABELS_MAX, REPLAY_CASES_MAX } from '../../src/limits.ts';
import { PRIORITY_LABELS } from '../../src/priority.ts';
import { MAILS, message } from '../fakes/fixtures.ts';
import { accessClaims, testIssuer } from '../jwt.ts';
import { MINUTE, OBJECT_WORKER, op, PUBLIC_HOST, startHarness, SYNTHETIC_BINDINGS, T0, type Harness } from './harness.ts';

const FREE_OBJECT_CPU_MS = 30_000;
/** The most historical trusted domains per label and examples the retired learning path kept. */
const TRUSTED_DOMAINS_PER_LABEL = 50;
const EXAMPLES = 2000;
/** The fetch handler: a JWT, a CSRF token and the object's answer passed on (watch measured 2-2.2 ms cold). */
const WORKER_COLD_BOUND_MS = 0.6 * FREE_CPU_MS;
const WORKER_BOUND_MS = 0.25 * FREE_CPU_MS;
/** MailsortState: its API calls, and an alarm pass at the bounds (a few hundred ms, not the 30 s of the limit). */
const OBJECT_API_BOUND_MS = 0.01 * FREE_OBJECT_CPU_MS;
const OBJECT_ALARM_BOUND_MS = 0.05 * FREE_OBJECT_CPU_MS;
/** One step of the backup or the restore at its byte and part budgets. */
const OBJECT_BACKUP_BOUND_MS = 0.1 * FREE_OBJECT_CPU_MS;
const RUNS = 7;
const HANDLER = 'fetch handler';
const OBJECT = 'MailsortState';
const ALARM = `alarm pass: 3 history pages, ${String(DRAIN_MAX)} mails with 12000-character bodies, one Claude request`;
const COLD_LABEL = "GET /api/csrf as the fetch handler's very first request";
const BACKUP = 'the heaviest step of the daily backup of that store';
const RESTORE = 'the heaviest step of its restore into the store emptied';
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
    backups: true,
    // No bypass: Access is verified, and Google and Model Router are reached as in production (through the fakes).
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
    LABELS_MAX * TRUSTED_DOMAINS_PER_LABEL - 1,
    LABELS_MAX,
    T0,
  );
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO examples (id, label_id, summary, origin, message_id, embedding, create_time)
     SELECT printf('ex%06d', i), printf('p%d', 1 + i % ?), printf('示例邮件 %d · Weekly digest · Sender <example.com> · 本周订阅内容摘要', i), 'correction', printf('ffff%012d', i), randomblob(4096), ?
     FROM n`,
    EXAMPLES - 1,
    PRIORITY_LABELS.length,
    T0,
  );
  // 2,000 decisions of the last week.
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

/**
 * The stored replay at its bounds: REPLAY_CASES_MAX evaluated mails (its summary reads them all), each with every
 * decision number recorded, so the answer holds REPLAY_CASES_MAX cases.
 */
async function seedReplay(h: Harness): Promise<void> {
  await h.sql(`DELETE FROM replay`);
  await h.sql(`INSERT INTO replay (job_id, message_id, state, create_time) VALUES ('job0', '', 'succeeded', ?)`, T0);
  await h.sql(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO replay (job_id, message_id, state, owner_label, as_of, outcome, label, reason, shown, create_time, done_time, top_option, top_p, runner_up_p,
       view2_p, combined, suspicious, authenticated, trust)
     SELECT 'job0', printf('dddd%012d', i), 'evaluated', 'label-' || (i % 7), ?, CASE i % 3 WHEN 0 THEN 'label' WHEN 1 THEN 'none' ELSE 'unsure' END, 'label-' || (i % 5),
       CASE i % 3 WHEN 2 THEN 'views_disagree' ELSE '' END, i % 2, ?, ?, 'label-' || (i % 5), 0.61 + i / 1000.0, 0.21 - i / 2000.0, 0.57 + i / 3000.0,
       0.59 + i / 1500.0, 0.013 * (i % 7), i % 2, i % 3 = 0
     FROM n`,
    REPLAY_CASES_MAX - 1,
    T0,
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
  await h.sql(`UPDATE meta SET value = '0' WHERE key = 'next_model_at'`);
  await h.sql(`INSERT INTO meta (key, value) VALUES ('settings', '{"mode":"live","classificationProvider":"claude"}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  for (let i = 0; i < DRAIN_MAX; i++) h.up.gmail.deliver(message({ ...MAILS.newsletterZh, text: '合成阅读材料，等待周末阅读。'.repeat(1500), id: `cc00000000000${String(i).padStart(3, '0')}`, receivedAt: T0 }));
  for (let i = 0; i < 300 - DRAIN_MAX; i++) h.up.gmail.ownerModify(`cc00000000000${String(i % DRAIN_MAX).padStart(3, '0')}`, i % 2 === 0 ? ['STARRED'] : [], i % 2 === 0 ? [] : ['STARRED']);
  clock += 5 * MINUTE;
  let decided = 0;
  const alarm = summarize(ALARM, [
    await object.cpu(async () => {
      decided = (await h.step(clock)).decided ?? 0;
    }),
  ]);
  expect(decided).toBe(DRAIN_MAX);
  expect(await h.sql(`SELECT count(*) AS n FROM decisions WHERE message_id LIKE 'cc%' AND decider = 'claude' AND model = 'claude-opus-5-5'`)).toEqual([{ n: DRAIN_MAX }]);
  expect(h.up.claude.calls).toHaveLength(1);
  expect(h.up.claude.calls[0]).toHaveLength(DRAIN_MAX);
  expect(h.up.claude.calls[0]?.every(mail => Array.from(mail.body).length === 12000 && mail.body_truncated)).toBe(true);
  expect(await h.sql(`SELECT requests FROM claude_usage WHERE day = '2026-10-01'`)).toEqual([{ requests: 1 }]);
  await seedReplay(h);

  const api = [
    ...(await both(`GET labels (${String(LABELS_MAX)}, with their trusted domains)`, () => expectOk('/api/v2/labels'))),
    ...(await both('GET reviewItems (a page of 50)', () => expectOk('/api/v2/reviewItems'))),
    ...(await both('GET ledgerEntries (a page of 50)', () => expectOk('/api/v2/ledgerEntries'))),
    ...(await both('GET labelReport (2,000 decisions)', () => expectOk('/api/v2/labelReport'))),
    ...(await both('GET serviceStatus', () => expectOk('/api/v2/serviceStatus'))),
    ...(await both('GET mailFlows/last-30-days (11,520 counters)', () => expectOk('/api/v2/mailFlows/last-30-days'))),
    ...(await both(`GET replayEvaluation (${String(REPLAY_CASES_MAX)} cases)`, () => expectOk('/api/v2/replayEvaluation'))),
    ...(await both('PATCH settings (mask)', () =>
      expectOk(`/api/v2/settings?update_mask=run_write_limit&request_id=${op()}`, { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ name: 'settings', run_write_limit: 10 }) }),
    )),
  ];
  // Measured at its bound (read after the measurements, so their first run stays the isolate's first).
  const answer = await (await h.fetch('/api/v2/replayEvaluation', { headers })).json<{ cases: unknown[] }>();
  expect(answer.cases).toHaveLength(REPLAY_CASES_MAX);

  // The daily backup of the seeded store, step by step a second apart; then the store emptied, as a new object is,
  // and the restore of that backup.
  async function steps(what: 'backup' | 'restore'): Promise<number[]> {
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      clock += 1000;
      samples.push(await object.cpu(async () => {
        await h.tick(clock);
      }));
      const state = (await h.kv(what)) as { job?: unknown; state?: string } | null;
      if (what === 'backup' ? state?.job === null : state?.state !== 'running') return samples;
    }
    throw new Error(`the ${what} did not end`);
  }
  const backupSteps = await steps('backup');
  expect(backupSteps.length).toBeGreaterThan(3);
  const prefix = ((await h.kv('backup')) as { last_key: string }).last_key;
  const tables = await h.sql<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`);
  for (const { name } of tables) await h.sql(`DELETE FROM "${name}"`);
  await expectOk(`/api/v2/backupRestore:start`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ name: 'backupRestore', backup: prefix, request_id: op() }) });
  const restoreSteps = await steps('restore');
  expect(await h.kv('restore')).toMatchObject({ state: 'succeeded' });
  expect(await h.sql(`SELECT count(*) AS n FROM examples`)).toEqual([{ n: EXAMPLES }]);
  console.log(`cpu backup steps (ms): ${backupSteps.map((ms) => ms.toFixed(0)).join(' ')}; restore steps: ${restoreSteps.map((ms) => ms.toFixed(0)).join(' ')}`);
  return [cold, alarm, ...api, summarize(BACKUP, [Math.max(...backupSteps)]), summarize(RESTORE, [Math.max(...restoreSteps)])];
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
    console.log(`cpu backup (reference ms): step < ${OBJECT_BACKUP_BOUND_MS.toFixed(0)}`);
    expect(get(BACKUP).first, BACKUP).toBeLessThan(OBJECT_BACKUP_BOUND_MS);
    expect(get(RESTORE).first, RESTORE).toBeLessThan(OBJECT_BACKUP_BOUND_MS);
    expect(reference.size).toBe(1 + 1 + 2 * 8 + 2);
  });
});
