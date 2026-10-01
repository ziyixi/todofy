/**
 * CPU per request inside workerd, against Workers Free's 10 ms (../../../docs/design.md §8), measured and calibrated by
 * the shared meter (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU profile of the Worker's isolate around each
 * request, and the machine's speed from a fixed workload run in the same isolate. The bounds are milliseconds of the
 * reference machine (an Apple M1 Max), multiplied by that speed (never below 1); a machine slower than MAX_SPEED fails.
 *
 * What matters most is the redirect, the request everyone makes: one D1 read and a 302, about a millisecond on a cold
 * isolate and a fraction of one warm, and with the owner's Access cookie one RS256 verification more (the keys cached
 * in the isolate). The owner API's heaviest requests run on the largest data the store allows (LINKS_MAX links, a full
 * page of LIST_PAGE or EXPORT_PAGE, an import of IMPORT_LINES_MAX lines). No dev bypass: Access is verified as in
 * production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectCpuMeter, FREE_CPU_MS, MAX_SPEED, scaleFor, tooSlow, type CpuMeter, type Measurement } from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { EXPORT_PAGE, IMPORT_LINES_MAX, LINKS_MAX, LIST_PAGE } from '../../src/limits.ts';
import { accessClaims, testIssuer } from '../jwt.ts';
import { op, startHarness, SYNTHETIC_BINDINGS, type Harness } from './harness.ts';

// A port range of its own (FlowDay's CPU test uses 9000-9499, Lab's 9500-9999).
const PORT = 10_000 + Math.floor(Math.random() * 500);
/**
 * A redirect, in reference milliseconds. Measured (2026-10-01, three runs): the isolate's very first request 1.25-1.56 ms,
 * every other first run 0.4-1.95 ms (1.95 with the owner's cookie: the first RS256 verification), warm medians 0-0.4 ms
 * (the sampler's resolution). So a redirect several times slower fails, long before Free's 10 ms.
 */
const REDIRECT_COLD_BOUND_MS = 0.3 * FREE_CPU_MS;
const REDIRECT_BOUND_MS = 0.15 * FREE_CPU_MS;
/**
 * The isolate's first owner API request (a one-link list page), in reference milliseconds: the first run of the
 * transcoder, the codec and the handlers' modules, measured on its own so that this one-off cost does not eat the
 * headroom of the heaviest request that happens to come first (a full list page measured 4.9-5.3 ms with it, and
 * 16.3 ms against a bound of 14.7 once on a loaded machine). Its own single measurement, so its bound keeps room for
 * that noise, still below Free's 10 ms on the reference machine.
 */
const API_INIT_BOUND_MS = 0.9 * FREE_CPU_MS;
/**
 * The owner API's heaviest requests, in reference milliseconds, each path's first run after the isolate's first API
 * request. Measured: see ../../../docs/design.md section 8.
 */
const API_COLD_BOUND_MS = 0.7 * FREE_CPU_MS;
const API_BOUND_MS = 0.5 * FREE_CPU_MS;
const RUNS = 11;
const ISSUER = SYNTHETIC_BINDINGS['ACCESS_ISSUER'] ?? '';
const AUDIENCE = SYNTHETIC_BINDINGS['ACCESS_AUDIENCE'] ?? '';

let h: Harness;
let meter: CpuMeter;
let token = '';

beforeAll(async () => {
  const issuer = await testIssuer();
  token = await issuer.sign(accessClaims(ISSUER, AUDIENCE, 'owner@example.com'));
  h = await startHarness({
    inspectorPort: PORT,
    bindings: { DEV_AUTH_BYPASS: 'false' },
    routes: new Map([[`${ISSUER}/cdn-cgi/access/certs`, () => Response.json(issuer.jwks)]]),
  });
  // LINKS_MAX links with every field near its largest: what the export and a full list page read.
  const now = Date.now();
  const rows = Array.from({ length: LINKS_MAX }, (_, n) => ({
    k: `key-${String(n).padStart(4, '0')}`,
    t: `https://example.com/a/fairly/long/path/to/some/document/${String(n)}?with=query&and=more#section`,
    v: n % 2 === 0 ? 'public' : 'private',
    d: `A synthetic description of link ${String(n)}, about as long as a real one gets in a launcher list.`,
    g: JSON.stringify(['tag-one', 'tag-two', `t${String(n % 7)}`]),
  }));
  await h.sql(
    `INSERT INTO links (key, target, path_mode, visibility, description, tags, expire_time, create_time, update_time, delete_time, purge_time, revision, revision_time, etag)
     SELECT j.value->>'k', j.value->>'t', 'append', j.value->>'v', j.value->>'d', j.value->>'g', NULL, ?, ?, NULL, NULL, 1, ?, 'etag' FROM json_each(?) AS j`,
    now,
    now,
    now,
    JSON.stringify(rows),
  );
  meter = await connectCpuMeter(PORT, 'links');
});

afterAll(async () => {
  meter.close();
  await h.dispose();
});

const owner = { 'cf-access-jwt-assertion': '' };

async function expectStatus(path: string, status: number, init: RequestInit = {}): Promise<void> {
  const response = await h.fetch(path, init);
  await response.text();
  if (response.status !== status) throw new Error(`${path}: ${String(response.status)}`);
}

