/**
 * CPU of the heaviest handlers inside workerd, against Workers Free's 10 ms per request (../../../docs/design.md
 * "Free limits"). workerd's DevTools inspector records a sampled CPU profile of the Worker's isolate around each
 * request; the CPU time is the sum of the sampled intervals that are not idle (D1 and outbound I/O run outside the
 * isolate and are not counted, as on Cloudflare). This is an estimate on the test machine, not Cloudflare's meter.
 * Each request runs several times; the first includes the isolate's warm-up and is reported separately.
 *
 * The bounds are milliseconds of the reference machine (an Apple M1 Max), and the measured CPU scales with the
 * machine running the test: GitHub runners measure the sync 1.1-2.1x the reference, varying 2x within an hour. So
 * the test calibrates the machine in the same isolate: after the handlers, a fixed, deterministic workload shaped
 * like the sync's work (CALIBRATION_SETUP) runs in the Worker's own global scope through the inspector's
 * Runtime.evaluate, with the profiler running as for the handlers. Its warm median over CALIBRATION_REFERENCE_MS is
 * the machine's speed (calibrate). Both bounds are multiplied by it, clamped to at least 1 so a faster machine never
 * tightens the check against the Free limit. A speed above MAX_SPEED fails the test: a broken calibration or a
 * machine too busy to measure must not hide a regression.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Meter } from '../../src/db.ts';
import { createTimeEntry } from '../../src/store/entries.ts';
import { setFlowTaskIds } from '../../src/store/flows.ts';
import { SYNC_CHUNK } from '../../src/sync.ts';
import { MAX_SYNC_BYTES, MAX_SYNC_ITEMS } from '../../src/todoist.ts';
import { startHarness, storeTodoistKey, type FakeItem, type Harness } from './harness.ts';

const PORT = 9_000 + Math.floor(Math.random() * 500);
const FREE_CPU_MS = 10;
/**
 * The bound for an isolate's first run of the sync, in reference milliseconds. The reference machine measures about
 * 8.6 ms for MAX_SYNC_ITEMS, of which about 6 ms is the first run of the sync's code with any answer size; 2,000
 * items measured 10-14 ms. A first run is a single measurement, not a best of several, so the bound keeps room for
 * its noise and only catches a large regression; the printed number is the one to watch. On Cloudflare a request
 * stopped for CPU resumes from its pending chunk after the failure backoff (../../src/sync.ts).
 */
const COLD_BOUND_MS = 1.5 * FREE_CPU_MS;
/** Warm runs keep a margin below the limit (reference milliseconds). */
const WARM_BOUND_MS = 0.6 * FREE_CPU_MS;
const SAMPLE_US = 100;
/**
 * A sample's interval is capped at four sampling intervals: a single sample spanning several milliseconds is a gap in
 * which the sampler thread was not scheduled (the test machine runs vitest, Miniflare and workerd at once), not CPU.
 */
const MAX_SAMPLE_US = 4 * SAMPLE_US;

/** The global the calibration workload is installed as, in the Worker's isolate of this test only. */
const CALIBRATION_FN = '__flowdayCpuCalibration';
const CALIBRATION_ITEMS = 1000;
/** Passes per measured call: one pass is about 1.3 ms, too few 100 µs samples for a steady number. */
const CALIBRATION_PASSES = 4;
/**
 * Installs the calibration workload in the Worker's global scope. Setup, outside any measurement: a fixed synthetic
 * Todoist answer of CALIBRATION_ITEMS items with every field of an API v1 item (about 590 KiB of JSON; the ids are
 * a fixed permutation, so the sort has work to do). Each call then makes CALIBRATION_PASSES passes of the sync's kind
 * of work over it: parse the answer, drop completed items, sort by id, map each item to a row (labels serialised,
 * the due date cut to a day) and serialise the rows. No clock, randomness or I/O: the same work on every machine,
 * and the call returns CALIBRATION_CHARS. Any change to it changes its cost: measure CALIBRATION_REFERENCE_MS again.
 */
