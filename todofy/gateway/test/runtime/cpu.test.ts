/**
 * The gateway's CPU per owner API request inside workerd, against Workers Free's 10 ms (a plain Worker request; the
 * work itself runs in TodofyCore, a Durable Object with 30 s), measured and calibrated by the shared meter
 * (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU profile of the gateway's isolate around each request, and the
 * machine's speed from a fixed workload run in the same isolate. The bounds are milliseconds of the reference
 * machine (an Apple M1 Max).
 *
 * Every request is a real one: Access verified as in production (RS256 against a synthetic issuer's keys, cached in
 * the isolate after the first), the transcoder's decode, one RPC to the stand-in TodofyCore (harness.ts), the
 * generated code's lenient read of its answer and the transcoder's write. The answers are the largest TodofyCore
 * gives (fixtures.ts): the gateway's cost grows with them, since it reads and writes every answer again.
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
 * The two answers far larger than the others, read and written again whole: the 1.9 MB legacy text (JSON.parse and
 * stringify of 1.9 million ASCII characters heavy in escapes, the worst case of D1's largest row: first runs
 * 5.96-6.22 and warm medians 5.26-5.67 ms in six runs; the same bytes of Chinese text, 633,333 characters, read
 * 4.4 / 3.8) and every stored report at the newsletter's limits (about 230,000 characters whose text rules the codec
 * checks on the read and on the write, 4.6-5.0 / 4.7-4.9 ms).
 */
const LARGE_BOUND_MS = 0.8 * FREE_CPU_MS;
const RUNS = 11;
const ISSUER = SYNTHETIC_BINDINGS['ACCESS_ISSUER'] ?? '';
const AUDIENCE = SYNTHETIC_BINDINGS['ACCESS_AUDIENCE'] ?? '';

const API_INIT = "GET /api/v1/serviceStatus as the isolate's first API request";
const LEGACY = 'GET /api/v1/legacyTexts/{id} (1.9 MB of ASCII with escapes)';
const REPORTS = 'GET /api/v1/latestReports (every report at its limits)';
const LARGE = new Set([LEGACY, REPORTS]);

const ANSWERS = {
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
  return measured;
}

describe('CPU per owner API request (Workers Free: 10 ms)', () => {
  it('stays well below the limit for the largest answers TodofyCore gives', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
    const { reference } = await measureInIsolates(COLD_ISOLATES, startIsolate, session);
    console.log(
      `cpu bounds (reference ms, medians of ${String(COLD_ISOLATES)} isolates): API's first request < ${API_INIT_BOUND_MS.toFixed(2)}, ` +
        `first < ${API_COLD_BOUND_MS.toFixed(2)}, median < ${API_BOUND_MS.toFixed(2)}, the legacy text and the reports < ${LARGE_BOUND_MS.toFixed(2)}`,
    );
    for (const { label, first, median } of reference.values()) {
      if (label === API_INIT) expect(first, label).toBeLessThan(API_INIT_BOUND_MS);
      else if (LARGE.has(label)) {
        expect(first, `${label}: first run`).toBeLessThan(LARGE_BOUND_MS);
        expect(median, `${label}: warm median`).toBeLessThan(LARGE_BOUND_MS);
      } else {
        expect(first, `${label}: first run`).toBeLessThan(API_COLD_BOUND_MS);
        expect(median, `${label}: warm median`).toBeLessThan(API_BOUND_MS);
      }
    }
    expect(reference.size).toBe(11);
  });
});
