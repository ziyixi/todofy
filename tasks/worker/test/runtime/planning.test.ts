/**
 * Planning in Tasks (migrations/0006_planning.sql) over workerd's real D1: planning masks, the Monday rollover with an
 * injected clock, GetPlan, dependencies and their in-batch guard, a Review lane's order and Bets. Synthetic rows only.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { fromWire } from '@ziyixi/proto/wire-json';
import {
  CreateTaskRequestSchema,
  GetPlanRequestSchema,
  ListFocusDaysRequestSchema,
  UpdateTaskRequestSchema,
  UpdateWeeklyBetRequestSchema,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { localDate } from '@ziyixi/task-dates';
import { listFocusDays } from '../../src/focus.ts';
import { getPlan, updateWeeklyBet } from '../../src/plan.ts';
import { mondayOf } from '../../src/planning.ts';
import { createTask, updateTask } from '../../src/task-write.ts';
import { startHarness, type Harness } from './harness.ts';

const ZONE = 'America/Los_Angeles';
/** Noon in the account zone of a day: Monday 2030-04-15 to Sunday 2030-04-21, then Monday 2030-04-22. */
const at = (day: string) => Date.parse(`${day}T19:00:00Z`);

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.dispose();
});

interface Dependency {
  prerequisite_id: string;
  title?: string;
  done?: boolean;
}
interface Task {
  id: string;
  name: string;
  etag: string;
  title: string;
  stage?: string;
  board_stage?: string;
  area?: string;
  lead_days?: number;
  planning_flags?: string[];
  deadline?: string;
  must_start?: boolean;
  missing_lead?: boolean;
  dependencies?: Dependency[];
  completed?: boolean;
  completed_count?: number;
}
async function make(fields: Record<string, unknown>): Promise<Task> {
  const response = await harness.mutate('POST', `/api/tasks/v1/tasks?request_id=${randomUUID()}`, fields);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<Task>();
}
async function read(task: Pick<Task, 'name'>): Promise<Task> {
  return (await harness.fetch(`/api/tasks/v1/${task.name}`)).json<Task>();
}
function patch(task: Pick<Task, 'name' | 'etag'>, fields: Record<string, unknown>, requestId = randomUUID()) {
  return harness.mutate(
    'PATCH',
    `/api/tasks/v1/${task.name}?etag=${task.etag}&request_id=${requestId}&update_mask=${Object.keys(fields).join(',')}`,
    fields,
  );
}
async function saved(task: Pick<Task, 'name' | 'etag'>, fields: Record<string, unknown>): Promise<Task> {
  const response = await patch(task, fields);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<Task>();
}
async function reason(response: Response): Promise<string> {
  const body = await response.json<{ error: { details?: { reason?: string }[] } }>();
  return body.error.details?.find((detail) => detail.reason)?.reason ?? '';
}
const waitsFor = (task: Pick<Task, 'name' | 'etag'>, ...ids: string[]) =>
  saved(task, { dependencies: ids.map((id) => ({ prerequisite_id: id })) });
async function edges(taskId: string) {
  return (
    await harness.db
      .prepare(
        'SELECT prerequisite_id,baseline_count,deleted_at IS NOT NULL AS deleted FROM task_dependencies WHERE task_id=? ORDER BY created_at,rowid',
      )
      .bind(taskId)
      .all<{ prerequisite_id: string; baseline_count: number; deleted: number }>()
  ).results;
}

