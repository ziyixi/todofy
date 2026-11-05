import { randomUUID } from 'node:crypto';
import { stdout } from 'node:process';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { FocusEntrySchema } from '@ziyixi/proto/tasks/ui/v1/focus_pb';
import { ProjectSchema, SectionSchema } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import {
  CommandFocusTimerRequest_Action as Action,
  CommandFocusTimerRequestSchema,
  CompleteTaskRequestSchema,
  GetFocusTimerRequestSchema,
  GetPlanRequestSchema,
  ListFocusDaysRequestSchema,
  ListTasksRequestSchema,
  MoveFocusStepRequestSchema,
  UpdateFocusEntryRequestSchema,
  UpdateProjectRequestSchema,
  UpdateSectionRequestSchema,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { addDays, localDate } from '@ziyixi/task-dates';
import { getCatalog, saveCatalog } from '../../src/catalog.ts';
import { listFocusDays, moveFocusStep } from '../../src/focus.ts';
import { updateFocusEntry } from '../../src/focus-entries.ts';
import { commandFocusTimer, getFocusTimer } from '../../src/focus-timer.ts';
import { getPlan } from '../../src/plan.ts';
import { getTask, listTasks } from '../../src/task-read.ts';
import { completeTask } from '../../src/task-write.ts';
import { seedWorstWeek, WEEK_ENTRIES, WEEK_STEPS } from './focus-week.ts';
import { measuredReads, startHarness, type Harness } from './harness.ts';

const ZONE = 'America/Los_Angeles';
const NOW = Date.parse('2030-04-15T18:00:00Z');
const MINUTE = 60_000;
let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
  await harness.db.batch([
    harness.db.prepare(
      "INSERT INTO projects(id,title,created_at,updated_at) VALUES('budget-project','Synthetic budget project',1,1)",
    ),
    harness.db.prepare(
      "INSERT INTO sections(id,title,project_id,created_at,updated_at) VALUES('budget-section','Synthetic section','budget-project',1,1)",
    ),
    harness.db.prepare(
      "INSERT INTO labels(id,title,created_at,updated_at) VALUES('budget-label','Synthetic budget label',1,1)",
    ),
  ]);
  await addTasks('inbox', 11, { completed: 0 });
  await addTasks('recurring', 10, { completed: 0, due: '2030-04-15', recurrence: 'every day' });
  await addTasks('section', 100, { completed: 0, project: 'budget-project', section: 'budget-section' });
  await addHistory(1);
});
afterAll(async () => {
  await harness.dispose();
});

