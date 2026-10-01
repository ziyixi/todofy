/**
 * CPU inside workerd against Workers Free (../../../docs/design.md §8), measured and calibrated by the shared meter
 * (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU profile of an isolate around each request, and the machine's speed
 * from a fixed workload run in the same isolate. Bounds are milliseconds of the reference machine (an Apple M1 Max)
 * multiplied by that speed (never below 1); a machine slower than MAX_SPEED fails.
 *
 * WatchState runs in a Worker of its own here (HarnessOptions.splitObject), as on Cloudflare, so the two limits are
 * measured apart:
 *
 * - the fetch handler (10 ms per request): Access (an RS256 verification, the keys cached), CSRF, one call to the object
 *   and the answer passed through, for the heaviest answers the API has (a full list of WATCHES_MAX watches, a full page
 *   of CHANGE_PAGE changes with DIFF_LINES_KEPT lines of DIFF_LINE_MAX characters each, a 2 MiB page's preview);
 * - WatchState (30 s per invocation): those API calls, and the alarm path: a pass over every watch with a large page
 *   (the first notified states, then a change on every page), and the preview of a page of FETCH_MAX_BYTES.
 *
 * No dev bypass: Access is verified as in production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectCpuMeter, FREE_CPU_MS, MAX_SPEED, scaleFor, tooSlow, type CpuMeter, type Measurement } from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { CHANGE_PAGE, DIFF_LINE_MAX, DIFF_LINES_KEPT, FETCH_MAX_BYTES, WATCH_PAGE, WATCHES_MAX } from '../../src/limits.ts';
import { accessClaims, testIssuer } from '../jwt.ts';
import { HOUR, OBJECT_WORKER, op, PUBLIC_HOST, startHarness, SYNTHETIC_BINDINGS, T0, type Harness } from './harness.ts';

// A port range of its own (FlowDay's CPU test uses 9000-9499, Lab's 9500-9999, the links app's 10000-10499).
const PORT = 10_500 + Math.floor(Math.random() * 500);
/** Workers Free's CPU per Durable Object invocation (an alarm, a request). */
const FREE_OBJECT_CPU_MS = 30_000;
/**
 * The fetch handler, in reference milliseconds. It verifies a JWT and a CSRF token and passes the object's answer on:
 * measured (2026-10-01) about 1 ms on its isolate's first request and 0.1-0.6 ms warm, whatever the answer's size.
 */
const WORKER_COLD_BOUND_MS = 0.4 * FREE_CPU_MS;
const WORKER_BOUND_MS = 0.2 * FREE_CPU_MS;
/**
 * WatchState, in reference milliseconds (measured: ../../../docs/design.md §8): its heaviest API calls (a full page of
 * changes about 25 ms), and an alarm pass or the largest preview (a pass over pages of 2 MiB is the most: seconds, not
 * the 30 s of the limit).
 */
const OBJECT_API_BOUND_MS = 0.01 * FREE_OBJECT_CPU_MS;
const OBJECT_ALARM_BOUND_MS = 0.25 * FREE_OBJECT_CPU_MS;
const RUNS = 7;
const ISSUER = SYNTHETIC_BINDINGS['ACCESS_ISSUER'] ?? '';
const AUDIENCE = SYNTHETIC_BINDINGS['ACCESS_AUDIENCE'] ?? '';

let h: Harness;
let worker: CpuMeter;
let object: CpuMeter;
let headers: Record<string, string> = {};
/** The fetch handler's very first request (Access keys fetched, the RS256 key imported, the CSRF key derived). */
let coldWorker = 0;
let mutationHeaders: Record<string, string> = {};

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

function setPages(variant: number): void {
  for (let n = 0; n < WATCHES_MAX; n++) h.sites.html(`https://cpu${String(n)}.example.com/p`, bigPage(n, 200, variant));
}

