/**
 * CPU of the dashboard's cron tick inside workerd, measured and calibrated by the shared meter
 * (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU profile of the isolate of "home" around each tick, and the
 * machine's speed from a fixed workload run in the same isolate. The scheduled handler only calls HomeState.tick(),
 * so nearly all of a number is the object's invocation, which Workers Free limits to 30 s of CPU (a Durable Object
 * request), not the 10 ms of a Worker request. The stub apps run in isolates of their own and are not counted.
 *
 * A tick is the dashboard's heaviest invocation: it reads every app's status() (each answer read with ops-v1's rules:
 * the wire codec and the protobuf-es runtime), runs the probes, the guard, the canary and the digest. What the bounds
 * guard is the cost of ops-v1 on proto/, far below the object's limit. Measured on the reference machine (an Apple M1
 * Max) on 2026-10-01, three runs each: the isolate's first tick 6.2-7.3 ms before the move and 9.4-11.5 ms after (the
 * codec's code paths running for the first time: reading the rules from the descriptors, about 3 ms in Node); warm
 * medians 2.1 ms before and 1.9-2.5 ms after. The session runs in COLD_ISOLATES fresh isolates (a new harness each,
 * measureInIsolates): every number is divided by its own isolate's speed (never below 1), and the bounds hold each
 * number's median across the isolates, in milliseconds of that machine. A median speed above MAX_SPEED fails the test.
 */
import { describe, expect, it } from 'vitest';
import { COLD_ISOLATES, connectCpuMeter, CPU_TEST_TIMEOUT_MS, FREE_CPU_MS, measureInIsolates, type Isolate, type Measurement } from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { startHarness, type Harness } from './harness.ts';

/**
 * Regression budget for the DO's first tick, in reference milliseconds. Durable reminder identities,
 * the extra SQLite projection and their IDL descriptors raised the Linux CI cold median to 16.57 ms
 * (2026-10-04). Allow 20 ms for this documented work, rather than optimizing sub-ms runner differences.
 * This invocation belongs to HomeState's 30-second DO limit; it is not an HTTP-handler allowance.
 */
const COLD_BOUND_MS = 2 * FREE_CPU_MS;
/** The bound of a tick's warm median, in reference milliseconds (today at most 2.5). */
const WARM_BOUND_MS = 0.4 * FREE_CPU_MS;
const RUNS = 11;
const HALF_HOUR = 30 * 60_000;
/** src/state.ts's HOME_OBJECT (that module imports cloudflare:workers, which Node cannot load). */
const HOME_OBJECT = 'home-v1';
/** The canary's hour is 16 UTC (the harness's CANARY_UTC_HOUR): the warm ticks start it, follow it and send the digest. */
const T0 = Date.parse('2026-10-01T15:30:00Z');

const COLD_LABEL = "the isolate's first tick";
const WARM_LABEL = 'tick (statuses, probes, guard, canary, digest)';

/** A fresh isolate: a new harness with HomeState constructed, its meter connected. */
interface HomeIsolate extends Isolate {
  readonly h: Harness;
}

async function startIsolate(): Promise<HomeIsolate> {
  // Port 0: the OS picks a free port, which the meter reads back from Miniflare.
  const h = await startHarness({ inspectorPort: 0, bindings: { CANARY_ENABLED: 'true' } });
  try {
    // Cloudflare meters HomeState's invocations apart from the scheduled handler's; here they share the isolate. So
    // the object is constructed first (its schema set up), through an RPC method that runs none of the tick's code,
    // and the first tick below is the isolate's first run of the tick's code paths.
    const namespace = await h.mf.getDurableObjectNamespace('HOME', 'home');
    const home = namespace.get(namespace.idFromName(HOME_OBJECT)) as unknown as { lastRowsRead(): Promise<number> };
    expect(await home.lastRowsRead()).toBe(0);
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

/** One isolate's session: its first tick, then RUNS ticks half an hour apart (they start the canary). */
async function session({ h, meter }: HomeIsolate): Promise<Measurement[]> {
  const cold = await meter.measure(COLD_LABEL, () => h.scheduled(new Date(T0)), 1);
  let at = T0;
  const ticks = await meter.measure(
    WARM_LABEL,
    () => {
      at += HALF_HOUR;
      return h.scheduled(new Date(at));
    },
    RUNS,
  );
  // The canary ran: the warm ticks reached the stub apps' canary methods.
  const calls = await h.calls('mail-hero');
  expect(calls.map((call) => call.method)).toContain('startCanary');
  return [cold, ticks];
}


describe('workerd CPU of the cron tick', () => {
  it("stays within its bounds, the isolate's first tick too", { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
    const { reference } = await measureInIsolates(COLD_ISOLATES, startIsolate, session);
    console.log(`cpu bounds (reference ms, medians of ${String(COLD_ISOLATES)} isolates): first < ${COLD_BOUND_MS.toFixed(2)}, warm median < ${WARM_BOUND_MS.toFixed(2)}`);
    expect(reference.get(COLD_LABEL)?.first, COLD_LABEL).toBeLessThan(COLD_BOUND_MS);
    expect(reference.get(WARM_LABEL)?.median, 'a warm tick').toBeLessThan(WARM_BOUND_MS);
  });
});
