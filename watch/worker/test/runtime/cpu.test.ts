/**
 * CPU inside workerd against Workers Free (../../../docs/design.md §8), measured and calibrated by the shared meter
 * (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU profile of an isolate around each request, and the machine's speed
 * from a fixed workload run in the same isolate. Bounds are milliseconds of the reference machine (an Apple M1 Max).
 *
 * WatchState runs in a Worker of its own here (HarnessOptions.splitObject), as on Cloudflare, so the two limits are
 * measured apart:
 *
 * - the fetch handler (10 ms per request): Access (an RS256 verification, the keys cached), CSRF, one call to the object
 *   and the answer passed through, for the heaviest answers the API has (a full list of WATCHES_MAX watches, a full page
 *   of CHANGE_PAGE changes with DIFF_LINES_KEPT lines of DIFF_LINE_MAX characters each, a 2 MiB page's preview);
 * - WatchState (30 s per invocation): those API calls, and the alarm path: a pass over every watch with a large page
 *   (the first notified states, then a change on every page), and the preview of a page of FETCH_MAX_BYTES, plain and
 *   hostile (2,000-character runs of each character class a default mask consumes: page text is untrusted, and a
 *   mask that is not linear costs seconds on such a page).
 *
 * No dev bypass: Access is verified as in production.
 *
 * The fetch handler's very first request, the one number measured on a fresh isolate, is measured in COLD_ISOLATES
 * fresh isolates (a new harness each, measureInIsolates) and bounded by the median; everything else once, in the
 * third (the alarm passes over 2 MiB pages take seconds each). Every number is divided by the speed of its isolates'
 * calibration (the fetch handler's isolate calibrates; WatchState's runs on the same machine at the same time), and a
 * median speed above MAX_SPEED fails the test.
 */
import { beforeAll, describe, expect, it } from 'vitest';
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
import { ALARM_BYTES_BUDGET, CHANGE_PAGE, DIFF_LINE_MAX, DIFF_LINES_KEPT, FETCH_MAX_BYTES, WATCH_PAGE, WATCHES_MAX } from '../../src/limits.ts';
import { accessClaims, testIssuer } from '../jwt.ts';
import { HOUR, OBJECT_WORKER, op, PUBLIC_HOST, startHarness, SYNTHETIC_BINDINGS, T0, type Harness } from './harness.ts';

/** Workers Free's CPU per Durable Object invocation (an alarm, a request). */
const FREE_OBJECT_CPU_MS = 30_000;
/**
 * The fetch handler, in reference milliseconds. It verifies a JWT and a CSRF token and passes the object's answer on:
 * measured (2026-10-01) 1.9-2.2 ms on its isolate's very first request (the Access keys fetched and imported, the CSRF
 * key derived; once 4.3 ms with the whole suite running), 0.4-1 ms on every other first run and 0.4-0.95 ms warm,
 * whatever the answer's size. The first request's bound holds the median of COLD_ISOLATES isolates.
 */
const WORKER_COLD_BOUND_MS = 0.6 * FREE_CPU_MS;
const WORKER_BOUND_MS = 0.2 * FREE_CPU_MS;
/**
 * WatchState, in reference milliseconds (measured: ../../../docs/design.md §8): its heaviest API calls (a full page of
 * changes about 25 ms), and an alarm pass or the largest preview (a pass over pages of 2 MiB is the most: seconds, not
 * the 30 s of the limit).
 */
const OBJECT_API_BOUND_MS = 0.01 * FREE_OBJECT_CPU_MS;
const OBJECT_ALARM_BOUND_MS = 0.25 * FREE_OBJECT_CPU_MS;
/**
 * The wall-clock limits here. This test bounds CPU; wall time is the test machine's, and a timeout that trips on a slow
 * machine changes what a pass does: the page goes unread and its parse uncounted. A page request's timer runs until
 * its body is read, which includes waiting for the isolate while other lanes (ALARM_CONCURRENCY) parse and diff their
 * pages: measured 1.4 s for the requests queued behind two lanes in the worst pass on the reference machine, 2.4 s
 * with nine of its ten cores busy. On GitHub runners one request of that pass, always cpu-42's, outlived production's
 * 15 s in 3 of 5 runs (2026-10-02: its check failed without a byte read, and the pass ran about 15 s longer). The
 * fetch timeout itself is etiquette.test.ts's. So a page request may take PASS_FETCH_TIMEOUT_MS here
 * (DEV_FETCH_TIMEOUT_MS), and each measured run in WatchState PASS_RUN_LIMIT_MS (the meter's limit, which names the
 * run), far above a pass on a slow runner (about 20 s): a request that never answers still fails, as TIMEOUT with its
 * watch named. The alarm's own wall budget (ALARM_WALL_BUDGET_MS less ALARM_START_MARGIN_MS: 7.5 minutes) cannot bind
 * within these limits.
 */
