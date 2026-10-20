/** Focus day queues, the timer and time records (src/focus*.ts) over the owner API and a real D1. Synthetic rows. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { localDate } from '@ziyixi/task-dates';
import { startHarness, type Harness } from './harness.ts';

const ZONE = 'America/Los_Angeles';
let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.dispose();
});

interface WireTask {
  id: string;
  name: string;
  etag: string;
}
interface WireDay {
  day: string;
  task_ids?: string[];
  done_task_ids?: string[];
}
interface WireEntry {
  name: string;
  task_id: string;
  day: string;
  seconds: number;
  start_time?: string;
  source: string;
  area?: string;
  etag: string;
}
interface WireTimer {
  state: string;
  task_id?: string;
  day?: string;
  area?: string;
  target_seconds?: number;
  saved_seconds?: number;
  finished_task_id?: string;
  finished_seconds?: number;
  etag: string;
}
interface WireFocus {
  days: WireDay[];
  entries?: WireEntry[];
  tasks?: { task_id: string; title: string; parent_id?: string; parent_title?: string; completed?: boolean }[];
  today: string;
}

const today = () => localDate(Date.now(), ZONE);
async function ok<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<T>;
}
async function refusal(response: Response): Promise<string> {
  expect(response.status).toBeGreaterThanOrEqual(400);
  return ((await response.json()) as { error: { status: string } }).error.status;
}
async function task(title: string, extra: Record<string, unknown> = {}): Promise<WireTask> {
  return ok(await harness.mutate('POST', `/api/tasks/v1/tasks?request_id=${randomUUID()}`, { title, ...extra }));
}
function move(body: Record<string, unknown>, requestId = randomUUID()) {
  return harness.mutate('POST', '/api/tasks/v1/focusDays:moveStep', { request_id: requestId, ...body });
}
async function read(start: string, end = start): Promise<WireFocus> {
  return ok(await harness.fetch(`/api/tasks/v1/focusDays?start_day=${start}&end_day=${end}`));
}
async function queue(day: string): Promise<{ open: string[]; done: string[] }> {
  const found = (await read(day)).days[0];
  return { open: found?.task_ids ?? [], done: found?.done_task_ids ?? [] };
}
async function timer(): Promise<WireTimer> {
  return ok(await harness.fetch('/api/tasks/v1/focusTimer'));
}
async function command(action: string, extra: Record<string, unknown> = {}, requestId = randomUUID()) {
  const { etag } = await timer();
  return harness.mutate('POST', '/api/tasks/v1/focusTimer:command', { etag, request_id: requestId, action, ...extra });
}
/** Moves the running session's start back, as if `seconds` had passed. */
async function elapse(seconds: number) {
  await harness.db
    .prepare("UPDATE focus_timer SET started_at=started_at-?1,segment_start=segment_start-?1 WHERE id='timer'")
    .bind(seconds * 1000)
    .run();
}
function addEntry(fields: Record<string, unknown>, requestId = randomUUID()) {
  return harness.mutate('POST', `/api/tasks/v1/focusEntries?request_id=${requestId}`, fields);
}
function editEntry(entry: WireEntry, seconds: number, mask = 'seconds') {
  return harness.mutate(
    'PATCH',
    `/api/tasks/v1/${entry.name}?request_id=${randomUUID()}&update_mask=${mask}&etag=${entry.etag}`,
    { seconds },
  );
}
async function stepRows(day: string) {
  return (
    await harness.db
      .prepare('SELECT task_id,position,done_at,deleted_at FROM day_steps WHERE day=? ORDER BY position')
      .bind(day)
      .all()
  ).results;
}