async function addTasks(
  prefix: string,
  count: number,
  fields: { completed: number; due?: string; recurrence?: string; project?: string; section?: string },
) {
  // Interleave open and completed rows in one sort order, as imported history is.
  const data = Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index)}`,
    order: index * 2 + 1,
  }));
  await harness.db
    .prepare(
      `INSERT INTO tasks(id,title,project_id,section_id,completed,due_date,recurrence,label_ids,sort_order,created_at,updated_at)
       SELECT value->>'id','Synthetic read budget task',?,?,?,?,?,'["budget-label"]',value->>'order',1,1 FROM json_each(?)`,
    )
    .bind(
      fields.project ?? '',
      fields.section ?? '',
      fields.completed,
      fields.due ?? '',
      fields.recurrence ?? '',
      JSON.stringify(data),
    )
    .run();
}
/** Completed roots in the Inbox, and imported occurrences of every recurring task. */
async function addHistory(round: number) {
  await addTasks(`history-${String(round)}`, 2000, { completed: 1 });
  await harness.db
    .prepare(
      `INSERT INTO completions(id,task_id,title,completed_at,imported)
       SELECT 'imported-${String(round)}-' || t.id || '-' || n.value,t.id,t.title,1,1
       FROM tasks t, json_each(?) n WHERE t.id LIKE 'recurring-%'`,
    )
    .bind(JSON.stringify(Array.from({ length: 250 }, (_, index) => index)))
    .run();
}
async function revision(table: string, id: string): Promise<string> {
  const row = await harness.db
    .prepare(`SELECT revision FROM ${table} WHERE id=?`)
    .bind(id)
    .first<{ revision: number }>();
  return String(row?.revision);
}
async function measure(read: (db: D1Database) => Promise<unknown>) {
  const measured = measuredReads(harness.db);
  await read(measured.db);
  return measured.metrics;
}
const list = (db: D1Database, fields: Parameters<typeof create<typeof ListTasksRequestSchema>>[1]) =>
  listTasks(db, create(ListTasksRequestSchema, fields), ZONE, NOW);

test('Inbox, Today and a recurring task read the same rows when completed history doubles', async () => {
  const reads = {
    inbox: (db: D1Database) => list(db, { view: 'inbox', pageSize: 100 }),
    today: (db: D1Database) => list(db, { view: 'today', date: '2030-04-15', pageSize: 100 }),
    recurring: (db: D1Database) => getTask(db, 'recurring-0'),
  };
  const before = {
    inbox: await measure(reads.inbox),
    today: await measure(reads.today),
    recurring: await measure(reads.recurring),
  };
  expect((await reads.inbox(harness.db)).tasks).toHaveLength(21);
  expect((await reads.recurring(harness.db)).completed_count).toBe(0);
  await addHistory(2);
  for (const name of ['inbox', 'today', 'recurring'] as const) {
    const after = await measure(reads[name]);
    stdout.write(
      JSON.stringify({ event: 'tasks_read_history_growth', read: name, before: before[name], after }) + '\n',
    );
    expect(after.rowsWritten, name).toBe(0);
    expect(Math.abs(after.rowsRead - before[name].rowsRead), name).toBeLessThanOrEqual(2);
  }
});

test('a later page and an ID lookup seek their index', async () => {
  const first = await list(harness.db, { view: 'all', pageSize: 50 });
  expect(first.nextPageToken).not.toBe('');
  const opening = await measure((db) => list(db, { view: 'all', pageSize: 50 }));
  const page = await measure((db) => list(db, { view: 'all', pageSize: 50, pageToken: first.nextPageToken }));
  const lookup = await measure((db) => list(db, { view: 'all', taskIds: ['section-99'] }));
  stdout.write(JSON.stringify({ event: 'tasks_read_page_and_lookup', opening, page, lookup }) + '\n');
  // A later page reads what the first does, not every row before its cursor. Each row is about two: itself and its
  // dependencies' seek, which finds none (measured 2026-10-20: 51 rows before planning facts moved into Tasks, 102 after).
  expect(opening.rowsRead).toBeLessThanOrEqual(2 * 50 + 2);
  expect(page.rowsRead).toBeLessThanOrEqual(opening.rowsRead + 2);
  // The task, its counts and its dependencies' seek, which finds none.
  expect(lookup.rowsRead).toBeLessThanOrEqual(4);
  const descending = await list(harness.db, { view: 'all', pageSize: 50, orderBy: 'sort_order desc' });
  const next = await list(harness.db, {
    view: 'all',
    pageSize: 50,
    orderBy: 'sort_order desc',
    pageToken: descending.nextPageToken,
  });
  expect(Number(next.tasks[0]?.sortOrder)).toBeLessThan(Number(descending.tasks.at(-1)?.sortOrder));
});

async function renameSection(db: D1Database, id: string) {
  const section = create(SectionSchema, { name: `sections/${id}`, title: `Synthetic renamed ${id}` });
  const request = create(UpdateSectionRequestSchema, {
    requestId: randomUUID(),
    etag: await revision('sections', id),
    section,
    updateMask: { paths: ['title'] },
  });
  return saveCatalog(
    db,
    'sections',
    SectionSchema,
    {
      requestId: request.requestId,
      id: '',
      etag: request.etag,
      resource: section,
      updateMask: { paths: ['title'] },
      request,
    },
    false,
    NOW,
  );
}

test('renaming a section or recolouring a project leaves its tasks alone', async () => {
  await harness.db
    .prepare(
      "INSERT INTO sections(id,title,project_id,created_at,updated_at) VALUES('empty-section','Synthetic empty section','budget-project',1,1)",
    )
    .run();
  const revisions = () =>
    harness.db
      .prepare("SELECT sum(revision) AS total FROM tasks WHERE project_id='budget-project'")
      .first<{ total: number }>();
  const before = await revisions();
  const empty = await measure((db) => renameSection(db, 'empty-section'));
  const rename = await measure((db) => renameSection(db, 'budget-section'));
  const project = create(ProjectSchema, { name: 'projects/budget-project', color: '#b8255f', favorite: true });
  const request = create(UpdateProjectRequestSchema, {
    requestId: randomUUID(),
    etag: await revision('projects', 'budget-project'),
    project,
    updateMask: { paths: ['color', 'favorite'] },
  });
  const recolour = await measure((db) =>
    saveCatalog(
      db,
      'projects',
      ProjectSchema,
      {
        requestId: request.requestId,
        id: '',
        etag: request.etag,
        resource: project,
        updateMask: { paths: ['color', 'favorite'] },
        request,
      },
      false,
      NOW,
    ),
  );
  stdout.write(JSON.stringify({ event: 'tasks_catalog_edit_cost', empty, rename, recolour }) + '\n');
  // A section with 100 tasks costs what an empty one does: the section row, one change row and the receipt.
  expect(rename).toEqual(empty);
  expect(recolour.rowsRead).toBeLessThan(20);
  expect(await revisions()).toEqual(before);
});

test('a label rename announces the label before its tasks', async () => {
  const start = await harness.db.prepare('SELECT max(sequence) AS last FROM changes').first<{ last: number }>();
  const renamed = await harness.mutate(
    'PATCH',
    `/api/tasks/v1/labels/budget-label?request_id=${randomUUID()}&update_mask=title&etag=${await revision('labels', 'budget-label')}`,
    { title: 'Synthetic renamed label' },
  );
  expect(renamed.status, await renamed.clone().text()).toBe(200);
  const changes = await harness.db
    .prepare('SELECT resource FROM changes WHERE sequence>? ORDER BY sequence')
    .bind(start?.last ?? 0)
    .all<{ resource: string }>();
  expect(changes.results[0]?.resource).toBe('labels');
  expect(changes.results.filter((change) => change.resource === 'tasks').length).toBeGreaterThan(100);
});

test('the fullest Focus week reads a bounded number of rows, and the timer poll one', async () => {
  await seedWorstWeek(harness.db, '2030-04-15');
  const readWeek = () =>
    measure(async (db) => {
      const answer = await listFocusDays(
        db,
        create(ListFocusDaysRequestSchema, { startDay: '2030-04-15', endDay: '2030-04-21' }),
        ZONE,
        NOW,
      );
      expect(answer.days.flatMap((day) => day.taskIds)).toHaveLength(WEEK_STEPS);
      expect(answer.entries).toHaveLength(WEEK_ENTRIES);
      expect(answer.tasks).toHaveLength(WEEK_STEPS + WEEK_ENTRIES);
    });
  const week = await readWeek();
  // Another full week elsewhere costs this read nothing: every statement seeks its days.
  await seedWorstWeek(harness.db, '2030-05-06', 'other');
  const again = await readWeek();
  const poll = await measure((db) => getFocusTimer(db, create(GetFocusTimerRequestSchema, { name: 'focusTimer' })));
  stdout.write(JSON.stringify({ event: 'tasks_focus_week_read', week, again, poll }) + '\n');
  expect(week.statements).toBe(3);
  expect(week.rowsWritten).toBe(0);
  // Measured 2,380 rows (2026-10-19): 140 queue rows, 210 records and 350 tasks, each read through an index.
  expect(week.rowsRead).toBeLessThan(3000);
  // A few index steps more, not the other week's 1,000 rows.
  expect(Math.abs(again.rowsRead - week.rowsRead)).toBeLessThanOrEqual(10);
  expect(poll.rowsRead).toBe(1);
});

test("a task's five dependencies and the plan read a bounded number of rows; next week seeks tasks_committed", async () => {
  const waiter = 'section-0';
  const prerequisites = ['section-10', 'section-20', 'section-30', 'section-40', 'recurring-0'];
  const plain = await measure((db) => getTask(db, 'section-1'));
  await harness.db
    .prepare(
      `INSERT INTO task_dependencies(task_id,prerequisite_id,created_at,updated_at) SELECT ?,value,1,1 FROM json_each(?)`,
    )
    .bind(waiter, JSON.stringify(prerequisites))
    .run();
  await harness.db
    .prepare(
      "UPDATE tasks SET stage='committed',committed_week='2030-04-22' WHERE id IN (SELECT value FROM json_each(?))",
    )
    .bind(JSON.stringify(prerequisites))
    .run();
  const linked = await measure(async (db) => {
    expect((await getTask(db, waiter)).dependencies).toBeTruthy();
  });
  const plan = await measure(async (db) => {
    expect((await getPlan(db, create(GetPlanRequestSchema, { name: 'plan' }), ZONE, NOW)).nextWeekTaskIds).toHaveLength(
      5,
    );
  });
  stdout.write(JSON.stringify({ event: 'tasks_planning_reads', plain, linked, plan }) + '\n');
  // Each prerequisite is a primary-key row, and the recurring one's completions are counted through their index.
  expect(linked.rowsRead - plain.rowsRead).toBeLessThanOrEqual(5 * 3);
  expect(plan.statements).toBe(3);
  // D1 never runs ANALYZE by itself, so the read names the partial index (src/plan.ts), and it seeks it in order.
  const steps = await harness.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM tasks INDEXED BY tasks_committed WHERE stage='committed' AND deleted_at IS NULL AND committed_week>? AND completed=0 ORDER BY committed_week LIMIT 100",
    )
    .bind('2030-04-15')
    .all<{ detail: string }>();
  const detail = steps.results.map((step) => step.detail).join('\n');
  expect(detail).toMatch(/SEARCH tasks USING INDEX tasks_committed \(committed_week>\?\)/);
  expect(detail).not.toMatch(/TEMP B-TREE/);
  expect(plan.rowsRead).toBeLessThanOrEqual(10);
});

async function resetBudgetDb(db: D1Database) {
  await db.batch([
    db.prepare('DELETE FROM task_dependencies'),
    db.prepare('DELETE FROM day_steps'),
    db.prepare('DELETE FROM focus_entries'),
    db.prepare('DELETE FROM task_labels'),
    db.prepare('DELETE FROM completions'),
    db.prepare('DELETE FROM tasks'),
    db.prepare('DELETE FROM sections'),
    db.prepare('DELETE FROM projects'),
    db.prepare('DELETE FROM labels'),
    db.prepare('DELETE FROM filters'),
    db.prepare('DELETE FROM requests'),
    db.prepare('DELETE FROM changes'),
    db.prepare(
      "UPDATE focus_timer SET state='idle',task_id=NULL,day=NULL,area=NULL,target_seconds=NULL,started_at=NULL,segment_start=NULL,paused_at=NULL,saved_seconds=0,finished_task_id=NULL,finished_seconds=NULL,revision=1 WHERE id='timer'",
    ),
  ]);
}

describe('catalog read budget', () => {
  beforeAll(async () => {
    await resetBudgetDb(harness.db);
  });

  async function addCatalogTasks(prefix: string, count: number, completed: boolean) {
    const data = Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${String(index)}`,
      order: index,
    }));
    await harness.db
      .prepare(
        `INSERT INTO tasks(id,title,project_id,completed,due_date,sort_order,created_at,updated_at)
      SELECT value->>'id','Synthetic catalog budget task','budget-project',?,CASE WHEN ?=0 THEN '2030-04-15' ELSE '' END,value->>'order',1,1 FROM json_each(?)`,
      )
      .bind(Number(completed), Number(completed), JSON.stringify(data))
      .run();
  }

  test('catalog row-read budget with a personal active list and completed history', async () => {
    await harness.db
      .prepare(
        "INSERT INTO projects(id,title,created_at,updated_at) VALUES('budget-project','Synthetic budget project',1,1),('empty-project','Synthetic empty project',1,1)",
      )
      .run();
    await addCatalogTasks('active', 40, false);
    await addCatalogTasks('history-before', 2000, true);
    const measured = measuredReads(harness.db);
    const catalog = await getCatalog(measured.db, ZONE, NOW);
    expect(catalog.taskCounts.find((count) => count.view === 'project' && count.id === 'budget-project')?.count).toBe(
      40,
    );
    expect(catalog.taskCounts.find((count) => count.view === 'project' && count.id === 'empty-project')?.count).toBe(0);
    expect(measured.metrics.rowsWritten).toBe(0);
    stdout.write(
      JSON.stringify({
        event: 'tasks_catalog_read_budget',
        active: 40,
        completed: 2000,
        ...measured.metrics,
      }) + '\n',
    );
  });

  test('metadata-only catalog reads never scan tasks and retain the full organization', async () => {
    const full = measuredReads(harness.db);
    const organization = await getCatalog(full.db, ZONE, NOW);
    const basic = measuredReads(harness.db);
    const metadata = await getCatalog(basic.db, ZONE, NOW, false);
    expect(metadata).toEqual({ ...organization, taskCounts: [] });
    expect(basic.metrics.statements).toBe(4);
    expect(basic.metrics.rowsWritten).toBe(0);
    expect(basic.metrics.rowsRead).toBeLessThan(20);
    stdout.write(
      JSON.stringify({
        event: 'tasks_catalog_metadata_budget',
        active: 40,
        completed: 2000,
        ...basic.metrics,
      }) + '\n',
    );
  });

  test('catalog badge reads do not grow with completed label history', async () => {
    await harness.db
      .prepare("INSERT INTO labels(id,title,created_at,updated_at) VALUES('budget-label','Synthetic budget label',1,1)")
      .run();
    await harness.db.prepare("UPDATE tasks SET label_ids='[\"budget-label\"]'").run();
    const before = measuredReads(harness.db);
    const first = await getCatalog(before.db, ZONE, NOW);
    expect(first.taskCounts.find((count) => count.view === 'label' && count.id === 'budget-label')?.count).toBe(40);
    await addCatalogTasks('history-after', 2000, true);
    await harness.db
      .prepare("UPDATE tasks SET label_ids='[\"budget-label\"]' WHERE id LIKE 'history-after-%'")
      .run();
    const after = measuredReads(harness.db);
    const second = await getCatalog(after.db, ZONE, NOW);
    expect(second.taskCounts).toEqual(first.taskCounts);
    stdout.write(
      JSON.stringify({
        event: 'tasks_catalog_history_growth',
        active: 40,
        beforeCompleted: 2000,
        afterCompleted: 4000,
        before: before.metrics,
        after: after.metrics,
      }) + '\n',
    );
    expect(after.metrics.rowsWritten).toBe(0);
    expect(after.metrics.rowsRead).toBeLessThanOrEqual(before.metrics.rowsRead + 20);
  });
});

