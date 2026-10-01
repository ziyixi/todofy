/**
 * CPU of a Worker's requests inside workerd, calibrated to the machine running the test: the shared part of the
 * apps' CPU tests (lab/worker, flowday/worker, links/worker and dashboard/worker test/runtime/cpu.test.ts, Mail
 * Hero's test/cpu/native-ops-cpu.test.mjs) against Workers Free's 10 ms per request.
 *
 * Test tooling only. A test imports this file by relative path; no production source may (a bundle would carry it,
 * and a tools/ change deploys nothing: .github/scripts/ci_changes.py, test_ci_changes.py ToolsImports). It imports
 * nothing, so it type-checks under each app's own flags and runs under Node's type stripping
 * (node --test tools/workerd-cpu/test/*.test.mts, in the Changes job).
 *
 * Measuring. workerd's DevTools inspector (Miniflare's `inspectorPort`) records a sampled CPU profile of the Worker's
 * isolate around each request; the CPU time is the sum of the sampled intervals that are not idle (D1, Durable
 * Object storage, service bindings and outbound I/O run outside the isolate and are not counted, as on Cloudflare).
 * This is an estimate on the test machine, not Cloudflare's meter.
 *
 * Calibrating. A test's bounds are milliseconds of the reference machine (an Apple M1 Max), and the measured CPU
 * scales with the machine running the test: GitHub runners measured FlowDay's sync 1.1-2.1x the reference, varying
 * 2x within an hour. So the test calibrates the machine in the same isolate: a fixed, deterministic workload
 * (CALIBRATION_SETUP) runs in the Worker's own global scope through the inspector's Runtime.evaluate, with the
 * profiler running as for the requests. Its warm median wall time over CALIBRATION_REFERENCE_MS is the machine's
 * speed (CpuMeter.calibrate). The test multiplies its bounds by scaleFor(speed), never below 1, so a faster machine
 * never tightens a check against the Free limit, and fails when the speed is above MAX_SPEED: a broken calibration
 * or a machine too busy to measure must not hide a regression. Calibrate after the requests, so that each request's
 * first run is still the isolate's first run of that code path.
 */

/** Workers Free's CPU limit per request (the apps' docs/design.md). */
export const FREE_CPU_MS = 10;
/** The profiler's sampling interval. */
export const SAMPLE_US = 100;
/**
 * A sample's interval is capped at four sampling intervals: a single sample spanning several milliseconds is a gap in
 * which the sampler thread was not scheduled (the test machine runs vitest, Miniflare and workerd at once), not CPU.
 */
export const MAX_SAMPLE_US = 4 * SAMPLE_US;
/**
 * The slowest machine a test's bounds are scaled for: GitHub runners measure about 1.1-2.1, the reference machine with
 * all but one core busy up to 3.5.
 */
export const MAX_SPEED = 5;

/** The global the calibration workload is installed as, in the Worker's isolate of a CPU test only. */
const CALIBRATION_FN = '__cpuCalibration';
const CALIBRATION_ITEMS = 1000;
/** Passes per measured call: one pass is about 1.3 ms, too few 100 µs samples for a steady number. */
const CALIBRATION_PASSES = 4;
/**
 * Installs the calibration workload in the Worker's global scope. Setup, outside any measurement: a fixed synthetic
 * JSON answer of CALIBRATION_ITEMS records with every field of a Todoist API v1 item (about 590 KiB; the ids are a
 * fixed permutation, so the sort has work to do). Each call then makes CALIBRATION_PASSES passes of the work a
 * Worker request here does with an answer or a set of rows: parse it, drop some records, sort by id, map each record
 * to a row (a list serialised, a date cut to a day) and serialise the rows. No clock, randomness or I/O: the same
 * work on every machine, and the call returns CALIBRATION_CHARS. Any change to it changes its cost: measure
 * CALIBRATION_REFERENCE_MS again (the test file pins CALIBRATION_CHARS in Node).
 */
