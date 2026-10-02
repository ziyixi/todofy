/**
 * CPU of a Worker's requests inside workerd, calibrated to the machine running the test: the shared part of the
 * apps' CPU tests (lab/worker, flowday/worker, links/worker, dashboard/worker and watch/worker
 * test/runtime/cpu.test.ts, Mail Hero's test/cpu/native-ops-cpu.test.mjs) against Workers Free's 10 ms per request.
 *
 * Test tooling only. A test imports this file by relative path; no production source may (a bundle would carry it,
 * and a tools/ change deploys nothing: .github/scripts/ci_changes.py, test_ci_changes.py ToolsImports). It imports
 * nothing, so it type-checks under each app's own flags and runs under Node's type stripping
 * (node --test tools/workerd-cpu/test/*.test.mts, in the Changes job).
 *
 * Measuring. workerd's DevTools inspector (Miniflare's `inspectorPort`; 0 lets the OS pick a free port, which
 * connectCpuMeter reads back from Miniflare) records a sampled CPU profile of the Worker's isolate around each
 * request; the CPU time is the sum of the sampled intervals that are not idle (D1, Durable Object storage, service
 * bindings and outbound I/O run outside the isolate and are not counted, as on Cloudflare). This is an estimate on the
 * test machine, not Cloudflare's meter. Every inspector call fails after INSPECTOR_TIMEOUT_MS, naming the call, rather
 * than waiting for the test runner's timeout.
 *
 * Calibrating. A test's bounds are milliseconds of the reference machine (an Apple M1 Max), and the measured CPU
 * scales with the machine running the test: GitHub runners measured FlowDay's sync 1.1-2.1x the reference, varying
 * 2x within an hour. So the test calibrates the machine in the same isolate: a fixed, deterministic workload
 * (CALIBRATION_SETUP) runs in the Worker's own global scope through the inspector's Runtime.evaluate, with the
 * profiler running as for the requests. Its warm median wall time over CALIBRATION_REFERENCE_MS is the machine's
 * speed (CpuMeter.calibrate). A number divided by scaleFor(speed), never below 1, is in reference milliseconds, so a
 * faster machine never tightens a check against the Free limit; a speed above MAX_SPEED fails the test: a broken
 * calibration or a machine too busy to measure must not hide a regression. Calibrate after the requests, so that each
 * request's first run is still the isolate's first run of that code path.
 *
 * Cold runs. An isolate's first run of a code path (lazy compilation, the first feedback of each call site, the heap's
 * first growth) is one number per isolate, and it was the number that failed on GitHub runners: Lab's first API
 * request, one isolate's one run, read 5.7-7.2 reference ms on runners against its bound of 7 (README.md). So a test
 * measures its whole session in COLD_ISOLATES fresh isolates, one after another (measureInIsolates): each isolate
 * calibrates itself, its numbers are divided by its own scale, and the bounds hold each number's median across the
 * isolates. A first run that lands on a busy moment cannot fail the test alone; a regression is in every isolate and
 * moves the median. An isolate whose calibration itself landed on a busy moment (MAX_WALL_OVER_CPU) is measured again,
 * so that it cannot hide a regression by dividing it away. Runners still read cold runs up to about 1.3 times the
 * reference machine once scaled (warm runs match): each app's bounds keep that headroom. Rejected, with the data in
 * README.md: a bound on the ratio to the same request's warm median, and a calibration by the workload's own first run
 * or by freshly compiled code.
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
 * all but one core busy up to 4.4.
 */
export const MAX_SPEED = 5;
/**
 * The fresh isolates a test measures its session in (measureInIsolates). With three, one isolate's outlier, high or
 * low, never decides a bound: the median is always one of two isolates that agree with each other or bracket it.
 */
export const COLD_ISOLATES = 3;
/**
 * A calibration whose median wall time exceeds its median profile CPU by more than this factor measured a busy moment,
 * not the machine: the test process or the isolate waited for a core, so its speed is too high and would divide that
 * isolate's numbers too much (an injected 5 ms regression once read 3.9 ms that way). GitHub runners measured at most
 * 1.07 (61 calibrations), the idle reference machine at most 1.14 (71), the reference machine with nine of its ten
 * cores busy a median of 1.37 (48).
 */
export const MAX_WALL_OVER_CPU = 1.2;
/** How long one inspector call (and connecting) may take: far above any call's duration, far below a test timeout. */
export const INSPECTOR_TIMEOUT_MS = 30_000;
/**
 * A CPU test's timeout: COLD_ISOLATES isolates and up to as many more when a calibration was disturbed, several times
 * slower on a busy machine than idle. A stuck inspector fails sooner, within INSPECTOR_TIMEOUT_MS.
 */
export const CPU_TEST_TIMEOUT_MS = 300_000;

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

/** Whether a calibration measured a busy moment rather than the machine (MAX_WALL_OVER_CPU). */
export function disturbed(calibration: Calibration): boolean {
  return calibration.wall > MAX_WALL_OVER_CPU * calibration.cpu;
}