test('a step is added, reordered, moved to another day and removed, each in one write', async () => {
  const [a, b, c] = [await task('Synthetic step A'), await task('Synthetic step B'), await task('Synthetic step C')];
  for (const step of [a, b, c]) await ok(await move({ task_id: step.id, destination_day: '2030-10-21' }));
  expect(await queue('2030-10-21')).toEqual({ open: [a.id, b.id, c.id], done: [] });
  const reordered = await ok<{ days: WireDay[] }>(
    await move({ task_id: c.id, source_day: '2030-10-21', destination_day: '2030-10-21', before_task_id: a.id }),
  );
  expect(reordered.days).toEqual([{ day: '2030-10-21', task_ids: [c.id, a.id, b.id] }]);
  const moved = await ok<{ days: WireDay[] }>(
    await move({ task_id: a.id, source_day: '2030-10-21', destination_day: '2030-10-22' }),
  );
  expect(moved.days).toEqual([
    { day: '2030-10-21', task_ids: [c.id, b.id] },
    { day: '2030-10-22', task_ids: [a.id] },
  ]);
  const removed = await ok<{ days: WireDay[] }>(await move({ task_id: b.id, source_day: '2030-10-21' }));
  expect(removed.days).toEqual([{ day: '2030-10-21', task_ids: [c.id] }]);
  const week = await read('2030-10-20', '2030-10-26');
  expect(week.days.map((day) => day.day)).toEqual([
    '2030-10-20',
    '2030-10-21',
    '2030-10-22',
    '2030-10-23',
    '2030-10-24',
    '2030-10-25',
    '2030-10-26',
  ]);
  expect(week.days.map((day) => day.task_ids ?? [])).toEqual([[], [c.id], [a.id], [], [], [], []]);
  expect(week.tasks?.map((row) => row.title).sort()).toEqual(['Synthetic step A', 'Synthetic step C']);
  // Removed and moved-away rows are kept as deleted, never removed from D1.
  expect((await stepRows('2030-10-21')).filter((row) => row.deleted_at !== null)).toHaveLength(2);
});

test('a step goes before another by the midpoint, and a gap too small to halve renumbers the day', async () => {
  const steps = [await task('Synthetic gap 1'), await task('Synthetic gap 2'), await task('Synthetic gap 3')];
  for (const step of steps.slice(0, 2)) await ok(await move({ task_id: step.id, destination_day: '2030-11-01' }));
  await harness.db
    .prepare('UPDATE day_steps SET position=? WHERE day=? AND task_id=?')
    .bind(1 + 1e-7, '2030-11-01', steps[1]?.id)
    .run();
  await ok(await move({ task_id: steps[2]?.id, destination_day: '2030-11-01', before_task_id: steps[1]?.id }));
  expect((await stepRows('2030-11-01')).map((row) => [row.task_id, row.position])).toEqual([
    [steps[0]?.id, 1],
    [steps[2]?.id, 2],
    [steps[1]?.id, 3],
  ]);
  const first = await task('Synthetic gap first');
  await ok(await move({ task_id: first.id, destination_day: '2030-11-01', before_task_id: steps[0]?.id }));
  expect((await stepRows('2030-11-01'))[0]).toMatchObject({ task_id: first.id, position: 0.5 });
});

test('a missing before step, a full day and a completed step are refused without writing', async () => {
  const day = '2030-12-01';
  const steps = await Promise.all(Array.from({ length: 30 }, (_, index) => task(`Synthetic full ${String(index)}`)));
  await harness.db.batch(
    steps.map((step, index) =>
      harness.db
        .prepare('INSERT INTO day_steps(day,task_id,position,created_at,updated_at) VALUES(?,?,?,1,1)')
        .bind(day, step.id, index + 1),
    ),
  );
  const extra = await task('Synthetic 31st step');
  const done = await task('Synthetic completed step');
  await ok(
    await harness.mutate('POST', `/api/tasks/v1/${done.name}:complete`, { etag: done.etag, request_id: randomUUID() }),
  );
  const receipts = () => harness.db.prepare('SELECT count(*) AS n FROM requests').first<{ n: number }>();
  const before = { rows: await stepRows(day), receipts: await receipts() };
  expect(await refusal(await move({ task_id: extra.id, destination_day: day }))).toBe('FAILED_PRECONDITION');
  expect(
    await refusal(await move({ task_id: extra.id, destination_day: '2030-12-02', before_task_id: steps[0]?.id })),
  ).toBe('FAILED_PRECONDITION');
  expect(await refusal(await move({ task_id: extra.id, source_day: '2030-12-02' }))).toBe('FAILED_PRECONDITION');
  expect(await refusal(await move({ task_id: done.id, destination_day: '2030-12-03' }))).toBe('FAILED_PRECONDITION');
  expect(await refusal(await move({ task_id: 'missing-task', destination_day: '2030-12-03' }))).toBe('NOT_FOUND');
  expect(await stepRows(day)).toEqual(before.rows);
  expect(await stepRows('2030-12-02')).toEqual([]);
  expect(await stepRows('2030-12-03')).toEqual([]);
  expect(await receipts()).toEqual(before.receipts);
  // A step already on the full day may still move within it.
  await ok(await move({ task_id: steps[29]?.id, source_day: day, destination_day: day, before_task_id: steps[0]?.id }));
  expect((await queue(day)).open[0]).toBe(steps[29]?.id);
});