test('0006 keeps every existing task, revision and receipt, and gives them no planning facts', () => {
  const directory = join(dirname(fileURLToPath(import.meta.url)), '../../../migrations/');
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const db = new DatabaseSync(':memory:');
  for (const file of files.filter((name) => name < '0006')) db.exec(readFileSync(`${directory}${file}`, 'utf8'));
  db.exec(
    "INSERT INTO tasks(id,title,deadline,revision,created_at,updated_at) VALUES('existing','Synthetic','2030-04-19',4,1,2)",
  );
  db.exec("INSERT INTO requests(id,fingerprint,response,created_at,revision_guard) VALUES('old','f','{}',1,1)");
  db.exec(readFileSync(`${directory}0006_planning.sql`, 'utf8'));
  expect(
    db.prepare('SELECT revision,updated_at,stage,committed_week,area,lead_days,planning_flags FROM tasks').get(),
  ).toEqual({
    revision: 4,
    updated_at: 2,
    stage: 'none',
    committed_week: '',
    area: 'unassigned',
    lead_days: 0,
    planning_flags: '[]',
  });
  expect(db.prepare('SELECT count(*) AS n FROM requests').get()).toEqual({ n: 1 });
  expect(db.prepare('SELECT id,lanes,revision FROM plan_board').all()).toEqual([
    { id: 'board', lanes: '{}', revision: 1 },
  ]);
});

test('planning fields are written by mask under the etag, replay exactly and refuse a stale etag', async () => {
  const task = await make({ title: 'Synthetic planned outcome', deadline: '2099-01-10' });
  expect(task).toMatchObject({ stage: 'none', area: 'unassigned', board_stage: 'none', missing_lead: true });
  const requestId = randomUUID();
  const fields = { stage: 'monthly', area: 'work', planning_flags: ['quick', 'waiting'], lead_days: 7 };
  const first = await patch(task, fields, requestId);
  expect(first.status, await first.clone().text()).toBe(200);
  const written = await first.json<Task>();
  expect(written).toMatchObject({
    etag: '2',
    // A Quick task's month reads as no stage; quick is a standalone action.
    stage: 'none',
    area: 'work',
    lead_days: 7,
    planning_flags: ['quick', 'waiting', 'task'],
  });
  // The wire profile leaves out false and zero.
  expect(written.missing_lead).toBeUndefined();
  expect(await (await patch(task, fields, requestId)).json()).toEqual(written);
  expect(await reason(await patch(task, { area: 'personal' }))).toBe('ETAG_MISMATCH');
  expect(await reason(await patch(written, { planning_flags: ['blocked'] }))).toBe('BAD_REQUEST');
  expect(await reason(await patch(written, { stage: 'someday' }))).toBe('BAD_REQUEST');
  // Clearing the deadline clears the lead days in the same write; parking clears the stage and in progress.
  const cleared = await saved(written, { deadline: '', planning_flags: ['active', 'parked'], stage: 'weekly' });
  expect(cleared).toMatchObject({ stage: 'none', planning_flags: ['parked'] });
  expect(cleared.lead_days ?? 0).toBe(0);
  expect(await read(cleared)).toEqual(cleared);
});

test('a commitment reads as weekly the Monday after its week, and a Sunday choice is for the next week', async () => {
  const commit = (title: string, now: number) =>
    createTask(
      harness.db,
      fromWire(CreateTaskRequestSchema, { task: { title, stage: 'committed' }, request_id: randomUUID() }).message,
      now,
      ZONE,
    );
  const tuesday = await commit('Synthetic Tuesday commitment', at('2030-04-16'));
  const sunday = await commit('Synthetic Sunday choice', at('2030-04-21'));
  const weeks = await harness.db
    .prepare('SELECT id,committed_week FROM tasks WHERE id IN (?,?) ORDER BY committed_week')
    .bind(tuesday.id, sunday.id)
    .all<{ id: string; committed_week: string }>();
  expect(weeks.results).toEqual([
    { id: tuesday.id, committed_week: '2030-04-15' },
    { id: sunday.id, committed_week: '2030-04-22' },
  ]);
  const plan = async (day: string) =>
    getPlan(harness.db, create(GetPlanRequestSchema, { name: 'plan' }), ZONE, at(day));
  // On Sunday the Sunday choice is next week's; on Monday it is this week's, and the Tuesday one has rolled over.
  expect((await plan('2030-04-21')).nextWeekTaskIds).toContain(sunday.id);
  const monday = await plan('2030-04-22');
  expect(monday.nextWeekTaskIds).not.toContain(sunday.id);
  const update = (id: string, etag: string, mask: string, task: Record<string, unknown>, now: number) =>
    updateTask(
      harness.db,
      fromWire(UpdateTaskRequestSchema, {
        task: { name: `tasks/${id}`, ...task },
        etag,
        update_mask: mask,
        request_id: randomUUID(),
      }).message,
      now,
      ZONE,
    );
  // The next write of the rolled-over one, on any field, stores it as weekly.
  const edited = await update(tuesday.id, tuesday.etag, 'area', { area: 'work' }, at('2030-04-22'));
  expect([edited.stage, edited.boardStage]).toEqual(['weekly', 'weekly']);
  const stored = await harness.db.prepare('SELECT stage,committed_week FROM tasks WHERE id=?').bind(tuesday.id).first();
  expect(stored).toEqual({ stage: 'weekly', committed_week: '' });
  // The Sunday choice still reads as committed that Monday, and a write keeps its week.
  const kept = await update(sunday.id, sunday.etag, 'area', { area: 'personal' }, at('2030-04-22'));
  expect(kept.stage).toBe('committed');
});