export const CALIBRATION_SETUP = `(() => {
  const items = [];
  for (let i = 0; i < ${String(CALIBRATION_ITEMS)}; i += 1) {
    items.push({
      id: 'cal-' + String((i * 7919) % ${String(CALIBRATION_ITEMS)}).padStart(5, '0'),
      user_id: '1', project_id: 'p-' + String(i % 8), section_id: i % 3 === 0 ? 's-' + String(i % 8) : null,
      parent_id: null, added_by_uid: '1', assigned_by_uid: null, responsible_uid: null,
      content: 'Calibration task ' + String(i) + ' with a realistic, somewhat longer title',
      description: i % 3 === 0 ? 'A synthetic description of moderate length, two sentences. Nothing real.' : '',
      priority: 1 + (i % 4), labels: i % 5 === 0 ? ['quick', 'home'] : [],
      due: i % 2 === 0 ? { date: '2026-04-13T09:30:00', timezone: null, string: 'every weekday', lang: 'en', is_recurring: false } : null,
      deadline: null, duration: i % 4 === 0 ? { amount: 30, unit: 'minute' } : null,
      child_order: i, day_order: -1, is_collapsed: false, note_count: 0, checked: i % 50 === 0, is_deleted: false,
      added_at: '2026-04-01T00:00:00.000000Z', updated_at: '2026-04-02T08:15:30.000000Z', completed_at: null,
    });
  }
  const projects = Array.from({ length: 8 }, (_, n) => ({ id: 'p-' + String(n), name: 'Project ' + String(n), color: 'blue', is_deleted: false, is_archived: false }));
  const text = JSON.stringify({ sync_token: 'calibration', full_sync: true, items, projects, user: {} });
  globalThis.${CALIBRATION_FN} = () => {
    let chars = 0;
    for (let pass = 0; pass < ${String(CALIBRATION_PASSES)}; pass += 1) {
      const answer = JSON.parse(text);
      const names = new Map(answer.projects.map((project) => [project.id, project.name]));
      const rows = answer.items
        .filter((item) => !item.checked && !item.is_deleted)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((item) => ({
          id: item.id, todoist_id: item.id, title: item.content, description: item.description === '' ? null : item.description,
          project_name: names.get(item.project_id) ?? null, priority: item.priority, labels: JSON.stringify(item.labels),
          estimated_mins: item.duration === null ? null : item.duration.amount,
          due_date: item.due === null ? null : item.due.date.slice(0, 10), created_at: item.added_at,
        }));
      chars += JSON.stringify(rows).length;
    }
    return chars;
  };
})()`;
/** The expression that runs the installed workload once. */
export const CALIBRATION_CALL = `${CALIBRATION_FN}()`;
/** What a call of the calibration returns: proof that it ran the whole workload. */
export const CALIBRATION_CHARS = CALIBRATION_PASSES * 293_004;
/**
 * The calibration's warm median wall time on the reference machine (an Apple M1 Max, workerd 1.20260926.1): the
 * median of 12 runs of FlowDay's CPU test, which measured 4.59-5.28 ms. Measure it again when the workload or a
 * workerd update changes its cost.
 */
export const CALIBRATION_REFERENCE_MS = 4.8;
const CALIBRATION_WARMUP = 3;
const CALIBRATION_RUNS = 10;

/** A DevTools CPU profile (Profiler.stop), the fields read here. */
export interface Profile {
  nodes: { id: number; callFrame: { functionName: string } }[];
  samples: number[];
  timeDeltas: number[];
}

/** CPU milliseconds of a profile: its samples that are not idle, each capped at MAX_SAMPLE_US; and per function. */
export function profileCpu(profile: Profile): { ms: number; byFunction: Map<string, number> } {
  const idle = new Set(profile.nodes.filter((node) => node.callFrame.functionName === '(idle)').map((node) => node.id));
  const names = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
  let micros = 0;
  const byFunction = new Map<string, number>();
  profile.samples.forEach((sample, index) => {
    if (idle.has(sample)) return;
    const delta = Math.min(profile.timeDeltas[index] ?? 0, MAX_SAMPLE_US);
    micros += delta;
    const name = names.get(sample) ?? '?';
    byFunction.set(name, (byFunction.get(name) ?? 0) + delta);
  });
  return { ms: micros / 1000, byFunction };
}