const PASS_FETCH_TIMEOUT_MS = 2 * INSPECTOR_TIMEOUT_MS;
const PASS_RUN_LIMIT_MS = 2 * PASS_FETCH_TIMEOUT_MS;
/**
 * The pages of FETCH_MAX_BYTES (just under) one alarm reads: a check starts only while FETCH_MAX_BYTES are left of
 * ALARM_BYTES_BUDGET for it and for each check in flight. The other due watches wait for the next alarm (never a
 * failure); the 40 requests do not bind (one per check, robots.txt cached).
 */
const PAGES_PER_PASS = Math.floor(ALARM_BYTES_BUDGET / FETCH_MAX_BYTES);
const RUNS = 7;
/** Label suffixes of a request measured in both isolates. */
const HANDLER = 'fetch handler';
const OBJECT = 'WatchState';
const HUGE_PREVIEW = `POST watches:preview (a page of ${String(FETCH_MAX_BYTES / 1024 / 1024)} MiB, cached)`;
const HOSTILE_PREVIEW = `POST watches:preview (a hostile page of ${String(FETCH_MAX_BYTES / 1024 / 1024)} MiB, cached)`;
const ALARM_FIRST = 'alarm pass: first notified states';
const ALARM_CHANGED = 'alarm pass: a change on every page';
const ALARM_WORST = `alarm pass: pages of ${String(FETCH_MAX_BYTES / 1024 / 1024)} MiB`;
const ISSUER = SYNTHETIC_BINDINGS['ACCESS_ISSUER'] ?? '';
const AUDIENCE = SYNTHETIC_BINDINGS['ACCESS_AUDIENCE'] ?? '';

const COLD_LABEL = "GET /api/csrf as the fetch handler's very first request";

let token = '';
let issuerJwks: unknown;

beforeAll(async () => {
  const issuer = await testIssuer();
  token = await issuer.sign(accessClaims(ISSUER, AUDIENCE, 'owner@example.com'));
  issuerJwks = issuer.jwks;
});

/** A fresh isolate pair: a new harness, its fetch handler's meter (`meter`, which calibrates) and WatchState's. */
interface WatchIsolate extends Isolate {
  readonly h: Harness;
  readonly object: CpuMeter;
}