const CALIBRATION_SETUP = `(() => {
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
/** What a call of the calibration returns: proof that it ran the whole workload. */
const CALIBRATION_CHARS = CALIBRATION_PASSES * 293_004;
/**
 * The calibration's warm median wall time on the reference machine (an Apple M1 Max, workerd 1.20260926.1): the
 * median of 12 runs of this file, which measured 4.59-5.28 ms. Measure it again when the workload or a workerd
 * update changes its cost.
 */
const CALIBRATION_REFERENCE_MS = 4.8;
const CALIBRATION_WARMUP = 3;
const CALIBRATION_RUNS = 10;
/**
 * The slowest machine the bounds are scaled for: GitHub runners measure about 1.1-2.1, the reference machine with all
 * but one core busy up to 3.5.
 */
const MAX_SPEED = 5;

let h: Harness;
let send: (method: string, params?: Record<string, unknown>) => Promise<Reply>;
let socket: WebSocket;
/** The Worker's execution context (its global scope), the target of Runtime.evaluate. */
let workerContext: string | undefined;

interface Profile {
  nodes: { id: number; callFrame: { functionName: string } }[];
  samples: number[];
  timeDeltas: number[];
}

/** An inspector reply: Profiler.stop's profile or Runtime.evaluate's value. */
interface Reply {
  error?: { message: string };
  result?: { profile?: Profile; result?: { value?: unknown }; exceptionDetails?: unknown };
}

interface InspectorEvent {
  method?: string;
  params?: { context?: { uniqueId?: string } };
}

beforeAll(async () => {
  h = await startHarness({ inspectorPort: PORT });
  const targets = await (await fetch(`http://127.0.0.1:${String(PORT)}/json`)).json<{ id: string; webSocketDebuggerUrl: string }[]>();
  const target = targets.find((candidate) => candidate.id === 'core:user:flowday');
  if (target === undefined) throw new Error('no inspector target for the Worker');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => { socket.addEventListener('open', resolve, { once: true }); });
  let next = 0;
  const pending = new Map<number, (message: unknown) => void>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number } & InspectorEvent;
    if (message.id !== undefined) pending.get(message.id)?.(message);
    if (message.method === 'Runtime.executionContextCreated') workerContext ??= message.params?.context?.uniqueId;
  });
  send = (method, params = {}) =>
    new Promise((resolve) => {
      next += 1;
      pending.set(next, resolve as (message: unknown) => void);
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  // Runtime.enable announces the Worker's execution context before it answers. Runtime stays disabled during the
  // measurements, so the Worker's console lines are not also sent to this socket.
  await send('Runtime.enable');
  await send('Runtime.disable');
  if (workerContext === undefined) throw new Error('no execution context for the Worker');
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: SAMPLE_US });
});

afterAll(async () => {
  socket.close();
  await h.dispose();
});

/** CPU milliseconds of the isolate while `run` executes. */
async function cpu(run: () => Promise<unknown>): Promise<number> {
  await send('Profiler.start');
  await run();
  const { result } = await send('Profiler.stop');
  const profile = result?.profile;
  if (profile === undefined) throw new Error('no profile');
  const idle = new Set(profile.nodes.filter((node) => node.callFrame.functionName === '(idle)').map((node) => node.id));
  let micros = 0;
  const byFn = new Map<string, number>();
  const names = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
  profile.samples.forEach((sample, index) => {
    if (idle.has(sample)) return;
    const delta = Math.min(profile.timeDeltas[index] ?? 0, MAX_SAMPLE_US);
    micros += delta;
    const name = names.get(sample) ?? '?';
    byFn.set(name, (byFn.get(name) ?? 0) + delta);
  });
  // CPU_DEBUG=1: the top functions of each profile.
  if (process.env['CPU_DEBUG'] !== undefined) console.log(JSON.stringify([...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)));
  return micros / 1000;
}

/** Evaluates `expression` in the Worker's global scope (its isolate) and returns the value. */
async function evaluate(expression: string): Promise<unknown> {
  const reply = await send('Runtime.evaluate', { expression, uniqueContextId: workerContext, returnByValue: true });
  if (reply.error !== undefined) throw new Error(`Runtime.evaluate: ${reply.error.message}`);
  if (reply.result?.exceptionDetails !== undefined) throw new Error(`Runtime.evaluate: ${JSON.stringify(reply.result.exceptionDetails)}`);
  return reply.result?.result?.value;
}

/**
 * The machine's speed: the calibration's warm median (after CALIBRATION_WARMUP runs) over CALIBRATION_REFERENCE_MS;
 * above 1 the machine is slower than the reference. Each run is timed from Node around Runtime.evaluate. On an idle
 * machine that wall time matches the profile's CPU within about 0.1 ms, but unlike the profile it cannot lose time:
 * on a busy machine the sampler thread is not always scheduled, and a calibration read from its own profile then
 * sometimes lost most of its samples, clamping the speed to 1 while the sync's first run read high. The median, not
 * the best: the best of ten finds a quiet moment that the sync's single first run and four warm runs do not.
 */
