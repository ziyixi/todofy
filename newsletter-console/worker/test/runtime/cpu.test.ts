/**
 * CPU per request inside workerd against Workers Free's 10 ms, measured and calibrated by the shared meter
 * (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU profile of the Worker's isolate around each request, and the
 * machine's speed from a fixed workload run in the same isolate. Bounds are milliseconds of the reference machine.
 *
 * Every API request costs the same few steps: one RS256 verification (the keys cached in the isolate after the first),
 * the transcoder's route and strict decode of the path and query, one fetch to Newsletter and its answer passed through
 * without being parsed (read into one buffer, checked to be UTF-8 and answered as those bytes, PreEncoded). So the
 * size and the script of the answer are what vary: CJK text, three bytes a character, costs the most to check.
 * Measured (2026-10-29), warm: up to about 1.5 ms per MiB of mostly CJK. When the check's text was also written again
 * as the answer it was up to about 3 ms per MiB (a 3.7 MiB answer took about 10.7 ms), which is why MAX_ANSWER_BYTES
 * is 2 MiB and not the 4 MiB first planned. Real answers are far smaller: an edition's rendering (its HTML with the
 * chart embedded) is a few hundred KiB.
 *
 * Measured: the overview, the read every page load makes; an edition of 256 KiB, mostly CJK, the size of a large real
 * one; and the worst answer the cap admits (2 MiB, its text CJK and an embedded image). The isolate's very first
 * request (the keys fetched and imported, the transcoder's first run) and the isolate's first answer at the cap (its
 * first buffers of that size) are measured in COLD_ISOLATES fresh isolates and bounded by the median.
 *
 * No dev bypass: Access is verified as in production.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  COLD_ISOLATES,
  connectCpuMeter,
  CPU_TEST_TIMEOUT_MS,
  FREE_CPU_MS,
  measureInIsolates,
  type Isolate,
  type Measurement,
} from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { MAX_ANSWER_BYTES } from '../../src/upstream.ts';
import { accessClaims, testIssuer } from '../jwt.ts';
import { AUDIENCE, ISSUER, startHarness, type Harness } from './harness.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'contracts', 'newsletter-ui-v1', 'fixtures');
const OVERVIEW = readFileSync(join(FIXTURES, 'overview.json'), 'utf8');
const EDITION = 'editions/00000000-0000-4000-8000-000000000027';
const encoded = (text: string): number => new TextEncoder().encode(text).byteLength;
/** A rendering of `bytes`: CJK text in its HTML and plain text, then a base64 image filling the rest. */
function rendering(bytes: number, cjkCharacters: number): string {
  const prose = '合成正文。'.repeat(cjkCharacters / 5);
  const base = JSON.stringify({ name: `${EDITION}/rendering`, html: `<!doctype html><p>${prose}</p><img src="data:image/png;base64,">`, text: prose });
  return JSON.stringify({
    name: `${EDITION}/rendering`,
    html: `<!doctype html><p>${prose}</p><img src="data:image/png;base64,${'A'.repeat(bytes - encoded(base))}">`,
    text: prose,
  });
}
const LARGE = rendering(256 * 1024, 40_000);
const WORST = rendering(MAX_ANSWER_BYTES, 120_000);
/**
 * The isolate's first request, in reference milliseconds: the Access keys fetched and imported, then a verification
 * and the transcoder's first run (measured 3.8-4.5).
 */
const COLD_BOUND_MS = 0.6 * FREE_CPU_MS;
/** A read of a real size, its first run and warm (measured 1.0-1.2 ms for the overview, 1.3-1.6 for 256 KiB of CJK). */
const READ_BOUND_MS = 0.3 * FREE_CPU_MS;
/**
 * The worst answer the cap admits (measured 4.2-4.5 first, single isolates 3.6-5.5, and 3.3-3.5 warm). The bound
 * keeps it under Free's limit with room for runners; it is not a regression margin, so a few ms more at the cap alone
 * can pass. Written again as text it read 6.3-7.2 first and 5.5-6.0 warm, and GitHub runners read its first run
 * 7.3-10.1 (one isolate each).
 */