test('GetPlan reads the Bets of three weeks, the arranged lanes and next week, in one batch', async () => {
  const today = localDate(Date.now(), ZONE);
  const week = mondayOf(today);
  const bet = (name: string, text: string, etag = '') =>
    harness.mutate('PATCH', `/api/tasks/v1/weeklyBets/${name}?update_mask=text`, {
      name: `weeklyBets/${name}`,
      text,
      etag,
    });
  const work = await bet(`${week}-work`, '  Ship the\nsynthetic draft ');
  expect(work.status, await work.clone().text()).toBe(200);
  expect(await work.json()).toMatchObject({
    name: `weeklyBets/${week}-work`,
    week_start: week,
    area: 'work',
    text: 'Ship the synthetic draft',
    etag: '1',
  });
  await harness.db
    .prepare(
      "INSERT INTO weekly_bets(week_start,area,text,created_at,updated_at) VALUES(date(?,'-7 days'),'personal','Last week',1,1),(date(?,'+14 days'),'work','Too far',1,1)",
    )
    .bind(week, week)
    .run();
  const plan = await (
    await harness.fetch('/api/tasks/v1/plan')
  ).json<{
    name: string;
    today: string;
    week_start: string;
    time_zone: string;
    weekly_bets: { name: string }[];
    lane_orders?: unknown[];
  }>();
  expect(plan).toMatchObject({ name: 'plan', today, week_start: week, time_zone: ZONE });
  expect(plan.weekly_bets.map((value) => value.name)).toEqual([
    `weeklyBets/${mondayOf(localDate(Date.now() - 7 * 86_400_000, ZONE))}-personal`,
    `weeklyBets/${week}-work`,
  ]);
});

test('a Bet is a value write: the saved text replays, a stale etag and an ended week are refused', async () => {
  const write = (name: string, text: string, etag: string, now: number) =>
    updateWeeklyBet(
      harness.db,
      fromWire(UpdateWeeklyBetRequestSchema, { weekly_bet: { name: `weeklyBets/${name}`, text, etag } }).message,
      ZONE,
      now,
    );
  const saturday = at('2030-04-20');
  const created = await write('2030-04-15-personal', 'Run 10k', '', saturday);
  expect([created.text, created.etag]).toEqual(['Run 10k', '1']);
  expect(await write('2030-04-15-personal', ' Run  10k ', 'stale', saturday)).toEqual(created);
  await expect(write('2030-04-15-personal', 'Run 5k', '', saturday)).rejects.toMatchObject({ reason: 'ETAG_MISMATCH' });
  const cleared = await write('2030-04-15-personal', '', '1', saturday);
  expect([cleared.text, cleared.etag]).toEqual(['', '2']);
  // Next week takes a write; the week after, and an ended week, do not; a late replay still answers.
  expect((await write('2030-04-22-work', 'Next week', '', saturday)).etag).toBe('1');
  await expect(write('2030-04-29-work', 'Too early', '', saturday)).rejects.toMatchObject({
    reason: 'PRECONDITION_FAILED',
  });
  await expect(write('2030-04-15-personal', 'After the end', '2', at('2030-04-22'))).rejects.toMatchObject({
    reason: 'PRECONDITION_FAILED',
  });
  expect(await write('2030-04-15-personal', '', '2', at('2030-04-22'))).toEqual(cleared);
  for (const name of ['2030-04-16-work', '2030-04-15-office', '2030-W16-work'])
    await expect(write(name, 'x', '', saturday)).rejects.toMatchObject({ reason: 'BAD_REQUEST' });
});

