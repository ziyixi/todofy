/**
 * Planning in Tasks (migrations/0006_planning.sql) over workerd's real D1: planning masks, the Sunday rollover with an
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
  MoveFocusStepRequestSchema,
  UpdateTaskRequestSchema,
  UpdateWeeklyBetRequestSchema,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { localDate } from '@ziyixi/task-dates';
import { listFocusDays, moveFocusStep } from '../../src/focus.ts';
import { getPlan, updateWeeklyBet } from '../../src/plan.ts';
import { planningWeekId, planningWeekStart } from '../../src/planning.ts';
import { getTask } from '../../src/task-read.ts';
import { createTask, updateTask } from '../../src/task-write.ts';
import { taskMessage } from '../../src/model.ts';
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
  dependents?: { task_id: string; title: string }[];
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

test('a commitment reads as weekly the Sunday after its week, and a Saturday choice is for the next week', async () => {
  const commit = (title: string, now: number) =>
    createTask(
      harness.db,
      fromWire(CreateTaskRequestSchema, { task: { title, stage: 'committed' }, request_id: randomUUID() }).message,
      now,
      ZONE,
    );
  const tuesday = await commit('Synthetic Tuesday commitment', at('2030-04-16'));
  const sunday = await commit('Synthetic Saturday choice', at('2030-04-20'));
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
  // On Saturday the new choice is next week's; on Monday it is current and the Tuesday one has rolled over.
  expect((await plan('2030-04-20')).nextWeekTaskIds).toContain(sunday.id);
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
  // The Saturday choice still reads as committed that Monday, and a write keeps its week.
  const kept = await update(sunday.id, sunday.etag, 'area', { area: 'personal' }, at('2030-04-22'));
  expect(kept.stage).toBe('committed');
});

test('GetPlan reads the Bets of three weeks, the arranged lanes and next week, in one batch', async () => {
  const today = localDate(Date.now(), ZONE);
  const week = planningWeekId(today);
  // The body is the masked Bet, as the shared client sends it; the etag is a request field.
  const bet = (name: string, text: string, etag = '') =>
    harness.mutate('PATCH', `/api/tasks/v1/weeklyBets/${name}?update_mask=text&etag=${etag}`, { text });
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
    `weeklyBets/${planningWeekId(localDate(Date.now() - 7 * 86_400_000, ZONE))}-personal`,
    `weeklyBets/${week}-work`,
  ]);
});

test('a Bet is a value write: the saved text replays, a stale etag and an ended week are refused', async () => {
  const write = (name: string, text: string, etag: string, now: number) =>
    updateWeeklyBet(
      harness.db,
      fromWire(UpdateWeeklyBetRequestSchema, { weekly_bet: { name: `weeklyBets/${name}`, text }, etag }).message,
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
  expect((await read(venue)).dependents).toEqual([{ task_id: waiter.id, title: waiter.title }]);
  const list = await (
    await harness.fetch(`/api/tasks/v1/tasks?view=all&task_ids=${waiter.id}`)
  ).json<{ tasks: Task[] }>();
  expect(list.tasks[0]?.dependencies).toEqual(both.dependencies);
  expect(list.tasks[0]?.dependents ?? []).toEqual([]);
  const venueList = await (
    await harness.fetch(`/api/tasks/v1/tasks?view=all&task_ids=${venue.id}`)
  ).json<{ tasks: Task[] }>();
  expect(venueList.tasks[0]?.id).toBe(venue.id);
  expect(venueList.tasks[0]?.dependents ?? []).toEqual([]);
  const one = await waitsFor(both, budget.id);
  expect((await read(venue)).dependents ?? []).toEqual([]);
  expect(one.dependencies).toEqual([{ prerequisite_id: budget.id, title: 'Synthetic budget' }]);
  expect(await edges(waiter.id)).toEqual([
    { prerequisite_id: venue.id, baseline_count: 0, deleted: 1 },
    { prerequisite_id: budget.id, baseline_count: 0, deleted: 0 },
  ]);
  // Added again, the removed one comes back as the newest.
  const again = await waitsFor(one, budget.id, venue.id);
  expect(again.dependencies?.map((value) => value.prerequisite_id)).toEqual([budget.id, venue.id]);
  // The generated client leaves an empty set out of the body; the mask still names it.
  const none = await harness.mutate(
    'PATCH',
    `/api/tasks/v1/${again.name}?etag=${again.etag}&request_id=${randomUUID()}&update_mask=dependencies`,
    {},
  );
  expect(none.status, await none.clone().text()).toBe(200);
  expect((await none.json<Task>()).dependencies ?? []).toEqual([]);
  const restored = await waitsFor(await read(waiter), budget.id, venue.id);
  expect(restored.dependencies).toHaveLength(2);
  // A task cannot wait for itself, for a task that waits for it, or for one that is not open.
  expect(await reason(await patch(venue, { dependencies: [{ prerequisite_id: venue.id }] }))).toBe(
    'PRECONDITION_FAILED',
  );
  expect(await reason(await patch(venue, { dependencies: [{ prerequisite_id: waiter.id }] }))).toBe(
    'PRECONDITION_FAILED',
  );
  expect(await reason(await patch(restored, { dependencies: [{ prerequisite_id: 'synthetic-missing' }] }))).toBe(
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

test('a set that keeps a done dependency keeps it done; removed and added again, it waits again', async () => {
  const waiter = await make({ title: 'Synthetic after the next report' });
  const weekly = await make({ title: 'Synthetic recurring report', due_date: '2099-01-05', recurrence: 'every week' });
  await waitsFor(waiter, weekly.id);
  const completed = await harness.mutate('POST', `/api/tasks/v1/${weekly.name}:complete`, {
    etag: weekly.etag,
    request_id: randomUUID(),
  });
  expect(completed.status, await completed.clone().text()).toBe(200);
  const done = { prerequisite_id: weekly.id, title: 'Synthetic recurring report', done: true };
  const kept = await waitsFor(await read(waiter), weekly.id);
  expect(kept.dependencies).toEqual([done]);
  // Plan's restart: the set without it, then with it, which takes the count now as the new baseline.
  const restarted = await waitsFor(await waitsFor(kept), weekly.id);
  expect(restarted.dependencies).toEqual([{ prerequisite_id: weekly.id, title: 'Synthetic recurring report' }]);
  expect(await edges(waiter.id)).toEqual([{ prerequisite_id: weekly.id, baseline_count: 1, deleted: 0 }]);
});

test('a prerequisite in an archived project is done and gives way, and holds again once unarchived', async () => {
  const created = await harness.mutate('POST', `/api/tasks/v1/projects?request_id=${randomUUID()}`, {
    title: 'Synthetic shelved project',
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const project = await created.json<{ id: string; name: string; etag: string }>();
  const archive = async (current: { name: string; etag: string }, archived: boolean) => {
    const response = await harness.mutate(
      'PATCH',
      `/api/tasks/v1/${current.name}?request_id=${randomUUID()}&update_mask=archived&etag=${current.etag}`,
      { archived, etag: current.etag },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json<{ name: string; etag: string }>();
  };
  const shelved = await make({ title: 'Synthetic shelved prerequisite', project_id: project.id });
  const open = await Promise.all(
    Array.from({ length: 5 }, (_, index) => make({ title: `Synthetic open prerequisite ${String(index)}` })),
  );
  const ids = open.map((task) => task.id);
  const full = await waitsFor(await make({ title: 'Synthetic full waiter' }), shelved.id, ...ids.slice(0, 4));
  const other = await waitsFor(await make({ title: 'Synthetic other waiter' }), shelved.id);
  const archived = await archive(project, true);
  expect((await read(full)).dependencies?.[0]).toEqual({
    prerequisite_id: shelved.id,
    title: 'Synthetic shelved prerequisite',
    done: true,
  });
  // As Plan offers it: the shelved one no longer fills the five, so it gives way to a new one.
  const replaced = await waitsFor(await read(full), shelved.id, ...ids);
  expect(replaced.dependencies?.map((value) => value.prerequisite_id)).toEqual(ids);
  await archive(archived, false);
  expect((await read(other)).dependencies).toEqual([
    { prerequisite_id: shelved.id, title: 'Synthetic shelved prerequisite' },
  ]);
});

test('completing a waiter and deleting a prerequisite take their dependencies away', async () => {
  const parent = await make({ title: 'Synthetic parent waiter' });
  const child = await make({ title: 'Synthetic child waiter', parent_id: parent.id });
  const first = await make({ title: 'Synthetic first prerequisite' });
  const second = await make({ title: 'Synthetic second prerequisite' });
  await waitsFor(child, first.id);
  const waiting = await waitsFor(parent, second.id);
  expect((await read(first)).dependents).toEqual([{ task_id: child.id, title: child.title }]);
  expect((await read(second)).dependents).toEqual([{ task_id: parent.id, title: parent.title }]);
  // Completing the parent completes the child too: both wait for nothing any more.
  const done = await harness.mutate('POST', `/api/tasks/v1/${parent.name}:complete`, {
    etag: waiting.etag,
    request_id: randomUUID(),
  });
  expect(done.status).toBe(200);
  expect((await done.json<Task>()).dependencies ?? []).toEqual([]);
  expect((await read(first)).dependents ?? []).toEqual([]);
  expect((await read(second)).dependents ?? []).toEqual([]);
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

test('reverse links show current direct dependents and disappear when their edge or task is deleted', async () => {
  const prerequisite = await make({ title: 'Synthetic reverse prerequisite' });
  const direct = await waitsFor(await make({ title: 'Synthetic direct waiter' }), prerequisite.id);
  const downstream = await waitsFor(await make({ title: 'Synthetic transitive waiter' }), direct.id);
  expect((await read(prerequisite)).dependents).toEqual([{ task_id: direct.id, title: direct.title }]);
  expect((await read(direct)).dependents).toEqual([{ task_id: downstream.id, title: downstream.title }]);
  const renamed = await saved(direct, { title: 'Synthetic renamed direct waiter' });
  expect((await read(prerequisite)).dependents).toEqual([{ task_id: direct.id, title: renamed.title }]);
  const unlinked = await waitsFor(renamed);
  expect((await read(prerequisite)).dependents ?? []).toEqual([]);
  const linked = await waitsFor(unlinked, prerequisite.id);
  const removed = await harness.mutate(
    'DELETE',
    `/api/tasks/v1/${linked.name}?etag=${linked.etag}&request_id=${randomUUID()}`,
  );
  expect(removed.status).toBe(200);
  expect((await read(prerequisite)).dependents ?? []).toEqual([]);
});

test('archiving and restoring a dependent project hides and restores its reverse links', async () => {
  const created = await harness.mutate('POST', `/api/tasks/v1/projects?request_id=${randomUUID()}`, {
    title: 'Synthetic reverse-link project',
  });
  expect(created.status).toBe(200);
  const project = await created.json<{ id: string; name: string; etag: string }>();
  const prerequisite = await make({ title: 'Synthetic outside prerequisite' });
  const waiter = await waitsFor(
    await make({ title: 'Synthetic project waiter', project_id: project.id }),
    prerequisite.id,
  );
  expect((await read(prerequisite)).dependents).toEqual([{ task_id: waiter.id, title: waiter.title }]);
  let current = project;
  for (const archived of [true, false]) {
    const response = await harness.mutate(
      'PATCH',
      `/api/tasks/v1/${current.name}?request_id=${randomUUID()}&update_mask=archived&etag=${current.etag}`,
      { archived },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    current = await response.json<typeof project>();
    expect((await read(prerequisite)).dependents ?? []).toEqual(
      archived ? [] : [{ task_id: waiter.id, title: waiter.title }],
    );
  }
});

test('GetTask filters stale reverse edges by dependent state and seeks the existing prerequisite index', async () => {
  const prerequisite = await make({ title: 'Synthetic indexed prerequisite' });
  const waiter = await waitsFor(await make({ title: 'Synthetic retained edge' }), prerequisite.id);
  for (const column of ['completed', 'deleted_at', 'project_archived'] as const) {
    // Historical/stale edges cannot expose a hidden task even before edge cleanup runs.
    await harness.db.prepare(`UPDATE tasks SET ${column}=1 WHERE id=?`).bind(waiter.id).run();
    expect((await read(prerequisite)).dependents ?? []).toEqual([]);
    await harness.db
      .prepare(`UPDATE tasks SET ${column}=? WHERE id=?`)
      .bind(column === 'deleted_at' ? null : 0, waiter.id)
      .run();
  }
  expect((await read(prerequisite)).dependents).toEqual([{ task_id: waiter.id, title: waiter.title }]);
  let statement = '';
  const traced = {
    prepare(sql: string) {
      statement = sql;
      return harness.db.prepare(sql);
    },
  } as D1Database;
  await getTask(traced, prerequisite.id);
  const plan = await harness.db
    .prepare(`EXPLAIN QUERY PLAN ${statement}`)
    .bind(prerequisite.id)
    .all<{ detail: string }>();
  const detail = plan.results.map((row) => row.detail).join('\n');
  expect(detail).toMatch(/SEARCH d USING INDEX task_dependencies_prerequisite \(prerequisite_id=\?\)/);
  expect(detail).not.toMatch(/SCAN d\b/);
});

test('client-supplied dependents cannot create or replace reverse links', async () => {
  const real = await make({ title: 'Synthetic real dependent' });
  const task = await make({
    title: 'Synthetic copied task',
    dependents: [{ task_id: real.id, title: 'Synthetic fabricated reverse link' }],
  });
  expect(task.dependents ?? []).toEqual([]);
  expect((await read(task)).dependents ?? []).toEqual([]);
  expect(await edges(real.id)).toEqual([]);
  const waiter = await waitsFor(real, task.id);
  expect(await reason(await patch(await read(task), { dependents: [] }))).toBe('BAD_REQUEST');
  expect((await read(task)).dependents).toEqual([{ task_id: waiter.id, title: waiter.title }]);
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
    '2030-04-21',
    '2030-04-22',
    '2030-04-23',
    '2030-04-24',
    '2030-04-25',
    '2030-04-26',
    '2030-04-27',
  ]);
  expect(sunday.today).toBe('2030-04-21');
  // The generated client sends the two REQUIRED days, empty.
  const response = await harness.fetch('/api/tasks/v1/focusDays?start_day=&end_day=');
  expect(response.status, await response.clone().text()).toBe(200);
  const week = await response.json<{ days: { day: string }[]; today: string }>();
  expect(week.days[0]?.day).toBe(planningWeekStart(week.today));
  expect(week.days).toHaveLength(7);
  expect(await reason(await harness.fetch('/api/tasks/v1/focusDays?start_day=2030-04-15'))).toBe('BAD_REQUEST');
});

test('Pacific Saturday midnight advances the planning ID, preserves goals and queues, and Monday does not roll again', async () => {
  const saturday = Date.parse('2030-04-21T06:59:59Z');
  const sunday = Date.parse('2030-04-21T07:00:00Z');
  const monday = Date.parse('2030-04-22T07:00:00Z');
  expect(localDate(saturday, ZONE)).toBe('2030-04-20');
  expect(localDate(sunday, ZONE)).toBe('2030-04-21');
  const task = await createTask(
    harness.db,
    fromWire(CreateTaskRequestSchema, {
      task: {
        title: 'Synthetic retained Saturday choice',
        stage: 'committed',
        planning_flags: ['task'],
      },
      request_id: randomUUID(),
    }).message,
    saturday,
    ZONE,
  );
  await moveFocusStep(
    harness.db,
    create(MoveFocusStepRequestSchema, {
      taskId: task.id,
      destinationDay: '2030-04-22',
      requestId: randomUUID(),
    }),
    saturday,
  );
  const goalName = 'weeklyBets/2030-04-22-work';
  const oldGoal = await harness.db
    .prepare("SELECT revision FROM weekly_bets WHERE week_start='2030-04-22' AND area='work'")
    .first<{ revision: number }>();
  const goal = await updateWeeklyBet(
    harness.db,
    fromWire(UpdateWeeklyBetRequestSchema, {
      weekly_bet: { name: goalName, text: 'Synthetic saved next week goal' },
      update_mask: 'text',
      etag: oldGoal ? String(oldGoal.revision) : '',
    }).message,
    ZONE,
    saturday,
  );
  const planAt = (now: number) => getPlan(harness.db, create(GetPlanRequestSchema, { name: 'plan' }), ZONE, now);
  expect((await planAt(saturday)).weekStart).toBe('2030-04-15');
  expect((await planAt(saturday)).nextWeekTaskIds).toContain(task.id);
  for (const now of [sunday, monday]) {
    const plan = await planAt(now);
    expect(plan.weekStart).toBe('2030-04-22');
    expect(plan.nextWeekTaskIds).not.toContain(task.id);
    expect(plan.weeklyBets.find((bet) => bet.name === goalName)).toEqual(goal);
    const days = await listFocusDays(harness.db, create(ListFocusDaysRequestSchema, {}), ZONE, now);
    expect(days.days[0]?.day).toBe('2030-04-21');
    expect(days.days.at(-1)?.day).toBe('2030-04-27');
    expect(days.days.find((day) => day.day === '2030-04-22')?.taskIds).toContain(task.id);
  }
  const stored = await getTask(harness.db, task.id);
  expect([stored.stage, stored.committed_week]).toEqual(['committed', '2030-04-22']);
  const earlier = await createTask(
    harness.db,
    fromWire(CreateTaskRequestSchema, {
      task: { title: 'Synthetic expired weekly choice', stage: 'committed' },
      request_id: randomUUID(),
    }).message,
    at('2030-04-16'),
    ZONE,
  );
  const earlierRow = await getTask(harness.db, earlier.id);
  expect(taskMessage(earlierRow, localDate(saturday, ZONE)).stage).toBe('committed');
  expect(taskMessage(earlierRow, localDate(sunday, ZONE)).stage).toBe('weekly');
  const chosen = await createTask(
    harness.db,
    fromWire(CreateTaskRequestSchema, {
      task: {
        title: 'Synthetic Sunday current-week choice',
        stage: 'committed',
      },
      request_id: randomUUID(),
    }).message,
    sunday,
    ZONE,
  );
  const chosenRow = await getTask(harness.db, chosen.id);
  expect(chosenRow.committed_week).toBe('2030-04-22');
  expect(taskMessage(chosenRow, localDate(monday, ZONE)).stage).toBe('committed');
});