test('malformed days and empty moves are invalid', async () => {
  const step = await task('Synthetic malformed');
  for (const body of [
    { task_id: step.id, destination_day: '2030-13-01' },
    { task_id: step.id, destination_day: '2030-10-1' },
    { task_id: step.id, source_day: 'tomorrow' },
    { task_id: step.id },
    { task_id: step.id, source_day: '2030-10-21', before_task_id: step.id },
  ])
    expect(await refusal(await move(body)), JSON.stringify(body)).toBe('INVALID_ARGUMENT');
  for (const query of [
    'start_day=2030-10-21&end_day=2030-10-28',
    'start_day=2030-10-22&end_day=2030-10-21',
    'start_day=x&end_day=2030-10-21',
  ])
    expect(await refusal(await harness.fetch(`/api/tasks/v1/focusDays?${query}`)), query).toBe('INVALID_ARGUMENT');
});

test('a move replays its frozen answer, and its request ID is refused for other input', async () => {
  const [a, b] = [await task('Synthetic replay A'), await task('Synthetic replay B')];
  await ok(await move({ task_id: a.id, destination_day: '2030-10-25' }));
  const requestId = randomUUID();
  const first = await ok(await move({ task_id: b.id, destination_day: '2030-10-25' }, requestId));
  await ok(await move({ task_id: a.id, source_day: '2030-10-25' }));
  expect(await ok(await move({ task_id: b.id, destination_day: '2030-10-25' }, requestId))).toEqual(first);
  expect(await queue('2030-10-25')).toEqual({ open: [b.id], done: [] });
  expect(await refusal(await move({ task_id: a.id, destination_day: '2030-10-25' }, requestId))).toBe(
    'INVALID_ARGUMENT',
  );
});

test('a step re-added to a day where it is done is open again', async () => {
  // A recurring step stays open when it completes; its row on that day is done.
  const step = await task('Synthetic recurring step', { due_date: '2030-10-21', recurrence: 'every day' });
  await ok(await move({ task_id: step.id, destination_day: '2030-10-23' }));
  await harness.db.prepare("UPDATE day_steps SET done_at=1 WHERE day='2030-10-23' AND task_id=?").bind(step.id).run();
  expect(await queue('2030-10-23')).toEqual({ open: [], done: [step.id] });
  const reopened = await ok<{ days: WireDay[] }>(await move({ task_id: step.id, destination_day: '2030-10-23' }));
  expect(reopened.days).toEqual([{ day: '2030-10-23', task_ids: [step.id] }]);
  expect(await queue('2030-10-23')).toEqual({ open: [step.id], done: [] });
});

test('a deleted task leaves the queues and its records stay', async () => {
  const parent = await task('Synthetic parent');
  const step = await task('Synthetic deleted step', { parent_id: parent.id, kind: 'step' });
  await ok(await move({ task_id: step.id, destination_day: '2026-10-01' }));
  await ok(await addEntry({ task_id: step.id, day: '2026-10-01', seconds: 600, area: 'work' }));
  const current = await ok<WireTask>(await harness.fetch(`/api/tasks/v1/${step.name}`));
  await ok(
    await harness.mutate('DELETE', `/api/tasks/v1/${step.name}?etag=${current.etag}&request_id=${randomUUID()}`),
  );
  const day = await read('2026-10-01');
  expect(day.days[0]?.task_ids ?? []).not.toContain(step.id);
  expect(day.entries?.filter((entry) => entry.task_id === step.id)).toHaveLength(1);
  expect(day.tasks?.find((row) => row.task_id === step.id)).toMatchObject({
    title: 'Synthetic deleted step',
    parent_id: parent.id,
    parent_title: 'Synthetic parent',
  });
  expect(await refusal(await move({ task_id: step.id, source_day: '2026-10-01' }))).toBe('NOT_FOUND');
});