beforeAll(async () => {
  const issuer = await testIssuer();
  const token = await issuer.sign(accessClaims(ISSUER, AUDIENCE, 'owner@example.com'));
  h = await startHarness({
    inspectorPort: PORT,
    splitObject: true,
    // Production's fetch timeout: a 2 MiB page under the profiler takes longer than the suite's short one.
    bindings: { DEV_AUTH_BYPASS: 'false', DEV_FETCH_TIMEOUT_MS: '15000' },
    routes: new Map([[`${ISSUER}/cdn-cgi/access/certs`, () => Response.json(issuer.jwks)]]),
  });
  headers = { 'cf-access-jwt-assertion': token };
  worker = await connectCpuMeter(PORT, 'watch');
  object = await connectCpuMeter(PORT, OBJECT_WORKER);
  let csrf = new Response();
  coldWorker = await worker.cpu(async () => {
    csrf = await h.fetch('/api/csrf', { headers });
  });
  const csrfToken = (await csrf.json<{ token: string }>()).token;
  mutationHeaders = { ...headers, 'content-type': 'application/json', origin: `https://${PUBLIC_HOST}`, 'x-csrf-token': csrfToken, cookie: (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
  setPages(0);
  h.sites.html('https://huge.example.com/p', hugePage(-1));
  for (let n = 0; n < WATCHES_MAX; n++) {
    const response = await h.fetch(`/api/v1/watches?watch_id=cpu-${String(n)}&request_id=${op()}`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ display_name: `Synthetic page ${String(n)}`, uri: `https://cpu${String(n)}.example.com/p`, stability: { skip_confirmation: n % 2 === 0 } }),
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
});

afterAll(async () => {
  worker.close();
  object.close();
  await h.dispose();
});

async function expectOk(path: string, init: RequestInit = {}): Promise<void> {
  const response = await h.fetch(path, { headers, ...init });
  await response.arrayBuffer();
  if (response.status !== 200) throw new Error(`${path}: ${String(response.status)}`);
}

/** A request measured in both isolates at once. */
async function both(label: string, run: () => Promise<void>): Promise<{ worker: Measurement; object: Measurement }> {
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
  const summarize = (samples: number[]): Measurement => {
    const [first = 0, ...warm] = samples;
    const sorted = [...warm].sort((a, b) => a - b);
    return { label, first, median: sorted[Math.floor(sorted.length / 2)] ?? first, best: sorted[0] ?? first };
  };
  const result = { worker: summarize(workerSamples), object: summarize(objectSamples) };
  console.log(`cpu ${label}: fetch handler first ${result.worker.first.toFixed(2)} ms, median ${result.worker.median.toFixed(2)} ms; WatchState first ${result.object.first.toFixed(2)} ms, median ${result.object.median.toFixed(2)} ms`);
  return result;
}

describe('CPU (Workers Free: 10 ms per request, 30 s per Durable Object invocation)', () => {
  it('the fetch handler stays far below 10 ms and WatchState far below 30 s, on the alarm path too', async () => {
    console.log(`cpu GET /api/csrf as the fetch handler's very first request: ${coldWorker.toFixed(2)} ms`);

    // The alarm path: the first pass sets the notified states (50 pages of 200 KiB, as far as the budget goes).
    const alarms: Measurement[] = [];
    let clock = T0;
    const outcomes: unknown[] = [];
    const pass = async () => {
      outcomes.push((await h.step(clock)).outcomes);
    };
    const firstPass = await object.cpu(pass);
    alarms.push({ label: 'alarm pass: first notified states', first: firstPass, median: firstPass, best: firstPass });
    clock += 1000;
    for (let i = 0; i < 6; i++) {
      await h.step(clock);
      clock += 1000;
    }
    // A change on every page: diffs, pending and confirmed changes, snapshots.
    setPages(1);
    clock = T0 + 8 * HOUR;
    const changed = await object.cpu(pass);
    alarms.push({ label: 'alarm pass: a change on every page', first: changed, median: changed, best: changed });

    const api = [
      await both(`GET watches (${String(WATCH_PAGE)})`, () => expectOk('/api/v1/watches')),
      await both(`GET changes (${String(CHANGE_PAGE)} with ${String(DIFF_LINES_KEPT)} diff lines each)`, () => expectOk('/api/v1/watches/-/changes')),
      await both('GET changes, the inbox filter', () => expectOk(`/api/v1/watches/-/changes?filter=${encodeURIComponent('state = NEW')}`)),
      await both('GET serviceStatus', () => expectOk('/api/v1/serviceStatus')),
      await both('PATCH a watch (mask)', () =>
        expectOk(`/api/v1/watches/cpu-1?update_mask=display_name&request_id=${op()}`, { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ display_name: 'Renamed' }) }),
      ),
      await both('POST watches:preview (a 200 KiB page, cached)', () =>
        expectOk('/api/v1/watches:preview', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ watch: { display_name: 'p', uri: 'https://cpu3.example.com/p' } }) }),
      ),
    ];
    const largest = await h.fetch('/api/v1/watches:preview', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ watch: { display_name: 'p', uri: 'https://huge.example.com/p' } }) });
    expect((await largest.json<{ fetch?: { body_bytes?: number } }>()).fetch?.body_bytes).toBeGreaterThan(FETCH_MAX_BYTES - 1024);
    const huge = await both(`POST watches:preview (a page of ${String(FETCH_MAX_BYTES / 1024 / 1024)} MiB, cached)`, () =>
      expectOk('/api/v1/watches:preview', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ watch: { display_name: 'p', uri: 'https://huge.example.com/p' } }) }),
    );

    // The worst pass: every page just under FETCH_MAX_BYTES, as many as the request budget allows.
    for (let n = 0; n < WATCHES_MAX; n++) h.sites.html(`https://cpu${String(n)}.example.com/p`, hugePage(n));
    clock = T0 + 16 * HOUR;
    const worst = await object.cpu(pass);
    alarms.push({ label: `alarm pass: pages of ${String(FETCH_MAX_BYTES / 1024 / 1024)} MiB`, first: worst, median: worst, best: worst });
    console.log(`cpu WatchState alarm passes: first ${firstPass.toFixed(1)} ms, with changes ${changed.toFixed(1)} ms, the largest pages ${worst.toFixed(1)} ms`);
    console.log(`cpu alarm outcomes ${JSON.stringify(outcomes)}`);
    // Every page was read: no check of the largest pages failed (a timeout would hide their cost).
    expect(await h.sql('SELECT id FROM watches WHERE last_failure IS NOT NULL')).toEqual([]);

    // Calibrated after the requests, so that each first run above is still the isolate's first run of its path.
    const calibration = await worker.calibrate();
    const scale = scaleFor(calibration.speed);
    console.log(
      `cpu bounds: fetch handler first < ${(WORKER_COLD_BOUND_MS * scale).toFixed(2)} ms, median < ${(WORKER_BOUND_MS * scale).toFixed(2)} ms; ` +
        `WatchState API < ${(OBJECT_API_BOUND_MS * scale).toFixed(0)} ms, alarm pass and the largest preview < ${(OBJECT_ALARM_BOUND_MS * scale).toFixed(0)} ms`,
    );
    expect(calibration.speed, tooSlow(calibration)).toBeLessThanOrEqual(MAX_SPEED);
    expect(coldWorker, "the fetch handler's very first request").toBeLessThan(WORKER_COLD_BOUND_MS * scale);
    for (const measured of [...api, huge]) {
      expect(measured.worker.first, `${measured.worker.label}: fetch handler, first run`).toBeLessThan(WORKER_COLD_BOUND_MS * scale);
      expect(measured.worker.median, `${measured.worker.label}: fetch handler, warm median`).toBeLessThan(WORKER_BOUND_MS * scale);
    }
    for (const measured of api) expect(measured.object.first, `${measured.object.label}: WatchState`).toBeLessThan(OBJECT_API_BOUND_MS * scale);
    expect(huge.object.first, 'the largest preview: WatchState').toBeLessThan(OBJECT_ALARM_BOUND_MS * scale);
    for (const measured of alarms) expect(measured.first, measured.label).toBeLessThan(OBJECT_ALARM_BOUND_MS * scale);
  });
});