/** The median (the upper one of an even count); 0 for none. */
export function median(values: readonly number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
}

/** One request measured several times: its first run, then the warm median and best of the others. */
export interface Measurement {
  label: string;
  /** The isolate's first run of that code path (as on a cold isolate): a single, noisy number. */
  first: number;
  /** The warm runs' median. */
  median: number;
  /** The warm runs' best: it can read low, even 0, when the sampler thread was not scheduled. */
  best: number;
}

/** A Measurement from CPU samples in run order (the first is the cold run). */
export function summarize(label: string, samples: readonly number[]): Measurement {
  const [first = 0, ...warm] = samples;
  const sorted = [...warm].sort((a, b) => a - b);
  return { label, first, median: warm.length === 0 ? first : median(warm), best: sorted[0] ?? first };
}

/** The calibration: its warm medians (wall from Node, CPU from the profile) and the machine's speed. */
export interface Calibration {
  wall: number;
  cpu: number;
  /** The warm median wall over CALIBRATION_REFERENCE_MS: above 1, the machine is slower than the reference. */
  speed: number;
}

/** The factor a test multiplies its reference bounds by: the speed, never below 1. */
export function scaleFor(speed: number): number {
  return Math.max(1, speed);
}

/** The failure message for a speed above MAX_SPEED. */
export function tooSlow(calibration: Calibration): string {
  return (
    `the calibration measured this machine ${calibration.speed.toFixed(2)}x slower than the reference, beyond MAX_SPEED: ` +
    'too slow (or too busy) for CPU bounds to mean anything, or the calibration is broken'
  );
}

/** The CPU meter of one Worker's isolate, through workerd's inspector. */
export interface CpuMeter {
  /** CPU milliseconds of the isolate while `run` executes. */
  cpu(run: () => Promise<unknown>): Promise<number>;
  /**
   * Runs `run` `times` times and prints the first run, the warm median and the warm best. Noise on a busy machine
   * mostly raises these numbers; a sampler thread that is not scheduled loses samples and lowers them.
   */
  measure(label: string, run: () => Promise<unknown>, times?: number): Promise<Measurement>;
  /**
   * The machine's speed: the calibration's warm median (after CALIBRATION_WARMUP runs) over CALIBRATION_REFERENCE_MS.
   * Each run is timed from Node around Runtime.evaluate. On an idle machine that wall time matches the profile's CPU
   * within about 0.1 ms, but unlike the profile it cannot lose time: on a busy machine the sampler thread is not
   * always scheduled, and a calibration read from its own profile then sometimes lost most of its samples, clamping
   * the speed to 1 while a request's first run read high. The median, not the best: the best of ten finds a quiet
   * moment that a request's single first run and its few warm runs do not.
   */
  calibrate(): Promise<Calibration>;
  close(): void;
}

/** An inspector reply: Profiler.stop's profile or Runtime.evaluate's value. */
interface Reply {
  error?: { message: string };
  result?: { profile?: Profile; result?: { value?: unknown }; exceptionDetails?: unknown };
}

interface InspectorMessage {
  id?: number;
  method?: string;
  params?: { context?: { uniqueId?: string } };
}

/**
 * Connects to the isolate of the Worker named `worker` (Miniflare's `name`) on workerd's inspector at `port`, and
 * starts the profiler at SAMPLE_US.
 */