async function calibrate(): Promise<{ cpu: number; wall: number; speed: number }> {
  await evaluate(CALIBRATION_SETUP);
  const cpus: number[] = [];
  const walls: number[] = [];
  for (let index = 0; index < CALIBRATION_WARMUP + CALIBRATION_RUNS; index += 1) {
    let wall = 0;
    const used = await cpu(async () => {
      const start = performance.now();
      const chars = await evaluate(`${CALIBRATION_FN}()`);
      wall = performance.now() - start;
      if (chars !== CALIBRATION_CHARS) throw new Error(`calibration returned ${String(chars)}, not ${String(CALIBRATION_CHARS)}`);
    });
    if (index < CALIBRATION_WARMUP) continue;
    cpus.push(used);
    walls.push(wall);
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  return { cpu: median(cpus), wall: median(walls), speed: median(walls) / CALIBRATION_REFERENCE_MS };
}

/**
 * Runs `run` several times: the first run (the isolate's warm-up of that code path, as on a cold isolate), then the
 * warm median and the warm best. Noise on a busy machine mostly raises these numbers; a sampler thread that is not
 * scheduled loses samples and lowers them.
 */
async function measure(label: string, run: () => Promise<unknown>, times = 5): Promise<{ label: string; first: number; median: number; best: number }> {
  const samples: number[] = [];
  for (let index = 0; index < times; index += 1) samples.push(await cpu(run));
  const [first = 0, ...warm] = samples;
  const sorted = [...warm].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? first;
  const best = sorted[0] ?? first;
  console.log(`cpu ${label}: first ${first.toFixed(2)} ms, warm median ${median.toFixed(2)} ms, warm best ${best.toFixed(2)} ms`);
  return { label, first, median, best };
}

function items(count: number): FakeItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `td-${String(index)}`,
    content: `Synthetic task ${String(index)} with a realistic, somewhat longer title`,
    description: index % 3 === 0 ? 'A synthetic description of moderate length, two sentences. Nothing real.' : '',
    project_id: `p-${String(index % 8)}`,
    priority: 1 + (index % 4),
    labels: index % 5 === 0 ? ['quick', 'home'] : [],
    due: index % 2 === 0 ? { date: '2026-04-13T09:30:00' } : null,
    duration: index % 4 === 0 ? { amount: 30, unit: 'minute' } : null,
  }));
}