async function startIsolate(): Promise<WatchIsolate> {
  // Port 0: the OS picks a free port, which the meters read back from Miniflare.
  const h = await startHarness({
    inspectorPort: 0,
    splitObject: true,
    bindings: { DEV_AUTH_BYPASS: 'false', DEV_FETCH_TIMEOUT_MS: String(PASS_FETCH_TIMEOUT_MS) },
    routes: new Map([[`${ISSUER}/cdn-cgi/access/certs`, () => Response.json(issuerJwks)]]),
  });
  try {
    const meter = await connectCpuMeter(h.mf, 'watch');
    const object = await connectCpuMeter(h.mf, OBJECT_WORKER, PASS_RUN_LIMIT_MS);
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

/** A synthetic page of about `kib` KiB: paragraphs, a table and lists, with `variant` in some lines. */
function bigPage(n: number, kib: number, variant: number): string {
  const parts: string[] = [];
  let size = 0;
  for (let i = 0; size < kib * 1024; i++) {
    const line = `<p>Paragraph ${String(i)} of synthetic page ${String(n)}: prices, opening hours and notices ${i % 50 === 0 ? `revision ${String(variant)}` : 'unchanged'}, &amp; more text 3 minutes ago.</p>`;
    parts.push(i % 10 === 0 ? `<section id="s${String(i)}"><h2>Section ${String(i)}</h2>${line}</section>` : line);
    size += line.length;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic ${String(n)}</title><script>var x = 1;</script></head><body><nav><a href="/">Home</a></nav><main>${parts.join('\n')}</main><footer>© 2026</footer></body></html>`;
}

/** A page just under FETCH_MAX_BYTES (a larger body is TOO_LARGE before any parse). */
function hugePage(n: number): string {
  const paragraph = `<p>A very large synthetic page ${String(n)} with many repeated paragraphs of text, 5 minutes ago.</p>\n`;
  return `<!doctype html><html><body><main>${paragraph.repeat(Math.floor((FETCH_MAX_BYTES - 200) / paragraph.length))}</main></body></html>`;
}

/**
 * A page just under FETCH_MAX_BYTES of hostile text: paragraphs of 2,000-character runs of what the masks match
 * (Chinese numerals and units, digits and digit groups, times, hex, base64, English relative times, copyright signs,
 * query values), the inputs on which an unbounded or unanchored pattern turns quadratic.
 */
function hostilePage(): string {
  const units = ['一', '一天', '7', '1,', '1:', '1-', 'a1', 'aB3', '1 ago ', 'in ', '© ', '?v=', '三年', '前'];
  const paragraphs: string[] = [];
  let size = 0;
  for (let i = 0; size < FETCH_MAX_BYTES - 8 * 1024; i++) {
    const unit = units[i % units.length] ?? 'x';
    const paragraph = `<p>${unit.repeat(Math.ceil(2000 / unit.length)).slice(0, 2000)}</p>\n`;
    paragraphs.push(paragraph);
    size += new TextEncoder().encode(paragraph).byteLength;
  }
  return `<!doctype html><html><body><main>${paragraphs.join('')}</main></body></html>`;
}

/** The page watch `cpu-<n>` watches, each on a host of its own. */
function pageUrl(n: number): string {
  return `https://cpu${String(n)}.example.com/p`;
}

function setPages(h: Harness, variant: number): void {
  for (let n = 0; n < WATCHES_MAX; n++) h.sites.html(pageUrl(n), bigPage(n, 200, variant));
}

/** What one scheduler pass answered (WatchState.step). */
type Pass = Awaited<ReturnType<Harness['step']>>;

/**
 * One isolate's session: the fetch handler's very first request; in the third isolate also the alarm passes, every
 * API call and the previews, each in both isolates at once.
 */
async function session({ h, meter: worker, object }: WatchIsolate, index: number): Promise<Measurement[]> {
  const headers = { 'cf-access-jwt-assertion': token };
  let csrf = new Response();
  // The fetch handler's very first request (Access keys fetched, the RS256 key imported, the CSRF key derived).
  const cold = await worker.measure(COLD_LABEL, async () => {
    csrf = await h.fetch('/api/csrf', { headers });
  }, 1);
  const csrfToken = (await csrf.json<{ token: string }>()).token;
  if (index !== COLD_ISOLATES - 1) return [cold];

  const mutationHeaders = { ...headers, 'content-type': 'application/json', origin: `https://${PUBLIC_HOST}`, 'x-csrf-token': csrfToken, cookie: (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
  setPages(h, 0);
  h.sites.html('https://huge.example.com/p', hugePage(-1));
  h.sites.html('https://hostile.example.com/p', hostilePage());
  // Previewed only (no watch fetches it: a URL a check fetched is not fetched again by a preview within 15 minutes).
  h.sites.html('https://medium.example.com/p', bigPage(-2, 200, 0));
  for (let n = 0; n < WATCHES_MAX; n++) {
    const response = await h.fetch(`/api/v1/watches?watch_id=cpu-${String(n)}&request_id=${op()}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ display_name: `Synthetic page ${String(n)}`, uri: pageUrl(n), stability: { skip_confirmation: n % 2 === 0 } }),
    });
    if (response.status !== 200) throw new Error(`create ${String(n)}: ${String(response.status)} ${await response.text()}`);
  }
  // CHANGE_PAGE changes with full diffs on one watch: the heaviest ListChanges page.
  const diff = JSON.stringify(Array.from({ length: DIFF_LINES_KEPT }, (_, i) => ({ kind: i % 2 === 0 ? 'added' : 'removed', text: `${'x'.repeat(DIFF_LINE_MAX - 10)}${String(i).padStart(10, '0')}` })));
  for (let c = 0; c < CHANGE_PAGE; c++) {
    await h.sql(
      `INSERT INTO changes (id, watch_id, state, trigger_kind, summary, added, removed, diff, truncated, detect_time, resolve_time) VALUES (?, 'cpu-0', 'confirmed', 'any_change', '新增 100 行，删除 100 行', 100, 100, ?, 1, ?, ?)`,
      `0mvg${String(c).padStart(12, '0')}`,
      diff,
      T0,
      T0,
    );
  }

  async function expectOk(path: string, init: RequestInit = {}): Promise<void> {
    const response = await h.fetch(path, { headers, ...init });
    await response.arrayBuffer();
    if (response.status !== 200) throw new Error(`${path}: ${String(response.status)}`);
  }

  /** A request measured in both isolates at once: `<label>: fetch handler` and `<label>: WatchState`. */
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
    console.log(`cpu ${label}: fetch handler first ${(result[0]?.first ?? 0).toFixed(2)} ms, median ${(result[0]?.median ?? 0).toFixed(2)} ms; WatchState first ${(result[1]?.first ?? 0).toFixed(2)} ms, median ${(result[1]?.median ?? 0).toFixed(2)} ms`);
    return result;
  }

  // The alarm path: the first pass sets the notified states (50 pages of 200 KiB, as far as the budget goes).
  let clock = T0;
  const passes: Pass[] = [];
  const pass = async () => {
    passes.push(await h.step(clock));
  };
  const firstPass = summarize(ALARM_FIRST, [await object.cpu(pass)]);
  clock += 1000;
  for (let i = 0; i < 6; i++) {
    await h.step(clock);
    clock += 1000;
  }
  // A change on every page: diffs, pending and confirmed changes, snapshots.
  setPages(h, 1);
  clock = T0 + 8 * HOUR;
  const changed = summarize(ALARM_CHANGED, [await object.cpu(pass)]);

  const api = [
    ...(await both(`GET watches (${String(WATCH_PAGE)})`, () => expectOk('/api/v1/watches'))),
    ...(await both(`GET changes (${String(CHANGE_PAGE)} with ${String(DIFF_LINES_KEPT)} diff lines each)`, () => expectOk('/api/v1/watches/-/changes'))),
    ...(await both('GET changes, the inbox filter', () => expectOk(`/api/v1/watches/-/changes?filter=${encodeURIComponent('state = NEW')}`))),
    ...(await both('GET serviceStatus', () => expectOk('/api/v1/serviceStatus'))),
    ...(await both('PATCH a watch (mask)', () =>
      expectOk(`/api/v1/watches/cpu-1?update_mask=display_name&request_id=${op()}`, { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ display_name: 'Renamed' }) }),
    )),
    ...(await both('POST watches:preview (a 200 KiB page, cached)', () =>
      expectOk('/api/v1/watches:preview', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ watch: { display_name: 'p', uri: 'https://medium.example.com/p' } }) }),
    )),
  ];
  const largest = await h.fetch('/api/v1/watches:preview', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ watch: { display_name: 'p', uri: 'https://huge.example.com/p' } }) });
  expect((await largest.json<{ fetch?: { body_bytes?: number } }>()).fetch?.body_bytes).toBeGreaterThan(FETCH_MAX_BYTES - 1024);
  const huge = await both(HUGE_PREVIEW, () =>
    expectOk('/api/v1/watches:preview', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ watch: { display_name: 'p', uri: 'https://huge.example.com/p' } }) }),
  );
  const hostileFirst = await h.fetch('/api/v1/watches:preview', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ watch: { display_name: 'p', uri: 'https://hostile.example.com/p' } }) });
  expect((await hostileFirst.json<{ fetch?: { body_bytes?: number } }>()).fetch?.body_bytes).toBeGreaterThan(FETCH_MAX_BYTES - 16 * 1024);
  const hostile = await both(HOSTILE_PREVIEW, () =>
    expectOk('/api/v1/watches:preview', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ watch: { display_name: 'p', uri: 'https://hostile.example.com/p' } }) }),
  );

  // The worst pass: every page just under FETCH_MAX_BYTES, as many as the byte budget allows (PAGES_PER_PASS).
  for (let n = 0; n < WATCHES_MAX; n++) h.sites.html(pageUrl(n), hugePage(n));
  clock = T0 + 16 * HOUR;
  const asked = h.sites.requests.length;
  const started = performance.now();
  const worst = summarize(ALARM_WORST, [await object.cpu(pass)]);
  const wallMs = performance.now() - started;
  console.log(`cpu WatchState alarm passes: first ${firstPass.first.toFixed(1)} ms, with changes ${changed.first.toFixed(1)} ms, the largest pages ${worst.first.toFixed(1)} ms (${(wallMs / 1000).toFixed(1)} s wall)`);
  console.log(`cpu alarm passes ${JSON.stringify(passes.map(({ outcomes, requests, left }) => ({ outcomes, requests, left })))}`);

  // Every check of the measured passes read its page (a failure, a timeout say, would hide that page's parse), and the
  // worst pass read all PAGES_PER_PASS pages, each a change, leaving the other due watches to the next alarm. A
  // failure names its code, and how often its page's request reached the fake site in the worst pass.
  const failed = await h.sql<{ id: string; last_failure: string }>('SELECT id, last_failure FROM watches WHERE last_failure IS NOT NULL ORDER BY id');
  const reached = (id: string) => h.sites.requests.slice(asked).filter(({ url }) => url === pageUrl(Number(id.slice('cpu-'.length)))).length;
  const named = failed.map(({ id, last_failure }) => `${id} ${last_failure} (its page requested ${String(reached(id))}x in the worst pass)`);
  const why = `failed checks: ${named.join(', ') || 'none'}; the worst pass took ${(wallMs / 1000).toFixed(1)} s`;
  const failures = passes.map(({ outcomes }) => (outcomes?.['failed'] ?? 0) + (outcomes?.['error'] ?? 0));
  expect({ failed, failures }, why).toEqual({ failed: [], failures: passes.map(() => 0) });
  const last = passes.at(-1);
  expect({ outcomes: last?.outcomes, left: last?.left }, why).toEqual({ outcomes: { changed: PAGES_PER_PASS }, left: WATCHES_MAX - PAGES_PER_PASS });
  return [cold, firstPass, changed, ...api, ...huge, ...hostile, worst];
}

describe('CPU (Workers Free: 10 ms per request, 30 s per Durable Object invocation)', () => {
  it('the fetch handler stays far below 10 ms and WatchState far below 30 s, on the alarm path too', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
    const { reference } = await measureInIsolates(COLD_ISOLATES, startIsolate, session);
    const get = (label: string): Measurement => {
      const measurement = reference.get(label);
      if (measurement === undefined) throw new Error(`not measured: ${label}`);
      return measurement;
    };
    console.log(
      `cpu bounds (reference ms): fetch handler first < ${WORKER_COLD_BOUND_MS.toFixed(2)} (its very first request: the median of ${String(COLD_ISOLATES)} isolates), ` +
        `median < ${WORKER_BOUND_MS.toFixed(2)}; WatchState API < ${OBJECT_API_BOUND_MS.toFixed(0)}, alarm pass and the largest preview < ${OBJECT_ALARM_BOUND_MS.toFixed(0)}`,
    );
    expect(get(COLD_LABEL).first, COLD_LABEL).toBeLessThan(WORKER_COLD_BOUND_MS);
    for (const { label, first, median } of reference.values()) {
      if (label.endsWith(`: ${HANDLER}`)) {
        expect(first, `${label}, first run`).toBeLessThan(WORKER_COLD_BOUND_MS);
        expect(median, `${label}, warm median`).toBeLessThan(WORKER_BOUND_MS);
      } else if (label.endsWith(`: ${OBJECT}`) && !label.startsWith(HUGE_PREVIEW) && !label.startsWith(HOSTILE_PREVIEW)) {
        expect(first, label).toBeLessThan(OBJECT_API_BOUND_MS);
      }
    }
    const hugeObject = get(`${HUGE_PREVIEW}: ${OBJECT}`).first;
    expect(hugeObject, 'the largest preview: WatchState').toBeLessThan(OBJECT_ALARM_BOUND_MS);
    // Hostile text costs about what plain text of the same size does (measured: about the largest page's), so an alarm's
    // 24 MiB of bodies stays seconds: never more than twice the plain page, and far below the alarm bound.
    expect(get(`${HOSTILE_PREVIEW}: ${OBJECT}`).first, 'the hostile preview: WatchState').toBeLessThan(Math.max(2 * hugeObject, 0.05 * FREE_OBJECT_CPU_MS));
    for (const label of [ALARM_FIRST, ALARM_CHANGED, ALARM_WORST]) expect(get(label).first, label).toBeLessThan(OBJECT_ALARM_BOUND_MS);
    // The cold request, 6 API calls and 2 previews in both isolates, 3 alarm passes.
    expect(reference.size).toBe(1 + 2 * 8 + 3);
  });
});