export async function connectCpuMeter(port: number, worker: string): Promise<CpuMeter> {
  const targets = (await (await fetch(`http://127.0.0.1:${String(port)}/json`)).json()) as { id: string; webSocketDebuggerUrl: string }[];
  const target = targets.find((candidate) => candidate.id === `core:user:${worker}`);
  if (target === undefined) throw new Error(`no inspector target for the Worker ${worker}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => {
    socket.addEventListener('open', resolve, { once: true });
  });
  let next = 0;
  let context: string | undefined;
  const pending = new Map<number, (reply: Reply) => void>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as InspectorMessage & Reply;
    if (message.id !== undefined) pending.get(message.id)?.(message);
    if (message.method === 'Runtime.executionContextCreated') context ??= message.params?.context?.uniqueId;
  });
  const send = (method: string, params: Record<string, unknown> = {}): Promise<Reply> =>
    new Promise((resolve) => {
      next += 1;
      pending.set(next, resolve);
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  // Runtime.enable announces the Worker's execution context before it answers. Runtime stays disabled during the
  // measurements, so the Worker's console lines are not also sent to this socket.
  await send('Runtime.enable');
  await send('Runtime.disable');
  if (context === undefined) throw new Error(`no execution context for the Worker ${worker}`);
  const workerContext = context;
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: SAMPLE_US });

  async function cpu(run: () => Promise<unknown>): Promise<number> {
    await send('Profiler.start');
    await run();
    const { result } = await send('Profiler.stop');
    if (result?.profile === undefined) throw new Error('no profile');
    const { ms, byFunction } = profileCpu(result.profile);
    // CPU_DEBUG=1: the top functions of each profile.
    if (process.env['CPU_DEBUG'] !== undefined) console.log(JSON.stringify([...byFunction.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)));
    return ms;
  }

  /** Evaluates `expression` in the Worker's global scope (its isolate) and returns the value. */
  async function evaluate(expression: string): Promise<unknown> {
    const reply = await send('Runtime.evaluate', { expression, uniqueContextId: workerContext, returnByValue: true });
    if (reply.error !== undefined) throw new Error(`Runtime.evaluate: ${reply.error.message}`);
    if (reply.result?.exceptionDetails !== undefined) throw new Error(`Runtime.evaluate: ${JSON.stringify(reply.result.exceptionDetails)}`);
    return reply.result?.result?.value;
  }

  return {
    cpu,
    async measure(label, run, times = 5) {
      const samples: number[] = [];
      for (let index = 0; index < times; index += 1) samples.push(await cpu(run));
      const measured = summarize(label, samples);
      console.log(
        `cpu ${label}: first ${measured.first.toFixed(2)} ms, warm median ${measured.median.toFixed(2)} ms, warm best ${measured.best.toFixed(2)} ms`,
      );
      return measured;
    },
    async calibrate() {
      await evaluate(CALIBRATION_SETUP);
      const cpus: number[] = [];
      const walls: number[] = [];
      for (let index = 0; index < CALIBRATION_WARMUP + CALIBRATION_RUNS; index += 1) {
        let wall = 0;
        const used = await cpu(async () => {
          const start = performance.now();
          const chars = await evaluate(CALIBRATION_CALL);
          wall = performance.now() - start;
          if (chars !== CALIBRATION_CHARS) throw new Error(`calibration returned ${String(chars)}, not ${String(CALIBRATION_CHARS)}`);
        });
        if (index < CALIBRATION_WARMUP) continue;
        cpus.push(used);
        walls.push(wall);
      }
      const calibration = { wall: median(walls), cpu: median(cpus), speed: median(walls) / CALIBRATION_REFERENCE_MS };
      console.log(
        `cpu calibration: warm median ${calibration.wall.toFixed(2)} ms wall, ${calibration.cpu.toFixed(2)} ms CPU ` +
          `(reference ${CALIBRATION_REFERENCE_MS.toFixed(2)} ms wall): speed ${calibration.speed.toFixed(2)}, bounds x${scaleFor(calibration.speed).toFixed(2)}`,
      );
      return calibration;
    },
    close() {
      socket.close();
    },
  };
}