test('dependencies are added and removed as a set, with titles and done, and touch the task', async () => {
  const waiter = await make({ title: 'Synthetic launch' });
  const venue = await make({ title: 'Synthetic venue' });
  const budget = await make({ title: 'Synthetic budget' });
  const both = await waitsFor(waiter, venue.id, budget.id);
  expect(both.etag).toBe('2');
  expect(both.dependencies).toEqual([
    { prerequisite_id: venue.id, title: 'Synthetic venue' },
    { prerequisite_id: budget.id, title: 'Synthetic budget' },
  ]);
  expect((await read(waiter)).dependencies).toEqual(both.dependencies);
  const list = await (
    await harness.fetch(`/api/tasks/v1/tasks?view=all&task_ids=${waiter.id}`)
  ).json<{ tasks: Task[] }>();
  expect(list.tasks[0]?.dependencies).toEqual(both.dependencies);
  const one = await waitsFor(both, budget.id);
  expect(one.dependencies).toEqual([{ prerequisite_id: budget.id, title: 'Synthetic budget' }]);
  expect(await edges(waiter.id)).toEqual([
    { prerequisite_id: venue.id, baseline_count: 0, deleted: 1 },
    { prerequisite_id: budget.id, baseline_count: 0, deleted: 0 },
  ]);
  // Added again, the removed one comes back as the newest.
  const again = await waitsFor(one, budget.id, venue.id);
  expect(again.dependencies?.map((value) => value.prerequisite_id)).toEqual([budget.id, venue.id]);
  // A task cannot wait for itself, for a task that waits for it, or for one that is not open.
  expect(await reason(await patch(venue, { dependencies: [{ prerequisite_id: venue.id }] }))).toBe(
    'PRECONDITION_FAILED',
  );
  expect(await reason(await patch(venue, { dependencies: [{ prerequisite_id: waiter.id }] }))).toBe(
    'PRECONDITION_FAILED',
  );
  expect(await reason(await patch(again, { dependencies: [{ prerequisite_id: 'synthetic-missing' }] }))).toBe(
    'PRECONDITION_FAILED',
  );
  expect((await read(venue)).etag).toBe('1');
  const closed = await harness.mutate('POST', `/api/tasks/v1/${budget.name}:complete`, {
    etag: budget.etag,
    request_id: randomUUID(),
  });
  expect(await reason(await patch(await closed.json<Task>(), { dependencies: [{ prerequisite_id: venue.id }] }))).toBe(
    'PRECONDITION_FAILED',
  );
});

