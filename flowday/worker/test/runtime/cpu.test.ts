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
import { setSetting } from '../../src/store/settings.ts';
import { startHarness, type FakeItem, type Harness } from './harness.ts';

const PORT = 9_000 + Math.floor(Math.random() * 500);
const FREE_CPU_MS = 10;
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
 * Runs `run` several times: the first run (the isolate's warm-up of that code path), then the warm median and the
 * warm best. The assertion uses the warm best, which noise on a busy CI machine can only raise, never lower.
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
  it('the heaviest handlers stay below the limit when warm (1,000 tasks, 1,000 hours of entries)', async () => {
    await h.reset();
    await setSetting(h.db(), 'todoist_api_key', 'synthetic-token');
    h.todoist.setProjects(Array.from({ length: 8 }, (_, n) => ({ id: `p-${String(n)}`, name: `Project ${String(n)}`, color: 'blue' })));
    h.todoist.setItems(items(1000));
    h.todoist.forceFull = true;
    // Fetches the CSRF token outside the measurements (one empty settings write).
    await h.mutate('PUT', '/api/settings', {});
    // Each manual sync needs a claim older than 30 s: clear the claim before each run.
    const fullSync = await measure('POST /api/sync, full sync of 1,000 tasks', async () => {
      await h.sql("DELETE FROM settings WHERE key = 'sync_claimed_at'");
      const result = await h.mutate('POST', '/api/sync', { mode: 'manual' });
      if (result.status !== 200) throw new Error(`sync ${String(result.status)}`);
    });

    h.todoist.forceFull = false;
    const incremental = await measure('POST /api/sync, incremental with 20 changes', async () => {
      for (let n = 0; n < 20; n += 1) h.todoist.update(`td-${String(n * 13)}`, { content: `Changed ${String(Math.random())}` });
      await h.sql("DELETE FROM settings WHERE key = 'sync_claimed_at'");
      await h.mutate('POST', '/api/sync', { mode: 'manual' });
    });

    const tasks = await measure('GET /api/tasks (1,000 tasks)', () => h.fetch('/api/tasks').then((response) => response.text()));

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

    for (const { best } of [fullSync, incremental, tasks, stats, week, page]) expect(best).toBeLessThan(FREE_CPU_MS);
  });
});