const WORST_BOUND_MS = 0.9 * FREE_CPU_MS;
const RUNS = 9;
const COLD = "GET overview as the isolate's first request";
const READS = ['GET overview', 'GET an edition of 256 KiB, mostly CJK'];
const WORST_LABEL = `GET a rendering of ${String(MAX_ANSWER_BYTES / 1024 / 1024)} MiB, the cap, its text CJK`;

let token = '';
let jwks: unknown;

beforeAll(async () => {
  const issuer = await testIssuer();
  token = await issuer.sign(accessClaims(ISSUER, AUDIENCE, 'owner@example.com'));
  jwks = issuer.jwks;
});

interface ConsoleIsolate extends Isolate {
  readonly h: Harness;
}

async function startIsolate(): Promise<ConsoleIsolate> {
  const h = await startHarness(jwks, {
    inspectorPort: 0,
    newsletter: (request) => new Response(request.url.endsWith('/rendering') ? WORST : request.url.includes('/editions/') ? LARGE : OVERVIEW, {
      headers: { 'content-type': 'application/json' },
    }),
  });
  try {
    const meter = await connectCpuMeter(h.mf, 'newsletter-console');
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

async function session({ h, meter }: ConsoleIsolate, index: number): Promise<Measurement[]> {
  const headers = { 'cf-access-jwt-assertion': token };
  async function read(path: string, expected: string): Promise<void> {
    const response = await h.fetch(path, { headers });
    const body = await response.text();
    if (response.status !== 200 || body !== expected) throw new Error(`${path}: ${String(response.status)}`);
  }
  const cold = await meter.measure(COLD, () => read('/api/v1/overview', OVERVIEW), 1);
  // The cap's first run is one number per isolate too (its first 2 MiB answer), so every isolate measures it.
  const worst = await meter.measure(WORST_LABEL, () => read(`/api/v1/${EDITION}/rendering`, WORST), RUNS);
  if (index !== COLD_ISOLATES - 1) return [cold, worst];
  return [
    cold,
    worst,
    await meter.measure(READS[0] ?? '', () => read('/api/v1/overview', OVERVIEW), RUNS),
    await meter.measure(READS[1] ?? '', () => read(`/api/v1/${EDITION}`, LARGE), RUNS),
  ];
}

describe('CPU (Workers Free: 10 ms per request)', () => {
  it('stays far below 10 ms on the first request and on real answers, and below it at the cap', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
    expect([encoded(LARGE), encoded(WORST)]).toEqual([256 * 1024, MAX_ANSWER_BYTES]);
    const { reference } = await measureInIsolates(COLD_ISOLATES, startIsolate, session);
    const get = (label: string): Measurement => {
      const measurement = reference.get(label);
      if (measurement === undefined) throw new Error(`not measured: ${label}`);
      return measurement;
    };
    console.log(`cpu bounds (reference ms): first request < ${COLD_BOUND_MS.toFixed(1)}, reads < ${READ_BOUND_MS.toFixed(1)}, at the cap < ${WORST_BOUND_MS.toFixed(1)}`);
    expect(get(COLD).first, COLD).toBeLessThan(COLD_BOUND_MS);
    for (const label of READS) {
      expect(get(label).first, `${label}, first run`).toBeLessThan(READ_BOUND_MS);
      expect(get(label).median, `${label}, warm median`).toBeLessThan(READ_BOUND_MS);
    }
    expect(get(WORST_LABEL).first, WORST_LABEL).toBeLessThan(WORST_BOUND_MS);
    expect(get(WORST_LABEL).median, WORST_LABEL).toBeLessThan(WORST_BOUND_MS);
    expect(reference.size).toBe(4);
  });
});
