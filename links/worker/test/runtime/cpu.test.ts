/**
 * CPU per request inside workerd, against Workers Free's 10 ms (../../../docs/design.md §8), measured and calibrated by
 * the shared meter (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU profile of the Worker's isolate around each
 * request, and the machine's speed from a fixed workload run in the same isolate. The bounds are milliseconds of the
 * reference machine (an Apple M1 Max).
 *
 * What matters most is the redirect, the request everyone makes: one D1 read and a 302, about a millisecond on a cold
 * isolate and a fraction of one warm, and with the owner's Access cookie one RS256 verification more (the keys cached
 * in the isolate). The owner API's heaviest requests run on the largest data the store allows (LINKS_MAX links, a full
 * page of LIST_PAGE or EXPORT_PAGE, an import of IMPORT_LINES_MAX lines). No dev bypass: Access is verified as in
 * production.
 *
 * The whole session runs in COLD_ISOLATES fresh isolates (a new harness each, measureInIsolates): every number is
 * divided by its own isolate's speed (never below 1), and the bounds hold each number's median across the isolates,
 * so one first run on a busy moment cannot fail the test alone. A median speed above MAX_SPEED fails it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { COLD_ISOLATES, connectCpuMeter, CPU_TEST_TIMEOUT_MS, FREE_CPU_MS, measureInIsolates, type Isolate, type Measurement } from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { EXPORT_PAGE, IMPORT_LINES_MAX, LINKS_MAX, LIST_PAGE } from '../../src/limits.ts';
import { accessClaims, testIssuer } from '../jwt.ts';
import { op, startHarness, SYNTHETIC_BINDINGS, type Harness } from './harness.ts';

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
 * 16.3 ms against a bound of 14.7 once on a loaded machine). Its bound keeps room for that one-off cost's noise
 * (3.8-4.8 ms per isolate on the reference machine, 3.2-4.3 on GitHub runners), still below Free's 10 ms.
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

const REDIRECT_COLD = "GET /<key> as the isolate's first request";
const API_INIT = "GET /_/api/v1/links?page_size=1 as the isolate's first API request";

let token = '';
const owner = { 'cf-access-jwt-assertion': '' };
let issuerJwks: unknown;

beforeAll(async () => {
  const issuer = await testIssuer();
  token = await issuer.sign(accessClaims(ISSUER, AUDIENCE, 'owner@example.com'));
  owner['cf-access-jwt-assertion'] = token;
  issuerJwks = issuer.jwks;
});

/** A fresh isolate: a new harness with LINKS_MAX links, its meter connected. */
interface LinksIsolate extends Isolate {
  readonly h: Harness;
}