describe('CPU per request (Workers Free: 10 ms)', () => {
  it('a redirect costs about a millisecond, and the heaviest owner requests stay well below the limit', async () => {
    owner['cf-access-jwt-assertion'] = token;
    const cookie = { cookie: `CF_Authorization=${token}` };
    // The isolate's very first request: an anonymous redirect of a public link.
    const cold = await meter.cpu(() => expectStatus('/key-0000/x', 302));
    console.log(`cpu GET /<key> as the isolate's first request: ${cold.toFixed(2)} ms`);

    const redirects: Measurement[] = [
      await meter.measure('GET /<public key>/<rest> (anonymous, APPEND)', () => expectStatus('/key-0002/a/b%20c', 302), RUNS),
      await meter.measure('GET /<private key> (anonymous: the continuation)', () => expectStatus('/key-0001', 302), RUNS),
      await meter.measure('GET /<unknown key> (anonymous)', () => expectStatus('/no-such-key', 302), RUNS),
      await meter.measure('GET /<private key> (the owner: Access cookie verified)', () => expectStatus('/key-0001', 302, { headers: cookie }), RUNS),
      await meter.measure('GET /<key>+ (preview)', () => expectStatus('/key-0002+', 200), RUNS),
    ];

    // The CSRF token for the import, outside the measurements.
    const csrf = await h.fetch('/_/api/csrf', { headers: owner });
    const csrfToken = (await csrf.json<{ token: string }>()).token;
    const csrfCookie = (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const lines = Array.from({ length: IMPORT_LINES_MAX }, (_, n) =>
      JSON.stringify({ name: `links/new-${String(n)}`, target: `https://example.org/${String(n)}`, description: 'Imported synthetic link', tags: ['imported'] }),
    ).join('\n');
    const importOnce = async () => {
      // Each run imports into an empty slice of keys: delete the previous run's links first (outside D1's limit).
      await h.sql("DELETE FROM links WHERE key LIKE 'new-%'");
      await h.sql("DELETE FROM link_revisions WHERE key LIKE 'new-%'");
    };
    // The isolate's first API request, alone: what every later API request no longer pays.
    const apiInit = await meter.cpu(() => expectStatus('/_/api/v1/links?page_size=1', 200, { headers: owner }));
    console.log(`cpu GET /_/api/v1/links?page_size=1 as the isolate's first API request: ${apiInit.toFixed(2)} ms`);
    const api: Measurement[] = [
      await meter.measure(`GET /_/api/v1/links (a full page of ${String(LIST_PAGE)})`, () => expectStatus('/_/api/v1/links', 200, { headers: owner }), RUNS),
      await meter.measure('GET /_/api/v1/links, filtered (2 literals over every link)', () => expectStatus(`/_/api/v1/links?filter=${encodeURIComponent('tag-two t3')}`, 200, { headers: owner }), RUNS),
      await meter.measure(`GET /_/api/v1/links:export (a full page of ${String(EXPORT_PAGE)})`, () => expectStatus('/_/api/v1/links:export', 200, { headers: owner }), RUNS),
      await meter.measure(`POST /_/api/v1/links:import (${String(IMPORT_LINES_MAX)} lines)`, async () => {
        await importOnce();
        await expectStatus('/_/api/v1/links:import', 200, {
          method: 'POST',
          headers: { ...owner, 'content-type': 'application/json', origin: `https://${SYNTHETIC_BINDINGS['PUBLIC_HOST'] ?? ''}`, 'x-csrf-token': csrfToken, cookie: csrfCookie },
          body: JSON.stringify({ content: lines, request_id: op() }),
        });
      }, RUNS),
    ];

    // Calibrated after the requests, so that each first run above is still the isolate's first run of its path.
    const calibration = await meter.calibrate();
    const scale = scaleFor(calibration.speed);
    console.log(
      `cpu bounds: redirect first < ${(REDIRECT_COLD_BOUND_MS * scale).toFixed(2)} ms, median < ${(REDIRECT_BOUND_MS * scale).toFixed(2)} ms; ` +
        `API's first request < ${(API_INIT_BOUND_MS * scale).toFixed(2)} ms, API first < ${(API_COLD_BOUND_MS * scale).toFixed(2)} ms, median < ${(API_BOUND_MS * scale).toFixed(2)} ms`,
    );
    expect(calibration.speed, tooSlow(calibration)).toBeLessThanOrEqual(MAX_SPEED);
    expect(cold, "GET /<key> as the isolate's first request").toBeLessThan(REDIRECT_COLD_BOUND_MS * scale);
    for (const { label, first, median } of redirects) {
      expect(first, `${label}: first run`).toBeLessThan(REDIRECT_COLD_BOUND_MS * scale);
      expect(median, `${label}: warm median`).toBeLessThan(REDIRECT_BOUND_MS * scale);
    }
    expect(apiInit, "GET /_/api/v1/links?page_size=1 as the isolate's first API request").toBeLessThan(API_INIT_BOUND_MS * scale);
    for (const { label, first, median } of api) {
      expect(first, `${label}: first run`).toBeLessThan(API_COLD_BOUND_MS * scale);
      expect(median, `${label}: warm median`).toBeLessThan(API_BOUND_MS * scale);
    }
  });
});
