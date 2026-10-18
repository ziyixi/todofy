/**
 * The gateway's CPU per owner API request inside workerd, against Workers Free's 10 ms (a plain Worker request; the
 * work itself runs in TodofyCore, a Durable Object with 30 s), measured and calibrated by the shared meter
 * (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU profile of the gateway's isolate around each request, and the
 * machine's speed from a fixed workload run in the same isolate. The bounds are milliseconds of the reference
 * machine (an Apple M1 Max).
 *
 * Every request is a real one: Access verified as in production (RS256 against a synthetic issuer's keys, cached in
 * the isolate after the first), the transcoder's decode, one RPC to the stand-in TodofyCore (harness.ts), and the
 * answer: a list's page read leniently with the generated code and written again by the transcoder, any other answer
 * passed through as TodofyCore wrote it (PreEncoded, test/pre-encoded.test.ts). The answers are the largest
 * TodofyCore gives (fixtures.ts).
 *
 * The whole session runs in COLD_ISOLATES fresh isolates (measureInIsolates): every number is divided by its own
 * isolate's speed (never below 1), and the bounds hold each number's median across the isolates.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { COLD_ISOLATES, connectCpuMeter, CPU_TEST_TIMEOUT_MS, FREE_CPU_MS, measureInIsolates, type Isolate, type Measurement } from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import * as fixtures from './fixtures.ts';
import { ORIGIN, OWNER, startHarness, SYNTHETIC_BINDINGS, type Harness } from './harness.ts';
import { accessClaims, testIssuer } from './jwt.ts';

/**
 * The isolate's first API request (the service status, what every page asks first), in reference milliseconds: the
 * first RS256 verification and key import, the transcoder's first run and what the codec still does the first time
 * after src/warm.ts. Medians of 4.2-5.2 ms measured, single isolates 3.9-8.6 on a busy machine (3.2-3.3 before
 * todofy.ui.v1): ../../docs/gateway-contract.md §8, "CPU".
 */
const API_INIT_BOUND_MS = 0.8 * FREE_CPU_MS;
/** Every other request's first run and warm median, in reference milliseconds (at most 3.2 and 2.9 measured). */
const API_COLD_BOUND_MS = 0.6 * FREE_CPU_MS;
const API_BOUND_MS = 0.4 * FREE_CPU_MS;
/**
 * The two answers far larger than the others, the 1.9 MB legacy text (D1's largest row, ASCII heavy in escapes) and
 * every stored report at the newsletter's limits, passed through unread since 2026-10-05: first runs 1.0-1.6 and warm
 * medians 1.1-1.2 ms in four runs, what the RPC and the response cost for their size. Reading and writing them again
 * cost 6.0-6.4 / 5.3-5.7 and 4.6-5.2 / 4.7-5.0 ms, so this bound fails if either is decoded again.
 */
const PASSED_THROUGH_BOUND_MS = 0.3 * FREE_CPU_MS;
const RUNS = 11;
const ISSUER = SYNTHETIC_BINDINGS['ACCESS_ISSUER'] ?? '';
const AUDIENCE = SYNTHETIC_BINDINGS['ACCESS_AUDIENCE'] ?? '';

const API_INIT = "GET /api/v1/serviceStatus as the isolate's first API request";
const LEGACY = 'GET /api/v1/legacyTexts/{id} (1.9 MB of ASCII with escapes)';
const REPORTS = 'GET /api/v1/latestReports (every report at its limits)';
const PLUS = "GET /api/plus/v1/tasks (200 tasks, Tasks' Planning channel)";
// A FULL Plan, which the gateway reads and writes again to add flowday_url: 500 labels, 300 dependencies, six Bets and
// every Review lane's order (7 lanes of 100), the most TodofyCore answers.
const PLAN = 'GET /api/plus/v1/plan:read (500 labels, 300 dependencies, six Bets, 700 lane order IDs)';
// Mail's two largest answers, passed through unread like the legacy text and the reports: a decode of either again
// would show here.
const MAIL_ITEMS = 'GET /api/plus/v1/mailItems (a full page of 50 items)';
const MAIL_SUMMARY = 'GET /api/plus/v1/mailItems:readMailSummary (64 KiB summary)';
const FOCUS = 'GET /api/plus/flowday/api/v1/tasks (100 tasks, the proxy\'s largest page)';
// The generated FlowDay client decodes and the proxy re-encodes a full page. A 200-task page with 2,000-char titles
// and descriptions reached 10.2 ms cold in CI, so the proxy caps a page at 100 tasks (plus.ts FOCUS_PAGE_MAX).
// Keep this path's growth decision separate from the existing API ratchets and the Free 10 ms limit.
const FOCUS_COLD_BOUND_MS = 0.8 * FREE_CPU_MS;
const FOCUS_BOUND_MS = 0.6 * FREE_CPU_MS;
const PASSED_THROUGH = new Set([LEGACY, REPORTS, MAIL_ITEMS, MAIL_SUMMARY]);