async function startIsolate(): Promise<LinksIsolate> {
  // Port 0: the OS picks a free port, which the meter reads back from Miniflare.
  const h = await startHarness({
    inspectorPort: 0,
    bindings: { DEV_AUTH_BYPASS: 'false' },
    routes: new Map([[`${ISSUER}/cdn-cgi/access/certs`, () => Response.json(issuerJwks)]]),
  });
  try {
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
    const meter = await connectCpuMeter(h.mf, 'links');
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

async function expectStatus(h: Harness, path: string, status: number, init: RequestInit = {}): Promise<void> {
  const response = await h.fetch(path, init);
  await response.text();
  if (response.status !== status) throw new Error(`${path}: ${String(response.status)}`);
}

/** One isolate's session: its very first request, the redirects, its first API request, the heaviest API requests. */
async function session({ h, meter }: LinksIsolate): Promise<Measurement[]> {
  const cookie = { cookie: `CF_Authorization=${token}` };
  // The isolate's very first request: an anonymous redirect of a public link.
  const cold = await meter.measure(REDIRECT_COLD, () => expectStatus(h, '/key-0000/x', 302), 1);
  const redirects: Measurement[] = [
    await meter.measure('GET /<public key>/<rest> (anonymous, APPEND)', () => expectStatus(h, '/key-0002/a/b%20c', 302), RUNS),
    await meter.measure('GET /<private key> (anonymous: the continuation)', () => expectStatus(h, '/key-0001', 302), RUNS),
    await meter.measure('GET /<unknown key> (anonymous)', () => expectStatus(h, '/no-such-key', 302), RUNS),
    await meter.measure('GET /<private key> (the owner: Access cookie verified)', () => expectStatus(h, '/key-0001', 302, { headers: cookie }), RUNS),
    await meter.measure('GET /<key>+ (preview)', () => expectStatus(h, '/key-0002+', 200), RUNS),
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
  const apiInit = await meter.measure(API_INIT, () => expectStatus(h, '/_/api/v1/links?page_size=1', 200, { headers: owner }), 1);
  const api: Measurement[] = [
    await meter.measure(`GET /_/api/v1/links (a full page of ${String(LIST_PAGE)})`, () => expectStatus(h, '/_/api/v1/links', 200, { headers: owner }), RUNS),
    await meter.measure('GET /_/api/v1/links, filtered (2 literals over every link)', () => expectStatus(h, `/_/api/v1/links?filter=${encodeURIComponent('tag-two t3')}`, 200, { headers: owner }), RUNS),
    await meter.measure(`GET /_/api/v1/links:export (a full page of ${String(EXPORT_PAGE)})`, () => expectStatus(h, '/_/api/v1/links:export', 200, { headers: owner }), RUNS),
    await meter.measure(`POST /_/api/v1/links:import (${String(IMPORT_LINES_MAX)} lines)`, async () => {
      await importOnce();
      await expectStatus(h, '/_/api/v1/links:import', 200, {
        method: 'POST',
        headers: { ...owner, 'content-type': 'application/json', origin: `https://${SYNTHETIC_BINDINGS['PUBLIC_HOST'] ?? ''}`, 'x-csrf-token': csrfToken, cookie: csrfCookie },
        body: JSON.stringify({ content: lines, request_id: op() }),
      });
    }, RUNS),
  ];
  return [cold, ...redirects, apiInit, ...api];
}

/** The redirects measured after the isolate's first request (each is bounded by the redirect bounds). */
const REDIRECTS = new Set([
  'GET /<public key>/<rest> (anonymous, APPEND)',
  'GET /<private key> (anonymous: the continuation)',
  'GET /<unknown key> (anonymous)',
  'GET /<private key> (the owner: Access cookie verified)',
  'GET /<key>+ (preview)',
]);


describe('CPU per request (Workers Free: 10 ms)', () => {
  it('a redirect costs about a millisecond, and the heaviest owner requests stay well below the limit', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
    const { reference } = await measureInIsolates(COLD_ISOLATES, startIsolate, session);
    console.log(
      `cpu bounds (reference ms, medians of ${String(COLD_ISOLATES)} isolates): redirect first < ${REDIRECT_COLD_BOUND_MS.toFixed(2)}, ` +
        `median < ${REDIRECT_BOUND_MS.toFixed(2)}; API's first request < ${API_INIT_BOUND_MS.toFixed(2)}, API first < ${API_COLD_BOUND_MS.toFixed(2)}, ` +
        `median < ${API_BOUND_MS.toFixed(2)}`,
    );
    for (const { label, first, median } of reference.values()) {
      if (label === REDIRECT_COLD) expect(first, label).toBeLessThan(REDIRECT_COLD_BOUND_MS);
      else if (label === API_INIT) expect(first, label).toBeLessThan(API_INIT_BOUND_MS);
      else if (REDIRECTS.has(label)) {
        expect(first, `${label}: first run`).toBeLessThan(REDIRECT_COLD_BOUND_MS);
        expect(median, `${label}: warm median`).toBeLessThan(REDIRECT_BOUND_MS);
      } else {
        expect(first, `${label}: first run`).toBeLessThan(API_COLD_BOUND_MS);
        expect(median, `${label}: warm median`).toBeLessThan(API_BOUND_MS);
      }
    }
    expect(reference.size).toBe(2 + REDIRECTS.size + 4);
  });
});