test('the timer starts on Tasks today, pauses, resumes and stops into one record with its area', async () => {
  const step = await task('Synthetic timed step');
  const started = await ok<{ timer: WireTimer; entry?: WireEntry }>(
    await command('start', { task_id: step.id, area: 'personal' }),
  );
  expect(started.timer).toMatchObject({ state: 'running', task_id: step.id, day: today(), area: 'personal' });
  expect(started.entry).toBeUndefined();
  expect(await refusal(await command('start', { task_id: step.id }))).toBe('FAILED_PRECONDITION');
  expect(await refusal(await command('resume'))).toBe('FAILED_PRECONDITION');
  await elapse(600);
  const paused = await ok<{ timer: WireTimer }>(await command('pause', { task_id: step.id }));
  expect(paused.timer).toMatchObject({ state: 'paused' });
  expect(paused.timer.saved_seconds).toBeGreaterThanOrEqual(600);
  expect(await refusal(await command('pause'))).toBe('FAILED_PRECONDITION');
  expect(await refusal(await command('finish'))).toBe('FAILED_PRECONDITION');
  expect(await refusal(await command('stop', { task_id: 'another-step' }))).toBe('FAILED_PRECONDITION');
  await ok(await command('resume'));
  await elapse(300);
  const stopped = await ok<{ timer: WireTimer; entry?: WireEntry }>(await command('stop'));
  expect(stopped.timer).toMatchObject({ state: 'idle' });
  expect(stopped.timer.task_id).toBeUndefined();
  expect(stopped.entry).toMatchObject({
    task_id: step.id,
    day: today(),
    seconds: 900,
    source: 'timer',
    area: 'personal',
  });
  expect(stopped.entry?.start_time).toBeDefined();
  expect(await refusal(await command('stop'))).toBe('FAILED_PRECONDITION');
  const entries = (await read(today())).entries ?? [];
  expect(entries.filter((entry) => entry.task_id === step.id)).toEqual([stopped.entry]);
});

test('a stale etag conflicts and a repeated command replays its answer', async () => {
  const step = await task('Synthetic replayed timer');
  const { etag } = await timer();
  const requestId = randomUUID();
  const body = { etag, request_id: requestId, action: 'start', task_id: step.id };
  const first = await ok(await harness.mutate('POST', '/api/tasks/v1/focusTimer:command', body));
  expect(await ok(await harness.mutate('POST', '/api/tasks/v1/focusTimer:command', body))).toEqual(first);
  const stale = await harness.mutate('POST', '/api/tasks/v1/focusTimer:command', {
    etag,
    request_id: randomUUID(),
    action: 'stop',
  });
  expect(stale.status).toBe(409);
  // A session under a minute saves nothing.
  const stopped = await ok<{ entry?: WireEntry }>(await command('stop'));
  expect(stopped.entry).toBeUndefined();
  expect((await read(today())).entries?.filter((entry) => entry.task_id === step.id) ?? []).toEqual([]);
});

test('a pomodoro finishes at its target and counting up stops at 4 hours', async () => {
  const step = await task('Synthetic pomodoro');
  await ok(await command('start', { task_id: step.id, target_seconds: 1500, area: 'work' }));
  await elapse(1800);
  const finished = await ok<{ timer: WireTimer; entry?: WireEntry }>(await command('finish', { task_id: step.id }));
  expect(finished.timer).toMatchObject({ state: 'idle', finished_task_id: step.id, finished_seconds: 1500 });
  expect(finished.entry).toMatchObject({ seconds: 1500, area: 'work' });
  expect(await refusal(await command('start', { task_id: step.id, target_seconds: 30 }))).toBe('INVALID_ARGUMENT');
  const counted = await ok<{ timer: WireTimer }>(await command('start', { task_id: step.id }));
  expect(counted.timer.target_seconds).toBeUndefined();
  expect(counted.timer.finished_task_id).toBeUndefined();
  await elapse(24 * 3600);
  expect(await refusal(await command('finish'))).toBe('FAILED_PRECONDITION');
  const stopped = await ok<{ entry?: WireEntry }>(await command('stop'));
  expect(stopped.entry?.seconds).toBe(14_400);
});