test('a task waits for at most five; the oldest done one gives way', async () => {
  const waiter = await make({ title: 'Synthetic many' });
  const prerequisites = await Promise.all(
    Array.from({ length: 6 }, (_, index) => make({ title: `Synthetic prerequisite ${String(index)}` })),
  );
  const ids = prerequisites.map((task) => task.id);
  const five = await waitsFor(waiter, ...ids.slice(0, 5));
  expect(await reason(await patch(five, { dependencies: ids.map((id) => ({ prerequisite_id: id })) }))).toBe(
    'PRECONDITION_FAILED',
  );
  const done = prerequisites[1];
  if (!done) throw new Error('Missing synthetic prerequisite');
  const completed = await harness.mutate('POST', `/api/tasks/v1/${done.name}:complete`, {
    etag: done.etag,
    request_id: randomUUID(),
  });
  expect(completed.status).toBe(200);
  const current = await read(five);
  expect(current.dependencies?.find((value) => value.prerequisite_id === done.id)?.done).toBe(true);
  const six = await waitsFor(current, ...ids);
  expect(six.dependencies?.map((value) => value.prerequisite_id)).toEqual(
    [...ids.slice(0, 5), ids[5]].filter((id) => id !== done.id),
  );
});

test('two tabs cannot build a cycle between them: the in-batch guard refuses the second and writes nothing', async () => {
  const a = await make({ title: 'Synthetic tab A' });
  const b = await make({ title: 'Synthetic tab B' });
  // Tab two read before tab one saved, so its own check passes; the batch then sees tab one's dependency.
  const raced = {
    prepare: (sql: string) => harness.db.prepare(sql),
    async batch(statements: D1PreparedStatement[]) {
      if (statements.length > 3) await waitsFor(a, b.id);
      return harness.db.batch(statements);
    },
  } as unknown as D1Database;
  const request = fromWire(UpdateTaskRequestSchema, {
    task: { name: b.name, dependencies: [{ prerequisite_id: a.id }] },
    etag: b.etag,
    update_mask: 'dependencies',
    request_id: randomUUID(),
  }).message;
  await expect(updateTask(raced, request, Date.now(), ZONE)).rejects.toMatchObject({ reason: 'PRECONDITION_FAILED' });
  expect(await edges(b.id)).toEqual([]);
  expect((await read(b)).etag).toBe('1');
  expect(await harness.db.prepare('SELECT id FROM requests WHERE id=?').bind(request.requestId).first()).toBeNull();
});

