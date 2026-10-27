/**
 * CPU inside workerd against Workers Free (../../../docs/design.md §14), measured and calibrated by the shared meter
 * (tools/workerd-cpu/workerd-cpu.mts). BriefState runs in a Worker of its own (HarnessOptions.splitObject), as on
 * Cloudflare, so the two limits are measured apart:
 *
 * - the fetch handler (10 ms per request): Access (an RS256 verification), CSRF on a mutation, or the feedback token's
 *   HMAC, then one call to the object and its answer passed through; for the heaviest API calls and both feedback
 *   requests;
 * - BriefState (30 s per invocation): those calls, and the alarms at their bounds (bulk.ts): a collect alarm of 40
 *   polls of 1 MiB (their entries parsed, 2,000 looked up, 120 new and their mentions found), the next one embedding
 *   the 120, clustering the world ones against 3 days of centroids and screening them in ten Haiku calls, and every
 *   alarm of the largest issue (the 8 items of the pick's caps), the check above all (68 quotes aligned against
 *   16,000-character documents).
 *
 * No dev bypass: Access is verified as in production. Fake model, feeds, Workers AI and Resend; no network. Bounds are
 * milliseconds of the reference machine.
 */
import { describe, expect, it } from 'vitest';
import { BriefUiService } from '@ziyixi/proto/brief/ui/v1/brief_ui_service_pb';
import { Item_Vote } from '@ziyixi/proto/brief/ui/v1/issue_pb';
import { createHttpClient, type HttpCall } from '@ziyixi/proto/http-client';
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
import { accessClaims, testIssuer } from '../jwt.ts';
import { bulkRegistry, FEED_ENTRIES, largestPick, largestWrite, seedVectors, serveBulkFeeds } from './bulk.ts';
import { la, MINUTE, OBJECT_WORKER, PUBLIC_HOST, SECOND, startHarness, SYNTHETIC_BINDINGS, type AlarmResult, type Harness } from './harness.ts';

const FREE_OBJECT_CPU_MS = 30_000;
/** The fetch handler: a JWT or a feedback token, CSRF, the object's answer passed on (recall's and mailsort's bounds). */
const WORKER_COLD_BOUND_MS = 0.6 * FREE_CPU_MS;
const WORKER_BOUND_MS = 0.25 * FREE_CPU_MS;
/** BriefState: an API call; the collect alarms at their bounds; an issue's alarm (the check, the write's stream). */
const OBJECT_API_BOUND_MS = 0.01 * FREE_OBJECT_CPU_MS;
const OBJECT_COLLECT_BOUND_MS = 0.1 * FREE_OBJECT_CPU_MS;
const OBJECT_ISSUE_BOUND_MS = 0.05 * FREE_OBJECT_CPU_MS;
const RUNS = 5;
const HANDLER = 'fetch handler';
const OBJECT = 'BriefState';
const POLLS = 'collect alarm: 40 polls of 1 MiB, 120 new entries';
const SCREEN = 'collect alarm: 120 embedded, the world ones clustered, ten gate calls';
const COLD_LABEL = "GET /api/csrf as the fetch handler's very first request";
const ISSUE = 'issue alarm: ';
const ISSUER = SYNTHETIC_BINDINGS['ACCESS_ISSUER'] ?? '';
const AUDIENCE = SYNTHETIC_BINDINGS['ACCESS_AUDIENCE'] ?? '';

interface BriefIsolate extends Isolate {
  readonly h: Harness;
  readonly object: CpuMeter;
}

let token = '';
let jwks: unknown;