describe('CPU per request (Workers Free: 10 ms)', () => {
  it('the heaviest handlers stay below the limit, the sync even on its cold first request', async () => {
    await h.reset();
    await storeTodoistKey(h.db(), 'synthetic-token');
    h.todoist.setProjects(Array.from({ length: 8 }, (_, n) => ({ id: `p-${String(n)}`, name: `Project ${String(n)}`, color: 'blue' })));
    // The largest answer FlowDay accepts, with every field of a Todoist API v1 item (./harness.ts FakeTodoist).
    h.todoist.setItems(items(MAX_SYNC_ITEMS));
    const answerBytes = (await h.todoist.answer(new Request('https://x/', { method: 'POST' }), 'sync_token=*').arrayBuffer()).byteLength;
    console.log(`cpu: the full answer of ${String(MAX_SYNC_ITEMS)} items is ${(answerBytes / 1024).toFixed(0)} KiB (cap ${String(MAX_SYNC_BYTES / 1024)} KiB)`);
    expect(answerBytes).toBeLessThan(MAX_SYNC_BYTES);
    // Fetches the CSRF token outside the measurements (one empty settings write).
    await h.mutate('PUT', '/api/settings', {});
    // Each run is the first chunk of a new full pass: parse every item, apply SYNC_CHUNK of them. The first run is
    // the isolate's first sync of all (cold).
    const firstChunk = await measure(`POST /api/sync, first chunk of a full sync of ${String(MAX_SYNC_ITEMS)} tasks`, async () => {
      await h.sql("DELETE FROM settings WHERE key IN ('sync_claimed_at', 'todoist_sync_token', 'todoist_sync_pending')");
      const result = await h.mutate<{ status: string }>('POST', '/api/sync', { mode: 'manual' });
      if (result.status !== 200 || result.body.status !== 'partial') throw new Error(`sync ${String(result.status)}`);
    });
    // The last chunk also hides every task the full list does not name (one JSON list of every id).
    const sortedIds = items(MAX_SYNC_ITEMS).map((item) => item.id).sort();
    const lastAfter = sortedIds[sortedIds.length - SYNC_CHUNK / 2 - 1] ?? '';
    const lastChunk = await measure(`POST /api/sync, last chunk of a full sync of ${String(MAX_SYNC_ITEMS)} tasks`, async () => {
      await h.sql("DELETE FROM settings WHERE key IN ('sync_claimed_at', 'todoist_sync_token')");
      await h.sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('todoist_sync_pending', ?)", JSON.stringify({ base: '*', token: 'first', after: lastAfter }));
      const result = await h.mutate<{ status: string }>('POST', '/api/sync', { mode: 'manual' });
      if (result.status !== 200 || result.body.status !== 'synced') throw new Error(`sync ${String(result.status)}`);
    });

    const incremental = await measure('POST /api/sync, incremental with 20 changes', async () => {
      for (let n = 0; n < 20; n += 1) h.todoist.update(`td-${String(n * 13)}`, { content: `Changed ${String(Math.random())}` });
      await h.sql("DELETE FROM settings WHERE key = 'sync_claimed_at'");
      await h.mutate('POST', '/api/sync', { mode: 'manual' });
    });

    // The task list of the largest account.
    const tasks = await measure(`GET /api/tasks (${String(MAX_SYNC_ITEMS)} tasks)`, () => h.fetch('/api/tasks').then((response) => response.text()));

    // 1,000 hours of time entries over a year (2,000 half-hour entries) and their flows.
    const db = h.db(new Meter());
    for (let n = 0; n < 2000; n += 1) {
      const day = new Date(Date.UTC(2025, 3, 13) + Math.floor(n / 6) * 86_400_000).toISOString().slice(0, 10);
      await createTimeEntry(db, { id: `e-${String(n)}`, taskId: `td-${String(n % 300)}`, flowDate: day, startTime: `${day}T${String(8 + (n % 6)).padStart(2, '0')}:00:00Z`, endTime: `${day}T${String(8 + (n % 6)).padStart(2, '0')}:30:00Z`, durationS: 1800, source: 'timer' });
    }
    for (let n = 0; n < 30; n += 1) await setFlowTaskIds(db, `2026-04-${String(1 + n).padStart(2, '0')}`, Array.from({ length: 8 }, (_, k) => `td-${String(n * 8 + k)}`));
    const stats = await measure('GET /api/analytics (every entry: 1,000 hours)', () => h.fetch('/api/analytics').then((response) => response.text()));
    const week = await measure('GET /api/analytics (one week)', () => h.fetch('/api/analytics?start=2026-04-06&end=2026-04-12').then((response) => response.text()));
    const page = await measure('GET / (page CSP hashing)', () => h.fetch('/').then((response) => response.text()));

    // Calibrated after the handlers, so the sync's first run above is still the isolate's first work of that size.
    const calibration = await calibrate();
    const speed = Math.max(1, calibration.speed);
    const coldBound = COLD_BOUND_MS * speed;
    const warmBound = WARM_BOUND_MS * speed;
    console.log(
      `cpu calibration: warm median ${calibration.wall.toFixed(2)} ms wall, ${calibration.cpu.toFixed(2)} ms CPU ` +
        `(reference ${CALIBRATION_REFERENCE_MS.toFixed(2)} ms wall): speed ${calibration.speed.toFixed(2)}, ` +
        `bounds: first < ${coldBound.toFixed(2)} ms, warm best < ${warmBound.toFixed(2)} ms`,
    );
    expect(
      calibration.speed,
      `the calibration measured this machine ${calibration.speed.toFixed(2)}x slower than the reference, beyond MAX_SPEED: ` +
        'too slow (or too busy) for CPU bounds to mean anything, or the calibration is broken',
    ).toBeLessThanOrEqual(MAX_SPEED);
    // The sync runs rarely, so it often lands on code the isolate has not run yet: its first run is bounded too.
    expect(firstChunk.first, `${firstChunk.label}: first run`).toBeLessThan(coldBound);
    for (const { label, best } of [firstChunk, lastChunk, incremental, tasks, stats, week, page]) expect(best, `${label}: warm best`).toBeLessThan(warmBound);
  });
});