const ANSWERS = {
  plus_native_ui: {
    ListPlanningTasks: fixtures.ok({ planning_tasks: Array.from({ length: 200 }, (_, n) => ({
      id: `task-${String(n)}`, title: 'Synthetic planning task '.repeat(20), project_id: 'test-project',
      labels: ['office', 'deep', 'committed', 'lead_2w'], stage: 'committed', area: 'work',
      deadline: '2026-10-27', due: '2026-10-13', lead_days: 14, estimated_minutes: 45, etag: 'a'.repeat(64),
      update_time: '2026-10-14T09:30:05Z', child_order: n, order_key: `a${n.toString(36).padStart(8, '0')}`,
    })) }),
    ReadPlan: fixtures.ok({ plan: {
      timezone: 'America/Los_Angeles', week_start: '2026-10-12', today: '2026-10-13', enabled: true, etag: 'a'.repeat(64),
      available_labels: Array.from({ length: 500 }, (_, n) => ({ id: `label-${String(n)}`, label: `synthetic_label_${String(n)}` })),
      next_week_task_ids: Array.from({ length: 100 }, (_, n) => `task-${String(n)}`),
      dependencies: Array.from({ length: 300 }, (_, n) => ({
        task_id: `task-${String(n)}`, prerequisite_id: `task-${String(n + 1)}`, baseline_completed_count: n, done: n % 2 === 0,
      })),
      weekly_bets: ['2026-10-05', '2026-10-12', '2026-10-19'].flatMap((week) => ['work', 'personal'].map((area) => ({
        week_start: week, area, text: 'Synthetic weekly Bet '.repeat(8).slice(0, 160), etag: '7', update_time: '2026-10-12T09:30:05Z',
      }))),
      lane_orders: ['start', 'waiting', 'parked', 'quarterly', 'monthly', 'weekly', 'committed'].map((lane) => ({
        lane, task_ids: Array.from({ length: 100 }, (_, n) => `6X7rM8997g3RQ${lane}${String(n).padStart(3, '0')}`),
      })),
    } }),
    ListMailItems: fixtures.ok(fixtures.mailItems(50)),
    ReadMailSummary: fixtures.ok(fixtures.mailSummary()),
  },
  owner_ui: {
    GetServiceStatus: fixtures.ok(fixtures.serviceStatus()),
    ListMailEvents: fixtures.ok(fixtures.eventPage(100), { at: 1_759_046_400, id: fixtures.UUID(99) }),
    GetMailEvent: fixtures.ok(fixtures.eventDetail()),
    ReconcileMailEvent: fixtures.ok(fixtures.eventDetail()),
    GetLegacyText: fixtures.ok(fixtures.legacyText()),
    ListMetricDays: fixtures.ok(fixtures.metricDays(90), { day: '2026-06-30' }),
    ListGtdDays: fixtures.ok(fixtures.gtdDays(120)),
    GetLatestReports: fixtures.ok(fixtures.latestReports()),
    ListDailyReminders: fixtures.ok(fixtures.reminderPage(100), { day: '2026-06-01' }),
  },
};

let token = '';
let issuerJwks: unknown;

beforeAll(async () => {
  const issuer = await testIssuer();
  token = await issuer.sign(accessClaims(ISSUER, AUDIENCE, OWNER));
  issuerJwks = issuer.jwks;
});

interface GatewayIsolate extends Isolate {
  readonly h: Harness;
}

