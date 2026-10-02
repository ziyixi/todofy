/**
 * CPU of the owner API requests inside workerd, against Workers Free's 10 ms per Worker request, measured and
 * calibrated by the shared meter (tools/workerd-cpu/workerd-cpu.mts) like the tick in cpu.test.ts. HomeState runs in
 * the same isolate here, so a view's number includes the object's share (building and serializing the view), which
 * Cloudflare meters apart from the fetch handler (a Durable Object invocation, 30 s): an upper bound for the handler.
 *
 * The data is the largest a view sees on a bad day's scale: 16 days of canary runs (the 14 recent kept), 20 Workers
 * with requests today, every app's status and every probe. Requests go through the loopback dev bypass at DEV_NOW
 * (flows.ts), so every run reads the same pinned instant.
 */
import { describe, expect, it } from 'vitest';
import { COLD_ISOLATES, connectCpuMeter, CPU_TEST_TIMEOUT_MS, FREE_CPU_MS, measureInIsolates, type Isolate, type Measurement } from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { usageWithScripts } from '../graphql-fixture.ts';
import { answerProbes, NOW, PATHS, startFlows, type FlowHarness } from './flows.ts';

const COLD_LABEL = "GET ops as the isolate's first API request";
/** The bound of the isolate's first API request, in reference milliseconds. */
const COLD_BOUND_MS = 0.9 * FREE_CPU_MS;
/** The bound of every other request's first run, in reference milliseconds. */
const FIRST_BOUND_MS = 0.7 * FREE_CPU_MS;
/** The bound of a request's warm median, in reference milliseconds. */
const WARM_BOUND_MS = 0.4 * FREE_CPU_MS;
const RUNS = 11;
const MIN = 60_000;


interface HomeIsolate extends Isolate {
  readonly h: FlowHarness;
}

async function startIsolate(): Promise<HomeIsolate> {
  // Port 0: the OS picks a free port, which the meter reads back from Miniflare.
  const h = await startFlows({ usage: usageWithScripts(20), inspectorPort: 0 });
  try {
    answerProbes(h);
    const day = (offset: number): string => new Date(NOW - (16 - offset) * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 16; i++) {
      await h.tick(`${day(i)}T16:00:00Z`);
      await h.tick(`${day(i)}T16:30:00Z`);
    }
    await h.tick(NOW - MIN);
    const meter = await connectCpuMeter(h.mf, 'home');
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

async function get(h: FlowHarness, path: string, etag?: string): Promise<{ status: number; etag: string | null }> {
  const response = await h.fetch(path, etag === undefined ? {} : { headers: { 'if-none-match': etag } });
  await response.arrayBuffer();
  if (response.status !== 200 && response.status !== 304) throw new Error(`GET ${path}: ${String(response.status)}`);
  return { status: response.status, etag: response.headers.get('etag') };
}

async function session({ h, meter }: HomeIsolate): Promise<Measurement[]> {
  const cold = await meter.measure(COLD_LABEL, () => get(h, PATHS.ops), 1);
  const ops = await get(h, PATHS.ops);
  expect(ops.etag).not.toBeNull();
  const requests: Measurement[] = [
    cold,
    await meter.measure('GET registry', () => get(h, PATHS.registry), RUNS),
    await meter.measure('GET home', () => get(h, PATHS.home), RUNS),
    await meter.measure('GET flows', () => get(h, PATHS.flows), RUNS),
    await meter.measure('GET cloudflare', () => get(h, PATHS.cloudflare), RUNS),
    await meter.measure('GET ops', () => get(h, PATHS.ops), RUNS),
    await meter.measure('GET ops, If-None-Match (304)', () => get(h, PATHS.ops, ops.etag ?? ''), RUNS),
  ];
  // A guard override (CSRF and Origin checked, one RPC; the stubs answer setGuard). The harness fetched the CSRF
  // token once, before the first run.
  requests.push(
    await meter.measure(
      'POST guard',
      async () => {
        const response = await h.post(PATHS.guard, { level: 'normal' });
        await response.arrayBuffer();
        if (response.status !== 200) throw new Error(`POST guard: ${String(response.status)}`);
      },
      RUNS,
    ),
  );
  return requests;
}

describe('CPU per owner API request (Workers Free: 10 ms)', () => {
  it('the views, a conditional view and a guard override stay below their bounds', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
    const { reference } = await measureInIsolates(COLD_ISOLATES, startIsolate, session);
    console.log(
      `cpu bounds (reference ms, medians of ${String(COLD_ISOLATES)} isolates): the isolate's first API request < ${COLD_BOUND_MS.toFixed(2)}, ` +
        `other first runs < ${FIRST_BOUND_MS.toFixed(2)}, warm medians < ${WARM_BOUND_MS.toFixed(2)}`,
    );
    for (const { label, first, median } of reference.values()) {
      console.log(`${label}: first ${first.toFixed(2)}, median ${median.toFixed(2)}`);
      if (label === COLD_LABEL) {
        expect(first, label).toBeLessThan(COLD_BOUND_MS);
        continue;
      }
      expect(first, `${label}: first run`).toBeLessThan(FIRST_BOUND_MS);
      expect(median, `${label}: warm median`).toBeLessThan(WARM_BOUND_MS);
    }
  });
});
