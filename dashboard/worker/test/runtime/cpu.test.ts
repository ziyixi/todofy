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
 * medians 2.1 ms before and 1.9-2.5 ms after. The bounds are milliseconds of that machine, multiplied by the measured
 * speed (never below 1); a machine slower than MAX_SPEED fails the test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectCpuMeter, FREE_CPU_MS, MAX_SPEED, scaleFor, tooSlow, type CpuMeter } from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { startHarness, type Harness } from './harness.ts';

// A port range of its own (FlowDay's CPU test uses 9000-9499, Lab's 9500-9999, Mail Hero's 10000-10499).
const PORT = 10_500 + Math.floor(Math.random() * 500);
/** The bound of the isolate's first tick, in reference milliseconds (today 9.4-11.5): about 1.5 times today's. */
const COLD_BOUND_MS = 1.6 * FREE_CPU_MS;
/** The bound of a tick's warm median, in reference milliseconds (today at most 2.5). */
const WARM_BOUND_MS = 0.4 * FREE_CPU_MS;
const RUNS = 11;
const HALF_HOUR = 30 * 60_000;
/** src/state.ts's HOME_OBJECT (that module imports cloudflare:workers, which Node cannot load). */
const HOME_OBJECT = 'home-v1';
/** The canary's hour is 16 UTC (the harness's CANARY_UTC_HOUR): the warm ticks start it, follow it and send the digest. */
const T0 = Date.parse('2026-10-01T15:30:00Z');

let h: Harness;
let meter: CpuMeter;

beforeAll(async () => {
  h = await startHarness({ inspectorPort: PORT, bindings: { CANARY_ENABLED: 'true' } });
  // Cloudflare meters HomeState's invocations apart from the scheduled handler's; here they share the isolate. So the
  // object is constructed first (its schema set up), through an RPC method that runs none of the tick's code, and the
  // first tick below is the isolate's first run of the tick's code paths.
  const namespace = await h.mf.getDurableObjectNamespace('HOME', 'home');
  const home = namespace.get(namespace.idFromName(HOME_OBJECT)) as unknown as { lastRowsRead(): Promise<number> };
  expect(await home.lastRowsRead()).toBe(0);
  meter = await connectCpuMeter(PORT, 'home');
});

afterAll(async () => {
  meter.close();
  await h.dispose();
});

describe('workerd CPU of the cron tick', () => {
  it("stays within its bounds, the isolate's first tick too", async () => {
    const cold = await meter.cpu(() => h.scheduled(new Date(T0)));
    console.log(`cpu the isolate's first tick: ${cold.toFixed(2)} ms`);
    let at = T0;
    const ticks = await meter.measure(
      'tick (statuses, probes, guard, canary, digest)',
      () => {
        at += HALF_HOUR;
        return h.scheduled(new Date(at));
      },
      RUNS,
    );
    // Calibrated after the ticks, so that the first one is still the isolate's first run of the tick's code paths.
    const calibration = await meter.calibrate();
    const coldBound = COLD_BOUND_MS * scaleFor(calibration.speed);
    const warmBound = WARM_BOUND_MS * scaleFor(calibration.speed);
    console.log(`cpu bounds: first < ${coldBound.toFixed(2)} ms, warm median < ${warmBound.toFixed(2)} ms`);
    expect(calibration.speed, tooSlow(calibration)).toBeLessThanOrEqual(MAX_SPEED);
    expect(cold, "the isolate's first tick").toBeLessThan(coldBound);
    expect(ticks.median, 'a warm tick').toBeLessThan(warmBound);
    // The canary ran: the warm ticks reached the stub apps' canary methods.
    const calls = await h.calls('mail-hero');
    expect(calls.map((call) => call.method)).toContain('startCanary');
  });
});