async function startIsolate(): Promise<GatewayIsolate> {
  const h = await startHarness({
    answers: ANSWERS,
    focusTasks: { tasks: Array.from({ length: 100 }, (_, n) => ({
      name: `tasks/task-${String(n)}`, todoist_id: `task-${String(n)}`,
      title: 'Synthetic Focus task '.repeat(100).slice(0, 2000), description: 'Synthetic description. '.repeat(100).slice(0, 2000),
      project_display_name: 'Synthetic project', project_color: '#00ff00', priority: 4,
      labels: ['office', 'deep', 'committed', 'lead_2w'], estimated_minutes: 45, due_date: '2026-10-13',
      deadline_date: '2026-10-27', parent_id: 'parent-task', create_time: '2026-10-01T10:00:00Z',
    })) },
    inspectorPort: 0,
    routes: new Map([[`${ISSUER}/cdn-cgi/access/certs`, () => Response.json(issuerJwks)]]),
  });
  try {
    const meter = await connectCpuMeter(h.mf, 'todofy');
    return {
      h,
      meter,
      async dispose() {
        meter.close();
        await h.dispose();
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}

async function expectOk(h: Harness, path: string, init: RequestInit = {}): Promise<void> {
  const response = await h.fetch(path, { ...init, headers: { 'cf-access-jwt-assertion': token, ...(init.headers as Record<string, string> | undefined) } });
  await response.arrayBuffer();
  if (response.status !== 200) throw new Error(`${path}: ${String(response.status)}`);
}

/** One isolate's session: its first API request alone, then each heaviest request. */
async function session({ h, meter }: GatewayIsolate): Promise<Measurement[]> {
  const init = await meter.measure(API_INIT, () => expectOk(h, '/api/v1/serviceStatus'), 1);
  // The CSRF token for the reconcile, outside the measurements.
  const csrf = await h.fetch('/api/csrf', { headers: { 'cf-access-jwt-assertion': token } });
  const csrfToken = (await csrf.json<{ token: string }>()).token;
  const cookie = (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  // A real next page: the token the first page answered.
  const first = await h.fetch('/api/v1/mailEvents?page_size=100', { headers: { 'cf-access-jwt-assertion': token } });
  const pageToken = (await first.json<{ next_page_token: string }>()).next_page_token;
  const event = `mailEvents/${fixtures.UUID(0)}`;
  const requests: [string, string, RequestInit?][] = [
    ['GET /api/v1/serviceStatus', '/api/v1/serviceStatus'],
    ['GET /api/v1/mailEvents (a full page of 100)', '/api/v1/mailEvents?page_size=100'],
    ['GET /api/v1/mailEvents (the next page, through its token)', `/api/v1/mailEvents?page_size=100&page_token=${pageToken}`],
    ['GET /api/v1/mailEvents/{id} (100 transitions, 64 KiB summary)', `/api/v1/${event}`],
    [LEGACY, `/api/v1/legacyTexts/${fixtures.UUID(0)}`],
    ['GET /api/v1/metricDays (90 days)', '/api/v1/metricDays?page_size=90'],
    ['GET /api/v1/gtdDays (120 days)', '/api/v1/gtdDays?page_size=120'],
    [REPORTS, '/api/v1/latestReports'],
    ['GET /api/v1/dailyReminders (a full page of 100)', '/api/v1/dailyReminders?page_size=100'],
    [
      'POST /api/v1/mailEvents/{id}:reconcile (CSRF checked)',
      `/api/v1/${event}:reconcile`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-csrf-token': csrfToken, cookie },
        body: JSON.stringify({ action: 'dismiss', etag: '101', request_id: crypto.randomUUID() }),
      },
    ],
  ];
  const measured: Measurement[] = [init];
  for (const [label, path, options] of requests) measured.push(await meter.measure(label, () => expectOk(h, path, options), RUNS));
  // Tasks' requests on its private Planning channel.
  const planning: [string, string][] = [
    [PLUS, '/api/plus/v1/tasks?page_size=200'],
    [PLAN, '/api/plus/v1/plan:read'],
    [FOCUS, '/api/plus/flowday/api/v1/tasks?page_size=100'],
    [MAIL_ITEMS, '/api/plus/v1/mailItems?page_size=50'],
    [MAIL_SUMMARY, `/api/plus/v1/mailItems:readMailSummary?id=${fixtures.UUID(0)}`],
  ];
  for (const [label, path] of planning) {
    measured.push(await meter.measure(label, async () => {
      const response = await h.planning(path);
      await response.arrayBuffer();
      if (response.status !== 200) throw new Error(`${label}: ${String(response.status)}`);
    }, RUNS));
  }
  return measured;
}

describe('CPU per owner API request (Workers Free: 10 ms)', () => {
  it('stays well below the limit for the largest answers TodofyCore gives', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
    const { reference } = await measureInIsolates(COLD_ISOLATES, startIsolate, session);
    console.log(
      `cpu bounds (reference ms, medians of ${String(COLD_ISOLATES)} isolates): API's first request < ${API_INIT_BOUND_MS.toFixed(2)}, ` +
        `first < ${API_COLD_BOUND_MS.toFixed(2)}, median < ${API_BOUND_MS.toFixed(2)}, the legacy text, the reports and Mail's answers < ${PASSED_THROUGH_BOUND_MS.toFixed(2)}`,
    );
    for (const { label, first, median } of reference.values()) {
      if (label === API_INIT) expect(first, label).toBeLessThan(API_INIT_BOUND_MS);
      else if (PASSED_THROUGH.has(label)) {
        expect(first, `${label}: first run`).toBeLessThan(PASSED_THROUGH_BOUND_MS);
        expect(median, `${label}: warm median`).toBeLessThan(PASSED_THROUGH_BOUND_MS);
      } else if (label === FOCUS) {
        expect(first, `${label}: first run`).toBeLessThan(FOCUS_COLD_BOUND_MS);
        expect(median, `${label}: warm median`).toBeLessThan(FOCUS_BOUND_MS);
      } else {
        expect(first, `${label}: first run`).toBeLessThan(API_COLD_BOUND_MS);
        expect(median, `${label}: warm median`).toBeLessThan(API_BOUND_MS);
      }
    }
    expect(reference.size).toBe(16);
  });
});