test('a recurring prerequisite is done after its next completion, and a reopened one holds again', async () => {
  const waiter = await make({ title: 'Synthetic after the weekly report' });
  const weekly = await make({ title: 'Synthetic weekly report', due_date: '2099-01-05', recurrence: 'every week' });
  const plain = await make({ title: 'Synthetic one-off' });
  const linked = await waitsFor(waiter, weekly.id, plain.id);
  expect(linked.dependencies?.map((value) => value.done ?? false)).toEqual([false, false]);
  const complete = async (task: Task) => {
    const response = await harness.mutate('POST', `/api/tasks/v1/${task.name}:complete`, {
      etag: (await read(task)).etag,
      request_id: randomUUID(),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json<Task>();
  };
  await complete(weekly);
  const advanced = await read(weekly);
  expect([advanced.completed ?? false, advanced.completed_count]).toEqual([false, 1]);
  const closed = await complete(plain);
  expect((await read(waiter)).dependencies?.map((value) => value.done)).toEqual([true, true]);
  const reopened = await harness.mutate('POST', `/api/tasks/v1/${plain.name}:reopen`, {
    etag: closed.etag,
    request_id: randomUUID(),
  });
  expect(reopened.status).toBe(200);
  expect((await read(waiter)).dependencies?.map((value) => value.done ?? false)).toEqual([true, false]);
});

test('completing a waiter and deleting a prerequisite take their dependencies away', async () => {
  const parent = await make({ title: 'Synthetic parent waiter' });
  const child = await make({ title: 'Synthetic child waiter', parent_id: parent.id });
  const first = await make({ title: 'Synthetic first prerequisite' });
  const second = await make({ title: 'Synthetic second prerequisite' });
  await waitsFor(child, first.id);
  const waiting = await waitsFor(parent, second.id);
  // Completing the parent completes the child too: both wait for nothing any more.
  const done = await harness.mutate('POST', `/api/tasks/v1/${parent.name}:complete`, {
    etag: waiting.etag,
    request_id: randomUUID(),
  });
  expect(done.status).toBe(200);
  expect((await done.json<Task>()).dependencies ?? []).toEqual([]);
  expect([...(await edges(parent.id)), ...(await edges(child.id))].every((edge) => edge.deleted)).toBe(true);
  const other = await make({ title: 'Synthetic other waiter' });
  const linked = await waitsFor(other, first.id);
  const removed = await harness.mutate(
    'DELETE',
    `/api/tasks/v1/${first.name}?etag=${first.etag}&request_id=${randomUUID()}`,
  );
  expect(removed.status).toBe(200);
  expect((await read(linked)).dependencies ?? []).toEqual([]);
  expect((await edges(other.id)).every((edge) => edge.deleted)).toBe(true);
});

test("a Review lane's order is saved with no positions, and with positions in the same write", async () => {
  const [one, two, three] = await Promise.all(
    ['Synthetic lane one', 'Synthetic lane two', 'Synthetic lane three'].map((title) => make({ title })),
  );
  if (!one || !two || !three) throw new Error('Missing synthetic tasks');
  const reorder = (body: Record<string, unknown>) =>
    harness.mutate('POST', '/api/tasks/v1/tasks:reorder', { positions: [], request_id: randomUUID(), ...body });
  const waiting = await reorder({ lane_order: { lane: 'waiting', task_ids: [two.id, one.id, two.id] } });
  expect(waiting.status, await waiting.clone().text()).toBe(200);
  expect(await waiting.json()).toEqual({ lane_order: { lane: 'waiting', task_ids: [two.id, one.id] } });
  expect((await read(one)).etag).toBe('1');
  const positions = [one, three].map((task, index) => ({ name: task.name, etag: task.etag, sort_order: 50 - index }));
  const moved = await reorder({ positions, lane_order: { lane: 'weekly', task_ids: [three.id, one.id] } });
  expect(moved.status, await moved.clone().text()).toBe(200);
  const answer = await moved.json<{ tasks: Task[]; lane_order: unknown }>();
  expect(answer.tasks.map((task) => [task.id, task.etag])).toEqual([
    [one.id, '2'],
    [three.id, '2'],
  ]);
  expect(answer.lane_order).toEqual({ lane: 'weekly', task_ids: [three.id, one.id] });
  const plan = await (await harness.fetch('/api/tasks/v1/plan')).json<{ lane_orders: unknown[] }>();
  // A task is in one lane: arranging Week took the first task out of Waiting.
  expect(plan.lane_orders).toEqual(
    expect.arrayContaining([
      { lane: 'waiting', task_ids: [two.id] },
      { lane: 'weekly', task_ids: [three.id, one.id] },
    ]),
  );
  expect(await reason(await reorder({ lane_order: { lane: 'someday', task_ids: [] } }))).toBe('BAD_REQUEST');
  expect(await reason(await reorder({}))).toBe('BAD_REQUEST');
});

test("ListFocusDays without a range reads the week of Tasks' today", async () => {
  const sunday = await listFocusDays(harness.db, create(ListFocusDaysRequestSchema, {}), ZONE, at('2030-04-21'));
  expect(sunday.days.map((day) => day.day)).toEqual([
    '2030-04-15',
    '2030-04-16',
    '2030-04-17',
    '2030-04-18',
    '2030-04-19',
    '2030-04-20',
    '2030-04-21',
  ]);
  expect(sunday.today).toBe('2030-04-21');
  // The generated client sends the two REQUIRED days, empty.
  const response = await harness.fetch('/api/tasks/v1/focusDays?start_day=&end_day=');
  expect(response.status, await response.clone().text()).toBe(200);
  const week = await response.json<{ days: { day: string }[]; today: string }>();
  expect(week.days[0]?.day).toBe(mondayOf(week.today));
  expect(week.days).toHaveLength(7);
  expect(await reason(await harness.fetch('/api/tasks/v1/focusDays?start_day=2030-04-15'))).toBe('BAD_REQUEST');
});