async function startIsolate(): Promise<BriefIsolate> {
  if (token === '') {
    const issuer = await testIssuer();
    token = await issuer.sign(accessClaims(ISSUER, AUDIENCE, 'owner@example.com'));
    jwks = issuer.jwks;
  }
  const h = await startHarness({
    inspectorPort: 0,
    splitObject: true,
    registry: bulkRegistry(),
    bindings: { DEV_AUTH_BYPASS: undefined },
    routes: new Map([[`${ISSUER}/cdn-cgi/access/certs`, () => Response.json(jwks)]]),
  });
  try {
    const meter = await connectCpuMeter(h.mf, 'brief');
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

/** The largest of several samples (an issue step that took more than one alarm) as one measurement. */
function worst(label: string, samples: readonly number[]): Measurement {
  return { label, first: Math.max(...samples), median: Math.max(...samples), best: Math.min(...samples) };
}

/** The bulk day up to the cutoff, unmeasured: a baseline round, then the measured round's two alarms. */
async function collectAtBounds(h: Harness, object: CpuMeter): Promise<Measurement[]> {
  const feeds = serveBulkFeeds(h);
  const first = la('2026-10-11', '12:30');
  await h.step(first);
  await h.sql(`UPDATE items SET embedded = 1, gate = 'scored', topic = 'ml.other', score = 2, gate_day = '2026-10-11'`);
  await h.runUntil(first + SECOND, first + 30 * MINUTE, 20);
  const round = la('2026-10-11', '18:30');
  await seedVectors(h, round);
  feeds.entries = FEED_ENTRIES;
  let polls: AlarmResult = { job: '', code: '', next: 0 };
  const pollCpu = await object.cpu(async () => {
    polls = await h.step(round);
  });
  let screen: AlarmResult = { job: '', code: '', next: 0 };
  const screenCpu = await object.cpu(async () => {
    screen = await h.step(round + SECOND);
  });
  expect([polls.code, screen.code]).toEqual(['embedding', 'ok']);
  expect(await h.sql(`SELECT count(*) AS n FROM items WHERE gate = 'pending' OR embedded = 0`)).toEqual([{ n: 0 }]);
  await h.runUntil(round + 2 * SECOND, round + 30 * MINUTE, 20);
  await h.runUntil(la('2026-10-11', '23:30'), la('2026-10-11', '23:30') + 30 * MINUTE, 20);
  return [summarize(POLLS, [pollCpu]), summarize(SCREEN, [screenCpu])];
}

/** The largest issue, alarm by alarm from the cutoff round to the send, each issue alarm measured. */
async function issueAtBounds(h: Harness, object: CpuMeter): Promise<Measurement[]> {
  h.claude.script = (body, step) => (step === 'pick' ? largestPick(body) : step === 'write' ? largestWrite(body) : null);
  const samples = new Map<string, number[]>();
  for (let at = la('2026-10-12', '03:30'), i = 0; at <= la('2026-10-12', '09:00') && i < 60; i++) {
    let result: AlarmResult = { job: '', code: '', next: 0 };
    const cpu = await object.cpu(async () => {
      result = await h.step(at);
    });
    if (result.job === 'issue' || result.job === 'create') {
      const label = `${ISSUE}${result.step ?? result.job}`;
      samples.set(label, [...(samples.get(label) ?? []), cpu]);
    }
    at = Math.max(result.next, at + SECOND);
  }
  const [issue] = await h.sql<{ state: string; n: number }>(`SELECT state, (SELECT count(*) FROM issue_items WHERE issue = issues.issue) AS n FROM issues`);
  expect(issue).toEqual({ state: 'sent', n: 8 });
  expect(samples.has(`${ISSUE}check`)).toBe(true);
  return [...samples].map(([label, values]) => worst(label, values));
}

async function session({ h, meter: worker, object }: BriefIsolate, index: number): Promise<Measurement[]> {
  const headers = { 'cf-access-jwt-assertion': token };
  let csrf = new Response();
  const cold = await worker.measure(COLD_LABEL, async () => {
    csrf = await h.fetch('/api/csrf', { headers });
  }, 1);
  const csrfToken = (await csrf.json<{ token: string }>()).token;
  if (index !== COLD_ISOLATES - 1) return [cold];
  const mutationHeaders = { 'content-type': 'application/json', origin: `https://${PUBLIC_HOST}`, 'x-csrf-token': csrfToken, cookie: (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
  const send = (call: HttpCall): Promise<Response> =>
    h.fetch(call.url, {
      method: call.httpMethod,
      headers: { ...headers, ...(call.httpMethod === 'GET' ? {} : mutationHeaders), ...(call.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(call.body === undefined ? {} : { body: call.body }),
    });
  const api = createHttpClient(BriefUiService, send);

  const alarms = [...(await collectAtBounds(h, object)), ...(await issueAtBounds(h, object))];

  async function both(label: string, run: (i: number) => Promise<unknown>): Promise<Measurement[]> {
    const workerSamples: number[] = [];
    const objectSamples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      let inner = 0;
      workerSamples.push(
        await worker.cpu(async () => {
          inner = await object.cpu(() => run(i));
        }),
      );
      objectSamples.push(inner);
    }
    return [summarize(`${label}: ${HANDLER}`, workerSamples), summarize(`${label}: ${OBJECT}`, objectSamples)];
  }

  const items = await api.listItems({ parent: 'issues/2026-10-12' });
  const item = items.items[0]?.name ?? '';
  const html = h.sent[0]?.body.html ?? '';
  const link = /href="https:\/\/brief\.example\.org(\/feedback\?t=[^"]+)"/.exec(html)?.[1] ?? '';
  const feedbackToken = decodeURIComponent(link.split('t=')[1] ?? '');
  expect(feedbackToken).not.toBe('');
  const settings = await api.getSettings({ name: 'settings' });
  let etag = settings.etag;
  const api_ = [
    ...(await both('GET issues', () => api.listIssues({}))),
    ...(await both('GET issues/<date> (8 items)', () => api.getIssue({ name: 'issues/2026-10-12' }))),
    ...(await both('GET issues/<date>/items', () => api.listItems({ parent: 'issues/2026-10-12' }))),
    ...(await both('GET sources (40)', () => api.listSources({ pageSize: 100 }))),
    ...(await both('GET serviceStatus', () => api.getServiceStatus({ name: 'serviceStatus' }))),
    ...(await both('GET profile', () => api.getProfile({ name: 'profile' }))),
    ...(await both('PATCH settings (mask)', async (i) => {
      const updated = await api.updateSettings({ settings: { name: 'settings', monthlyBudgetUsd: 40 + i, etag }, updateMask: { paths: ['monthly_budget_usd', 'etag'] }, requestId: crypto.randomUUID() });
      etag = updated.etag;
    })),
    ...(await both('POST items/<id>:vote', (i) => api.voteItem({ name: item, vote: i % 2 === 0 ? Item_Vote.UP : Item_Vote.MORE, requestId: crypto.randomUUID() }))),
    ...(await both('GET /feedback (the token, the page)', async () => {
      const response = await h.fetch(link);
      await response.arrayBuffer();
      if (response.status !== 200) throw new Error(`feedback page: ${String(response.status)}`);
    })),
    ...(await both('POST /feedback (the vote)', async () => {
      const response = await h.fetch('/feedback', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `t=${encodeURIComponent(feedbackToken)}` });
      await response.arrayBuffer();
      if (response.status !== 200) throw new Error(`feedback vote: ${String(response.status)}`);
    })),
  ];
  return [cold, ...alarms, ...api_];
}

describe('CPU (Workers Free: 10 ms per request, 30 s per Durable Object invocation)', () => {
  it('the fetch handler stays far below 10 ms and BriefState far below 30 s, the alarms at their bounds too', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
    const { reference } = await measureInIsolates(COLD_ISOLATES, startIsolate, session);
    const get = (label: string): Measurement => {
      const measurement = reference.get(label);
      if (measurement === undefined) throw new Error(`not measured: ${label}`);
      return measurement;
    };
    console.log(
      `cpu bounds (reference ms): fetch handler first < ${WORKER_COLD_BOUND_MS.toFixed(1)}, median < ${WORKER_BOUND_MS.toFixed(1)}; ` +
        `${OBJECT} API < ${OBJECT_API_BOUND_MS.toFixed(0)}, collect alarms < ${OBJECT_COLLECT_BOUND_MS.toFixed(0)}, issue alarms < ${OBJECT_ISSUE_BOUND_MS.toFixed(0)}`,
    );
    expect(get(COLD_LABEL).first, COLD_LABEL).toBeLessThan(WORKER_COLD_BOUND_MS);
    for (const { label, first, median } of reference.values()) {
      if (label.endsWith(`: ${HANDLER}`)) {
        expect(first, `${label}, first run`).toBeLessThan(WORKER_COLD_BOUND_MS);
        expect(median, `${label}, warm median`).toBeLessThan(WORKER_BOUND_MS);
      } else if (label.endsWith(`: ${OBJECT}`)) {
        expect(first, label).toBeLessThan(OBJECT_API_BOUND_MS);
      } else if (label.startsWith(ISSUE)) {
        expect(first, label).toBeLessThan(OBJECT_ISSUE_BOUND_MS);
      }
    }
    expect(get(POLLS).first, POLLS).toBeLessThan(OBJECT_COLLECT_BOUND_MS);
    expect(get(SCREEN).first, SCREEN).toBeLessThan(OBJECT_COLLECT_BOUND_MS);
    expect(get(`${ISSUE}check`).first, 'the check').toBeLessThan(OBJECT_ISSUE_BOUND_MS);
    expect(get(`${ISSUE}write`).first, 'the write').toBeLessThan(OBJECT_ISSUE_BOUND_MS);
    expect([...reference.keys()].filter((label) => label.endsWith(`: ${HANDLER}`))).toHaveLength(10);
  });
});