describe('focus day write budget', () => {
  beforeAll(async () => {
    await resetBudgetDb(harness.db);
  });

  test('a busy Focus day writes fewer than 300 D1 rows', async () => {
    // A fixed morning, so the simulated day never crosses midnight.
    const start = Date.parse('2030-04-15T16:00:00Z');
    const today = localDate(start, ZONE);
    const steps = Array.from({ length: 10 }, (_, index) => `day-step-${String(index)}`);
    await harness.db
      .prepare(
        "INSERT INTO tasks(id,title,sort_order,created_at,updated_at) VALUES('day-outcome','Synthetic outcome',1,1,1)",
      )
      .run();
    await harness.db
      .prepare(
        `INSERT INTO tasks(id,title,parent_id,kind,duration_minutes,sort_order,created_at,updated_at)
        SELECT value,'Synthetic step '||value,'day-outcome','step',30,1,1,1 FROM json_each(?)`,
      )
      .bind(JSON.stringify(steps))
      .run();
    const { db, metrics } = measuredReads(harness.db);
    const move = (taskId: string, fields: { sourceDay?: string; destinationDay?: string; beforeTaskId?: string }) =>
      moveFocusStep(db, create(MoveFocusStepRequestSchema, { requestId: randomUUID(), taskId, ...fields }), start);
    for (const step of steps) await move(step, { destinationDay: today });
    const added = { ...metrics };
    const tomorrow = addDays(today, 1);
    await move('day-step-9', { sourceDay: today, destinationDay: today, beforeTaskId: 'day-step-0' });
    await move('day-step-8', { sourceDay: today, destinationDay: today, beforeTaskId: 'day-step-1' });
    await move('day-step-7', { sourceDay: today, destinationDay: today, beforeTaskId: 'day-step-2' });
    await move('day-step-6', { sourceDay: today, destinationDay: tomorrow });
    await move('day-step-5', { sourceDay: today, destinationDay: tomorrow });
    const moved = { ...metrics };
    let etag = '1';
    let now = start;
    const command = async (action: Action, taskId = '') => {
      const answer = await commandFocusTimer(
        db,
        create(CommandFocusTimerRequestSchema, { name: 'focusTimer', requestId: randomUUID(), etag, action, taskId }),
        now,
        ZONE,
      );
      etag = answer.timer?.etag ?? '';
    };
    // Six of the steps still queued today.
    for (const step of ['day-step-0', 'day-step-1', 'day-step-2', 'day-step-3', 'day-step-4', 'day-step-7']) {
      await command(Action.START, step);
      now += 20 * MINUTE;
      await command(Action.PAUSE);
      now += 5 * MINUTE;
      await command(Action.RESUME);
      now += 10 * MINUTE;
      await completeTask(
        db,
        create(CompleteTaskRequestSchema, { name: `tasks/${step}`, etag: '1', requestId: randomUUID() }),
        now,
        ZONE,
      );
      // The completion settled the session, so the timer's etag moved on.
      etag = String(Number(etag) + 1);
    }
    const timed = { ...metrics };
    const read = await listFocusDays(
      harness.db,
      create(ListFocusDaysRequestSchema, { startDay: today, endDay: today }),
      ZONE,
      now,
    );
    expect(read.entries).toHaveLength(6);
    expect(read.days[0]?.doneTaskIds).toHaveLength(6);
    for (const entry of read.entries.slice(0, 3))
      await updateFocusEntry(
        db,
        create(UpdateFocusEntryRequestSchema, {
          requestId: randomUUID(),
          etag: entry.etag,
          focusEntry: create(FocusEntrySchema, { name: entry.name, seconds: 40 * 60 }),
          updateMask: { paths: ['seconds'] },
        }),
        now,
      );
    stdout.write(JSON.stringify({ event: 'tasks_focus_day_writes', added, moved, timed, total: metrics }) + '\n');
    expect(metrics.rowsWritten).toBeLessThan(300);
  });
});