test('records are created, changed and deleted with etags, within their bounds', async () => {
  const step = await task('Synthetic records');
  const created = await ok<WireEntry>(
    await addEntry({ task_id: step.id, day: '2026-10-02', seconds: 900, area: 'work' }),
  );
  expect(created).toMatchObject({ task_id: step.id, day: '2026-10-02', seconds: 900, source: 'manual', area: 'work' });
  expect(created.start_time).toBeUndefined();
  const changed = await ok<WireEntry>(await editEntry(created, 2400));
  expect(changed).toMatchObject({ seconds: 2400 });
  expect(changed.etag).not.toBe(created.etag);
  expect((await editEntry(created, 1200)).status).toBe(409);
  expect(await refusal(await editEntry(changed, 0))).toBe('INVALID_ARGUMENT');
  expect(await refusal(await editEntry(changed, 90))).toBe('INVALID_ARGUMENT');
  // An immutable field may be named only with its stored value.
  const named = await harness.mutate(
    'PATCH',
    `/api/tasks/v1/${changed.name}?request_id=${randomUUID()}&update_mask=seconds,day&etag=${changed.etag}`,
    { seconds: 1800, day: '2026-10-03' },
  );
  expect(await refusal(named)).toBe('INVALID_ARGUMENT');
  const deleted = await harness.mutate(
    'DELETE',
    `/api/tasks/v1/${changed.name}?etag=${changed.etag}&request_id=${randomUUID()}`,
  );
  expect(deleted.status, await deleted.clone().text()).toBe(200);
  expect((await read('2026-10-02')).entries ?? []).toEqual([]);
  expect((await editEntry(changed, 600)).status).toBe(404);
  const tomorrow = localDate(Date.now() + 36 * 3600 * 1000, ZONE);
  expect(await refusal(await addEntry({ task_id: step.id, day: tomorrow, seconds: 600 }))).toBe('INVALID_ARGUMENT');
  expect(await refusal(await addEntry({ task_id: step.id, day: '2026-10-02', seconds: 0 }))).toBe('INVALID_ARGUMENT');
  expect(await refusal(await addEntry({ task_id: step.id, day: '2026-10-02', seconds: 600, area: 'home' }))).toBe(
    'INVALID_ARGUMENT',
  );
  expect(await refusal(await addEntry({ task_id: 'missing-task', day: '2026-10-02', seconds: 600 }))).toBe('NOT_FOUND');
});

test('a day holds 40 records, an active session holding one place', async () => {
  const step = await task('Synthetic busy day');
  const fill = (day: string, count: number) =>
    harness.db
      .prepare(
        `INSERT INTO focus_entries(id,task_id,day,seconds,source,created_at,updated_at)
        SELECT 'fill-'||?1||'-'||value,?2,?1,60,'manual',1,1 FROM json_each(?3)`,
      )
      .bind(day, step.id, JSON.stringify(Array.from({ length: count }, (_, index) => index)))
      .run();
  await fill('2026-10-05', 40);
  expect(await refusal(await addEntry({ task_id: step.id, day: '2026-10-05', seconds: 600 }))).toBe(
    'FAILED_PRECONDITION',
  );
  const live = await harness.db
    .prepare('SELECT count(*) AS n FROM focus_entries WHERE day=? AND deleted_at IS NULL')
    .bind(today())
    .first<{ n: number }>();
  await fill(today(), 39 - (live?.n ?? 0));
  await ok(await command('start', { task_id: step.id }));
  expect(await refusal(await addEntry({ task_id: step.id, day: today(), seconds: 600 }))).toBe('FAILED_PRECONDITION');
  await elapse(120);
  const stopped = await ok<{ entry?: WireEntry }>(await command('stop'));
  expect(stopped.entry?.seconds).toBe(120);
  expect(await refusal(await command('start', { task_id: step.id }))).toBe('FAILED_PRECONDITION');
  expect((await timer()).state).toBe('idle');
  await harness.db.prepare('UPDATE focus_entries SET deleted_at=1 WHERE task_id=?').bind(step.id).run();
});

test('a read answers Tasks today, and a range over its row bound is refused', async () => {
  expect((await read('2026-10-10')).today).toBe(today());
  const step = await task('Synthetic over-cap reader');
  await harness.db
    .prepare(
      `INSERT INTO focus_entries(id,task_id,day,seconds,source,created_at,updated_at)
      SELECT 'over-'||value,?,'2026-09-01',60,'manual',1,1 FROM json_each(?)`,
    )
    .bind(step.id, JSON.stringify(Array.from({ length: 501 }, (_, index) => index)))
    .run();
  expect(await refusal(await harness.fetch('/api/tasks/v1/focusDays?start_day=2026-09-01&end_day=2026-09-01'))).toBe(
    'FAILED_PRECONDITION',
  );
});

test('a read binding reads Focus and cannot change it', async () => {
  const reader = await harness.mf.getWorker('tasks-read');
  const read = await reader.fetch(
    'https://tasks.internal/api/tasks/v1/focusDays?start_day=2030-10-21&end_day=2030-10-21',
  );
  expect(read.status).toBe(200);
  expect((await reader.fetch('https://tasks.internal/api/tasks/v1/focusTimer')).status).toBe(200);
  const write = await reader.fetch('https://tasks.internal/api/tasks/v1/focusDays:moveStep', {
    method: 'POST',
    body: JSON.stringify({ request_id: randomUUID(), task_id: 'any', destination_day: '2030-10-21' }),
  });
  expect(write.status).toBe(403);
});