/** The factor a number measured on this machine is divided by to read in reference milliseconds: the speed, never below 1. */
export function scaleFor(speed: number): number {
  return Math.max(1, speed);
}

/** The failure message for isolates whose median speed is above MAX_SPEED. */
export function tooSlow(speeds: readonly number[]): string {
  return (
    `the calibration measured this machine ${speeds.map((speed) => speed.toFixed(2)).join(', ')}x slower than the reference ` +
    '(the median beyond MAX_SPEED): too slow (or too busy) for CPU bounds to mean anything, or the calibration is broken'
  );
}

/** The CPU meter of one Worker's isolate, through workerd's inspector. */
export interface CpuMeter {
  /** CPU milliseconds of the isolate while `run` executes. */
  cpu(run: () => Promise<unknown>): Promise<number>;
  /**
   * Runs `run` `times` times and prints the first run, the warm median and the warm best (one run: only that run,
   * which is then its own warm numbers too). Noise on a busy machine mostly raises these numbers; a sampler thread
   * that is not scheduled loses samples and lowers them.
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

/** Where workerd's inspector listens: a Miniflare started with `inspectorPort` (0: a free port the OS picks). */
export interface Inspector {
  getInspectorURL(): Promise<URL>;
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

/** `promise`, or a rejection that names `what` once `ms` have passed without it settling. */
export function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what}: nothing within ${String(ms)} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Connects to the isolate of the Worker named `worker` (Miniflare's `name`) through `inspector`, and starts the
 * profiler at SAMPLE_US. Connecting, every inspector call and every measured run fail after `timeoutMs`, and every
 * call fails at once when the connection closes: a stuck inspector is a failure that names its step, not a hang until
 * the test runner's timeout.
 */
export async function connectCpuMeter(inspector: Inspector, worker: string, timeoutMs = INSPECTOR_TIMEOUT_MS): Promise<CpuMeter> {
  const { host } = await inspector.getInspectorURL();
  const targets = (await fetch(`http://${host}/json`, { signal: AbortSignal.timeout(timeoutMs) })
    .then((listing) => listing.json())
    .catch((error: unknown) => {
      throw new Error(`the inspector's targets at ${host}: ${error instanceof Error ? error.message : String(error)}`);
    })) as { id: string; webSocketDebuggerUrl: string }[];
  const target = targets.find((candidate) => candidate.id === `core:user:${worker}`);
  if (target === undefined) throw new Error(`no inspector target for the Worker ${worker}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  /** Set once the connection closed: the reason every pending and later call fails with. */
  let closed: Error | undefined;
  const pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  socket.addEventListener('close', () => {
    closed ??= new Error(`the inspector connection of the Worker ${worker} closed`);
    for (const call of pending.values()) call.reject(closed);
    pending.clear();
  });
  try {
    await within(
      timeoutMs,
      `connecting to the inspector of the Worker ${worker}`,
      new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('close', () => {
          reject(new Error(`the inspector of the Worker ${worker} refused the connection`));
        }, { once: true });
      }),
    );
  } catch (error) {
    socket.close();
    throw error;
  }
  let next = 0;
  let context: string | undefined;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as InspectorMessage & Reply;
    if (message.id !== undefined) pending.get(message.id)?.resolve(message);
    if (message.method === 'Runtime.executionContextCreated') context ??= message.params?.context?.uniqueId;
  });
  const send = (method: string, params: Record<string, unknown> = {}): Promise<Reply> => {
    if (closed !== undefined) return Promise.reject(closed);
    next += 1;
    const id = next;
    const reply = new Promise<Reply>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    return within(timeoutMs, `the inspector of the Worker ${worker} answering ${method}`, reply).finally(() => pending.delete(id));
  };
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
    await within(timeoutMs, `a measured run in the Worker ${worker}`, run());
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
        times === 1
          ? `cpu ${label}: ${measured.first.toFixed(2)} ms (one run)`
          : `cpu ${label}: first ${measured.first.toFixed(2)} ms, warm median ${measured.median.toFixed(2)} ms, warm best ${measured.best.toFixed(2)} ms`,
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
          `(reference ${CALIBRATION_REFERENCE_MS.toFixed(2)} ms wall): speed ${calibration.speed.toFixed(2)}, numbers / ${scaleFor(calibration.speed).toFixed(2)}`,
      );
      return calibration;
    },
    close() {
      socket.close();
    },
  };
}

/** A fresh isolate of the Worker under test (a new Miniflare with its data), its meter connected. */
export interface Isolate {
  readonly meter: CpuMeter;
  /** Closes the meter and disposes of the isolate. */
  dispose(): Promise<void>;
}

/** What one isolate measured, as measured and in reference milliseconds, and its calibration. */
export interface IsolateRun {
  readonly calibration: Calibration;
  readonly measured: readonly Measurement[];
  readonly reference: readonly Measurement[];
}

/** One session measured in several isolates. */
export interface IsolatesResult {
  /** Every isolate measured, in order, replaced ones too. */
  readonly runs: readonly IsolateRun[];
  /** Label by label, each number's median across the isolates that count, in reference milliseconds: what bounds hold. */
  readonly reference: ReadonlyMap<string, Measurement>;
}

/** A measurement in reference milliseconds: each number divided by scaleFor(the speed of the isolate that measured it). */
export function inReference(measurement: Measurement, calibration: Calibration): Measurement {
  const scale = scaleFor(calibration.speed);
  return { label: measurement.label, first: measurement.first / scale, median: measurement.median / scale, best: measurement.best / scale };
}

/**
 * Label by label, each number's median (first, warm median, warm best) across the runs that measured the label: a
 * session may measure some paths in one isolate only. A label measured twice within one run is an error.
 */
export function medianAcross(runs: readonly (readonly Measurement[])[]): Map<string, Measurement> {
  const byLabel = new Map<string, Measurement[]>();
  for (const run of runs) {
    const labels = new Set<string>();
    for (const measurement of run) {
      if (labels.has(measurement.label)) throw new Error(`"${measurement.label}" is measured twice in one isolate`);
      labels.add(measurement.label);
      byLabel.set(measurement.label, [...(byLabel.get(measurement.label) ?? []), measurement]);
    }
  }
  const medians = new Map<string, Measurement>();
  for (const [label, all] of byLabel) {
    medians.set(label, {
      label,
      first: median(all.map((measurement) => measurement.first)),
      median: median(all.map((measurement) => measurement.median)),
      best: median(all.map((measurement) => measurement.best)),
    });
  }
  return medians;
}

/**
 * The isolates whose numbers count: the undisturbed ones once there are `count` of them; otherwise (a machine busy
 * throughout) all of them, which is as lenient as a single calibration always was, MAX_SPEED aside.
 */
function countedRuns(runs: readonly IsolateRun[], count: number): readonly IsolateRun[] {
  const undisturbed = runs.filter((run) => !disturbed(run.calibration));
  return undisturbed.length >= count ? undisturbed : runs;
}

/**
 * Measures `session` in `count` fresh isolates, one after another (see "Cold runs" above). For each one it starts an
 * isolate, runs the session (whose measurements, each label once, it returns), calibrates that isolate after the
 * session, so that every first run in it was the isolate's first run of its path, and disposes of it, also when a
 * step fails. An isolate whose calibration was disturbed (MAX_WALL_OVER_CPU) is replaced by another fresh one, up to
 * `count` more in all. Returns every isolate's run and, label by label, the median of each number across the
 * isolates that count (countedRuns; a label measured only in a replaced isolate keeps that isolate's numbers), in
 * reference milliseconds, and prints those medians with each isolate's first run. Fails when the counted isolates'
 * median speed is above MAX_SPEED: one isolate too busy to measure cannot hide a regression from the median of the
 * others, most of them can.
 */
export async function measureInIsolates<T extends Isolate>(
  count: number,
  start: (index: number) => Promise<T>,
  session: (isolate: T, index: number) => Promise<Measurement[]>,
): Promise<IsolatesResult> {
  if (!Number.isInteger(count) || count < 1) throw new Error(`measureInIsolates needs at least one isolate, not ${String(count)}`);
  const runs: IsolateRun[] = [];
  const undisturbed = () => runs.filter((run) => !disturbed(run.calibration)).length;
  for (let index = 0; undisturbed() < count && index < 2 * count; index += 1) {
    const isolate = await start(index);
    try {
      const measured = await session(isolate, index);
      const calibration = await isolate.meter.calibrate();
      if (disturbed(calibration)) console.log(`cpu isolate ${String(index)}: the calibration was disturbed (wall over CPU above ${String(MAX_WALL_OVER_CPU)}), measured again`);
      runs.push({ calibration, measured, reference: measured.map((measurement) => inReference(measurement, calibration)) });
    } finally {
      await isolate.dispose();
    }
  }
  const counted = countedRuns(runs, count);
  const speeds = counted.map((run) => run.calibration.speed);
  if (median(speeds) > MAX_SPEED) throw new Error(tooSlow(speeds));
  const reference = medianAcross(counted.map((run) => run.reference));
  for (const [label, measurement] of medianAcross(runs.map((run) => run.reference))) if (!reference.has(label)) reference.set(label, measurement);
  for (const { label, first, median: warm, best } of reference.values()) {
    const measuring = counted.some((run) => run.reference.some((measurement) => measurement.label === label)) ? counted : runs;
    const firsts = measuring.flatMap((run) => run.reference.filter((measurement) => measurement.label === label).map((measurement) => measurement.first.toFixed(2)));
    console.log(
      `cpu ${label}, reference ms, median of ${String(firsts.length)} isolate(s): first ${first.toFixed(2)} (each: ${firsts.join(', ')}), ` +
        `warm median ${warm.toFixed(2)}, warm best ${best.toFixed(2)}`,
    );
  }
  return { runs, reference };
}
