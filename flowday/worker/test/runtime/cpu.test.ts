/**
 * CPU of the heaviest handlers inside workerd, against Workers Free's 10 ms per request (../../../docs/design.md
 * "Free limits"). workerd's DevTools inspector records a sampled CPU profile of the Worker's isolate around each
 * request; the CPU time is the sum of the sampled intervals that are not idle (D1 and outbound I/O run outside the
 * isolate and are not counted, as on Cloudflare). This is an estimate on the test machine, not Cloudflare's meter. Each request runs several times; the first includes the isolate's
 * warm-up and is reported separately.
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
 * The bound for an isolate's first run of the sync. On the test machine it measures below FREE_CPU_MS (about 8.6 ms
 * for MAX_SYNC_ITEMS, of which about 6 ms is the first run of the sync's code with any answer size; 2,000 items
 * measured 10-14 ms). A CI runner is slower than the test machine, so this bound only catches a large regression;
 * the printed number is the one to watch. On Cloudflare a request stopped for CPU resumes from its pending chunk
 * after the failure backoff (../../src/sync.ts).
 */
const COLD_BOUND_MS = 1.5 * FREE_CPU_MS;
/** Warm runs keep a margin below the limit. */
const WARM_BOUND_MS = 0.6 * FREE_CPU_MS;
const SAMPLE_US = 100;
/**
 * A sample's interval is capped at four sampling intervals: a single sample spanning several milliseconds is a gap in
 * which the sampler thread was not scheduled (the test machine runs vitest, Miniflare and workerd at once), not CPU.
 */
const MAX_SAMPLE_US = 4 * SAMPLE_US;

let h: Harness;
let send: (method: string, params?: Record<string, unknown>) => Promise<{ result?: { profile?: Profile } }>;
let socket: WebSocket;

interface Profile {
  nodes: { id: number; callFrame: { functionName: string } }[];
  samples: number[];
  timeDeltas: number[];
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
    const message = JSON.parse(String(event.data)) as { id?: number };
    if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  send = (method, params = {}) =>
    new Promise((resolve) => {
      next += 1;
      pending.set(next, resolve as (message: unknown) => void);
      socket.send(JSON.stringify({ id: next, method, params }));
    });
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

/**
 * Runs `run` several times: the first run (the isolate's warm-up of that code path, as on a cold isolate), then the
 * warm median and the warm best. Noise on a busy CI machine can only raise these numbers, never lower them.
 */
async function measure(label: string, run: () => Promise<unknown>, times = 5): Promise<{ first: number; median: number; best: number }> {
  const samples: number[] = [];
  for (let index = 0; index < times; index += 1) samples.push(await cpu(run));
  const [first = 0, ...warm] = samples;
  const sorted = [...warm].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? first;
  const best = sorted[0] ?? first;
  console.log(`cpu ${label}: first ${first.toFixed(2)} ms, warm median ${median.toFixed(2)} ms, warm best ${best.toFixed(2)} ms`);
  return { first, median, best };
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

    // The sync runs rarely, so it often lands on code the isolate has not run yet: its first run is bounded too.
    expect(firstChunk.first).toBeLessThan(COLD_BOUND_MS);
    for (const { best } of [firstChunk, lastChunk, incremental, tasks, stats, week, page]) expect(best).toBeLessThan(WARM_BOUND_MS);
  });
});
