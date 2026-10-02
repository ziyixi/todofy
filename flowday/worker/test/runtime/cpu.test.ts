/**
 * CPU of the heaviest handlers inside workerd, against Workers Free's 10 ms per request (../../../docs/design.md
 * "Free limits"), measured and calibrated by the shared meter (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU
 * profile of the Worker's isolate around each request, and the machine's speed from a fixed workload run in the same
 * isolate. Each request runs several times; the first includes the isolate's warm-up and is reported separately.
 *
 * The sync's first chunk, the one number measured on the isolate's first run, is measured in COLD_ISOLATES fresh
 * isolates (a new harness each, measureInIsolates); the other handlers, bounded by their warm best only, once, in the
 * third (a fourth or later isolate, measured again after a disturbed calibration, repeats only the sync: the other
 * handlers' 2,000 time entries would make a busy machine's run several minutes long). Every number is divided by its own isolate's speed (never below 1), and the bounds hold each number's
 * median across the isolates that measured it, in milliseconds of the reference machine (an Apple M1 Max). A median
 * speed above MAX_SPEED fails the test.
 */
import { describe, expect, it } from 'vitest';
import { COLD_ISOLATES, connectCpuMeter, CPU_TEST_TIMEOUT_MS, FREE_CPU_MS, measureInIsolates, type Isolate, type Measurement } from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { Meter } from '../../src/db.ts';
import { createTimeEntry } from '../../src/store/entries.ts';
import { setFlowTaskIds } from '../../src/store/flows.ts';
import { SYNC_CHUNK } from '../../src/sync.ts';
import { MAX_SYNC_BYTES, MAX_SYNC_ITEMS } from '../../src/todoist.ts';
import { startHarness, storeTodoistKey, type FakeItem, type Harness } from './harness.ts';

/**
 * The bound for an isolate's first run of the sync (the median of COLD_ISOLATES isolates), in reference milliseconds.
 * The reference machine measures about 8.6 ms for MAX_SYNC_ITEMS, of which about 6 ms is the first run of the sync's
 * code with any answer size; 2,000 items measured 10-14 ms; GitHub runners read single isolates 8.8-11.0 ms (15 runs,
 * 2026-10-01). So the bound only catches a large regression; the printed numbers are the ones to watch. On Cloudflare
 * a request stopped for CPU resumes from its pending chunk after the failure backoff (../../src/sync.ts).
 */
const COLD_BOUND_MS = 1.5 * FREE_CPU_MS;
/** Warm runs keep a margin below the limit (reference milliseconds). */
const WARM_BOUND_MS = 0.6 * FREE_CPU_MS;

const FIRST_CHUNK = `POST /api/sync, first chunk of a full sync of ${String(MAX_SYNC_ITEMS)} tasks`;

/** A fresh isolate: a new harness, its meter connected. */
interface FlowDayIsolate extends Isolate {
  readonly h: Harness;
}

async function startIsolate(): Promise<FlowDayIsolate> {
  // Port 0: the OS picks a free port, which the meter reads back from Miniflare.
  const h = await startHarness({ inspectorPort: 0 });
  try {
    const meter = await connectCpuMeter(h.mf, 'flowday');
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

/**
 * One isolate's session: the sync's first chunk, whose first run is the isolate's first sync of all (cold); in the
 * third isolate only, the other heavy handlers (bounded by their warm best, which one isolate measures well).
 */
async function session({ h, meter }: FlowDayIsolate, index: number): Promise<Measurement[]> {
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
  const firstChunk = await meter.measure(FIRST_CHUNK, async () => {
    await h.sql("DELETE FROM settings WHERE key IN ('sync_claimed_at', 'todoist_sync_token', 'todoist_sync_pending')");
    const result = await h.mutate<{ status: string }>('POST', '/api/sync', { mode: 'manual' });
    if (result.status !== 200 || result.body.status !== 'partial') throw new Error(`sync ${String(result.status)}`);
  });
  if (index !== COLD_ISOLATES - 1) return [firstChunk];
  // The last chunk also hides every task the full list does not name (one JSON list of every id).
  const sortedIds = items(MAX_SYNC_ITEMS).map((item) => item.id).sort();
  const lastAfter = sortedIds[sortedIds.length - SYNC_CHUNK / 2 - 1] ?? '';
  const lastChunk = await meter.measure(`POST /api/sync, last chunk of a full sync of ${String(MAX_SYNC_ITEMS)} tasks`, async () => {
    await h.sql("DELETE FROM settings WHERE key IN ('sync_claimed_at', 'todoist_sync_token')");
    await h.sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('todoist_sync_pending', ?)", JSON.stringify({ base: '*', token: 'first', after: lastAfter }));
    const result = await h.mutate<{ status: string }>('POST', '/api/sync', { mode: 'manual' });
    if (result.status !== 200 || result.body.status !== 'synced') throw new Error(`sync ${String(result.status)}`);
  });

  const incremental = await meter.measure('POST /api/sync, incremental with 20 changes', async () => {
    for (let n = 0; n < 20; n += 1) h.todoist.update(`td-${String(n * 13)}`, { content: `Changed ${String(Math.random())}` });
    await h.sql("DELETE FROM settings WHERE key = 'sync_claimed_at'");
    await h.mutate('POST', '/api/sync', { mode: 'manual' });
  });

  // The task list of the largest account.
  const tasks = await meter.measure(`GET /api/tasks (${String(MAX_SYNC_ITEMS)} tasks)`, () => h.fetch('/api/tasks').then((response) => response.text()));

  // 1,000 hours of time entries over a year (2,000 half-hour entries) and their flows.
  const db = h.db(new Meter());
  for (let n = 0; n < 2000; n += 1) {
    const day = new Date(Date.UTC(2025, 3, 13) + Math.floor(n / 6) * 86_400_000).toISOString().slice(0, 10);
    await createTimeEntry(db, { id: `e-${String(n)}`, taskId: `td-${String(n % 300)}`, flowDate: day, startTime: `${day}T${String(8 + (n % 6)).padStart(2, '0')}:00:00Z`, endTime: `${day}T${String(8 + (n % 6)).padStart(2, '0')}:30:00Z`, durationS: 1800, source: 'timer' });
  }
  for (let n = 0; n < 30; n += 1) await setFlowTaskIds(db, `2026-04-${String(1 + n).padStart(2, '0')}`, Array.from({ length: 8 }, (_, k) => `td-${String(n * 8 + k)}`));
  const stats = await meter.measure('GET /api/analytics (every entry: 1,000 hours)', () => h.fetch('/api/analytics').then((response) => response.text()));
  const week = await meter.measure('GET /api/analytics (one week)', () => h.fetch('/api/analytics?start=2026-04-06&end=2026-04-12').then((response) => response.text()));
  const page = await meter.measure('GET / (page CSP hashing)', () => h.fetch('/').then((response) => response.text()));
  return [firstChunk, lastChunk, incremental, tasks, stats, week, page];
}


describe('CPU per request (Workers Free: 10 ms)', () => {
  it('the heaviest handlers stay below the limit, the sync even on its cold first request', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
    const { reference } = await measureInIsolates(COLD_ISOLATES, startIsolate, session);
    console.log(`cpu bounds (reference ms, medians of the isolates): first < ${COLD_BOUND_MS.toFixed(2)}, warm best < ${WARM_BOUND_MS.toFixed(2)}`);
    // The sync runs rarely, so it often lands on code the isolate has not run yet: its first run is bounded too.
    expect(reference.get(FIRST_CHUNK)?.first, `${FIRST_CHUNK}: first run`).toBeLessThan(COLD_BOUND_MS);
    expect(reference.size).toBe(7);
    for (const { label, best } of reference.values()) expect(best, `${label}: warm best`).toBeLessThan(WARM_BOUND_MS);
  });
});
