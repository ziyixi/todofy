import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { encodePageToken } from '@ziyixi/proto/page-token';
import {
  GetGoalCatalogRequestSchema,
  ListGoalProgressRequestSchema,
  ListTasksRequestSchema,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { getGoalCatalog } from '../../src/goal-read.ts';
import { listGoalProgress } from '../../src/goal-progress.ts';
import { listTasks } from '../../src/task-read.ts';
import { measuredReads, startHarness, type Harness } from './harness.ts';

interface Resource {
  id: string;
  name: string;
  etag: string;
  title: string;
}
interface Objective extends Resource {
  year: number;
  description?: string;
  source_url?: string;
  archived?: boolean;
}
interface Milestone {
  id: string;
  title: string;
  completed?: boolean;
  complete_time?: string;
}
interface KeyResult extends Resource {
  objective_id: string;
  year: number;
  notes?: string;
  floor_text?: string;
  target_text?: string;
  milestones?: Milestone[];
  focus_text?: string;
  completed?: boolean;
  archived?: boolean;
  objective_archived?: boolean;
}
interface GoalProgress extends Resource {
  key_result_id: string;
  note: string;
  evidence_url?: string;
  create_time?: string;
}
interface GoalCatalog {
  objectives?: Objective[];
  key_results?: (KeyResult & {
    milestone_count?: number;
    completed_milestone_count?: number;
  })[];
}
interface Task extends Resource {
  key_result_id?: string;
  effective_key_result_id?: string;
  key_result_title?: string;
}
interface WeeklyBet {
  etag: string;
  text: string;
  key_result_id?: string;
  key_result_title?: string;
}

const YEAR = 2030;
const NOW = Date.parse('2030-04-15T18:00:00Z');
const ZONE = 'America/Los_Angeles';
let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.dispose();
});

async function json<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<T>();
}
async function make<T>(collection: string, values: object, request = randomUUID()): Promise<T> {
  return json<T>(await harness.mutate('POST', `/api/tasks/v1/${collection}?request_id=${request}`, values));
}
async function patch<T>(resource: { name: string; etag: string }, values: object, request = randomUUID()): Promise<T> {
  return json<T>(await rawPatch(resource, values, request));
}
function rawPatch(resource: { name: string; etag: string }, values: object, request = randomUUID()) {
  return harness.mutate(
    'PATCH',
    `/api/tasks/v1/${resource.name}?etag=${resource.etag}&request_id=${request}&update_mask=${Object.keys(values).join(',')}`,
    values,
  );
}
async function reason(response: Response) {
  return (await response.json<{ error: { details: { reason?: string }[] } }>()).error.details.find(
    (detail) => detail.reason,
  )?.reason;
}
const objective = (values = {}) =>
  make<Objective>('objectives', {
    title: 'Synthetic annual direction',
    year: YEAR,
    ...values,
  });
const result = (owner: Objective, values = {}) =>
  make<KeyResult>('keyResults', {
    objective_id: owner.id,
    title: 'Synthetic annual result',
    ...values,
  });
const catalog = (year = YEAR) =>
  harness.fetch(`/api/tasks/v1/goalCatalog?year=${String(year)}`).then(json<GoalCatalog>);

test('annual goals start empty, default to the account year, and reject invalid years', async () => {
  const empty = await getGoalCatalog(
    harness.db,
    create(GetGoalCatalogRequestSchema, { name: 'goalCatalog' }),
    ZONE,
    Date.parse('2091-01-01T01:00:00Z'),
  );
  expect([empty.year, empty.today, empty.timeZone, empty.objectives, empty.keyResults]).toEqual([
    2090,
    '2090-12-31',
    ZONE,
    [],
    [],
  ]);
  expect((await catalog(2099)).objectives ?? []).toEqual([]);
  expect(await reason(await harness.fetch('/api/tasks/v1/goalCatalog?year=1999'))).toBe('BAD_REQUEST');
});

test('Objective CRUD uses receipts, explicit masks, stable years and etags', async () => {
  const request = randomUUID();
  const values = {
    title: '  Synthetic direction  ',
    description: 'Synthetic description',
    year: YEAR,
    source_url: 'https://example.test/source',
  };
  const first = await make<Objective>('objectives', values, request);
  expect(first.title).toBe('Synthetic direction');
  expect(await make<Objective>('objectives', values, request)).toEqual(first);
  expect(
    await reason(
      await harness.mutate('POST', `/api/tasks/v1/objectives?request_id=${request}`, {
        ...values,
        title: 'Different input',
      }),
    ),
  ).toBe('BAD_REQUEST');
  const changed = await patch<Objective>(first, { title: 'Changed direction' });
  expect([changed.etag, changed.description, changed.year, changed.source_url]).toEqual([
    '2',
    values.description,
    YEAR,
    values.source_url,
  ]);
  expect(await reason(await rawPatch(first, { title: 'Stale tab' }))).toBe('ETAG_MISMATCH');
  expect(await reason(await rawPatch(changed, { year: 2031 }))).toBe('BAD_REQUEST');
  expect(
    await reason(
      await harness.mutate('PATCH', `/api/tasks/v1/${changed.name}?etag=${changed.etag}&request_id=${randomUUID()}`, {
        title: 'No mask',
      }),
    ),
  ).toBe('BAD_REQUEST');
});

test('Key Results keep full texts, manual milestones and multi-month focus; catalog is concise', async () => {
  const owner = await objective();
  const first = await result(owner, {
    floor_text: 'Acceptable floor',
    target_text: 'Intended result',
    notes: 'Detailed notes',
    kind: 'exploration',
    milestones: [{ id: 'first', title: 'Synthetic milestone', completed: true }],
    focus_start_month: '2030-03',
    focus_end_month: '2030-06',
    focus_text: 'Synthetic spring focus',
  });
  expect(first.year).toBe(YEAR);
  expect(first.milestones?.[0]?.complete_time).toMatch(/^\d{4}-/);
  const renamed = await patch<KeyResult>(first, { title: 'A clearer result' });
  expect([renamed.notes, renamed.floor_text, renamed.target_text, renamed.milestones]).toEqual([
    first.notes,
    first.floor_text,
    first.target_text,
    first.milestones,
  ]);
  expect(await json<KeyResult>(await harness.fetch(`/api/tasks/v1/${first.name}`))).toEqual(renamed);
  const summary = (await catalog()).key_results?.find((entry) => entry.id === first.id);
  expect(summary).toMatchObject({
    title: renamed.title,
    milestone_count: 1,
    completed_milestone_count: 1,
    focus_text: first.focus_text,
  });
  expect(summary).not.toHaveProperty('notes');
  expect(summary).not.toHaveProperty('milestones');
  const cleared = await patch<KeyResult>(renamed, {
    focus_start_month: '',
    focus_end_month: '',
    focus_text: '',
  });
  expect(cleared.focus_text ?? '').toBe('');
  expect(cleared.milestones).toEqual(first.milestones);
  const reopened = await patch<KeyResult>(cleared, {
    milestones: [{ id: 'first', title: 'Synthetic milestone' }],
  });
  expect(reopened.milestones?.[0]).not.toHaveProperty('complete_time');
  expect(
    await reason(
      await rawPatch(reopened, {
        focus_start_month: '2031-01',
        focus_end_month: '2031-03',
      }),
    ),
  ).toBe('BAD_REQUEST');
  expect(
    await reason(
      await rawPatch(reopened, {
        milestones: [
          { id: 'same', title: 'One' },
          { id: 'same', title: 'Two' },
        ],
      }),
    ),
  ).toBe('BAD_REQUEST');
  const anotherYear = await objective({ year: 2031 });
  expect(await reason(await rawPatch(reopened, { objective_id: anotherYear.id }))).toBe('BAD_REQUEST');
  const other = await objective();
  const moved = await patch<KeyResult>(reopened, { objective_id: other.id });
  expect(moved.objective_id).toBe(other.id);
});

test('progress records page newest first, edit narrowly, soft-delete and replay safely', async () => {
  const kr = await result(await objective());
  const request = randomUUID();
  const body = {
    key_result_id: kr.id,
    note: '  Synthetic evidence  ',
    evidence_url: 'https://example.test/evidence',
  };
  const first = await make<GoalProgress>('goalProgress', body, request);
  expect(await make<GoalProgress>('goalProgress', body, request)).toEqual(first);
  const second = await make<GoalProgress>('goalProgress', {
    key_result_id: kr.id,
    note: 'A later observation',
  });
  const opening = await json<{
    goal_progress: GoalProgress[];
    next_page_token: string;
  }>(await harness.fetch(`/api/tasks/v1/goalProgress?key_result_id=${kr.id}&page_size=1`));
  expect(opening.goal_progress).toEqual([second]);
  const next = await json<{ goal_progress: GoalProgress[] }>(
    await harness.fetch(
      `/api/tasks/v1/goalProgress?key_result_id=${kr.id}&page_size=50&page_token=${encodeURIComponent(opening.next_page_token)}`,
    ),
  );
  expect(next.goal_progress).toEqual([first]);
  const edited = await patch<GoalProgress>(first, {
    note: 'Corrected observation',
  });
  expect([edited.etag, edited.evidence_url, edited.create_time]).toEqual(['2', first.evidence_url, first.create_time]);
  expect(await reason(await rawPatch(first, { note: 'Stale' }))).toBe('ETAG_MISMATCH');
  const other = await result(await objective());
  expect(await reason(await rawPatch(edited, { key_result_id: other.id }))).toBe('BAD_REQUEST');
  expect(
    await reason(
      await harness.fetch(
        `/api/tasks/v1/goalProgress?key_result_id=${other.id}&page_token=${encodeURIComponent(opening.next_page_token)}`,
      ),
    ),
  ).toBe('BAD_REQUEST');
  const deletion = `/api/tasks/v1/${edited.name}?etag=${edited.etag}&request_id=${randomUUID()}`;
  expect((await harness.mutate('DELETE', deletion)).status).toBe(200);
  expect((await harness.mutate('DELETE', deletion)).status).toBe(200);
  const removed = await harness.db
    .prepare('SELECT deleted_at FROM goal_progress WHERE id=?')
    .bind(edited.id)
    .first<{ deleted_at: number }>();
  expect(typeof removed?.deleted_at).toBe('number');
  const remaining = await listGoalProgress(harness.db, create(ListGoalProgressRequestSchema, { keyResultId: kr.id }));
  expect(remaining.goalProgress.map((entry) => entry.id)).toEqual([second.id]);
  expect(await reason(await harness.fetch('/api/tasks/v1/goalProgress?key_result_id=missing'))).toBe('NOT_FOUND');
});

test('Task/Subtask links remain independent and Steps inherit only their direct parent', async () => {
  const owner = await objective();
  const one = await result(owner, { title: 'Synthetic result one' });
  const two = await result(owner, { title: 'Synthetic result two' });
  const parent = await make<Task>('tasks', {
    title: 'Synthetic parent',
    key_result_id: one.id,
  });
  const subtask = await make<Task>('tasks', {
    title: 'Synthetic subtask',
    parent_id: parent.id,
  });
  const step = await make<Task>('tasks', {
    title: 'Synthetic step',
    kind: 'step',
    parent_id: parent.id,
  });
  const substep = await make<Task>('tasks', {
    title: 'Synthetic substep',
    kind: 'step',
    parent_id: subtask.id,
  });
  expect([parent.key_result_id, parent.effective_key_result_id, parent.key_result_title]).toEqual([
    one.id,
    one.id,
    one.title,
  ]);
  expect(subtask.effective_key_result_id ?? '').toBe('');
  expect([step.key_result_id ?? '', step.effective_key_result_id, step.key_result_title]).toEqual([
    '',
    one.id,
    one.title,
  ]);
  expect(substep.effective_key_result_id ?? '').toBe('');
  expect(
    await reason(
      await harness.mutate('POST', `/api/tasks/v1/tasks?request_id=${randomUUID()}`, {
        title: 'Invalid own link',
        kind: 'step',
        parent_id: parent.id,
        key_result_id: one.id,
      }),
    ),
  ).toBe('BAD_REQUEST');
  const replanned = await patch<Task>(parent, {
    stage: 'monthly',
    due_date: '2030-04-20',
  });
  expect(replanned.key_result_id).toBe(one.id);
  const relinked = await patch<Task>(replanned, { key_result_id: two.id });
  const inherited = await json<Task>(await harness.fetch(`/api/tasks/v1/${step.name}`));
  expect([inherited.effective_key_result_id, inherited.key_result_title]).toEqual([two.id, two.title]);
  expect(inherited.etag).toBe(step.etag);
  const linkedSubtask = await patch<Task>(subtask, { key_result_id: one.id });
  expect((await json<Task>(await harness.fetch(`/api/tasks/v1/${substep.name}`))).effective_key_result_id).toBe(one.id);
  const filtered = await json<{ tasks: Task[] }>(
    await harness.fetch(`/api/tasks/v1/tasks?view=all&key_result_id=${one.id}&include_completed=true`),
  );
  expect(filtered.tasks.map((task) => task.id)).toEqual([linkedSubtask.id]);
  const complete = await json<Task>(
    await harness.mutate('POST', `/api/tasks/v1/${relinked.name}:complete`, {
      etag: relinked.etag,
      request_id: randomUUID(),
    }),
  );
  expect(complete.key_result_id).toBe(two.id);
  const unchanged = await json<KeyResult>(await harness.fetch(`/api/tasks/v1/${two.name}`));
  expect([unchanged.etag, unchanged.completed ?? false, unchanged.milestones ?? []]).toEqual([two.etag, false, []]);
});

test('archiving preserves links, progress and copies while preventing new goal choices', async () => {
  const owner = await objective();
  const kr = await result(owner);
  const task = await make<Task>('tasks', {
    title: 'Synthetic linked task',
    key_result_id: kr.id,
  });
  await make<GoalProgress>('goalProgress', {
    key_result_id: kr.id,
    note: 'History survives archive',
  });
  await patch<Objective>(owner, { archived: true });
  const read = await json<KeyResult>(await harness.fetch(`/api/tasks/v1/${kr.name}`));
  expect([read.objective_archived, read.archived ?? false]).toEqual([true, false]);
  const renamed = await patch<Task>(task, { title: 'Edited after archive' });
  expect(renamed.key_result_id).toBe(kr.id);
  const copy = await json<Task>(
    await harness.mutate('POST', `/api/tasks/v1/${renamed.name}:duplicate`, {
      etag: renamed.etag,
      request_id: randomUUID(),
    }),
  );
  expect(copy.key_result_id).toBe(kr.id);
  expect(
    await reason(
      await harness.mutate('POST', `/api/tasks/v1/tasks?request_id=${randomUUID()}`, {
        title: 'New archived link',
        key_result_id: kr.id,
      }),
    ),
  ).toBe('PRECONDITION_FAILED');
  const stored = await listGoalProgress(harness.db, create(ListGoalProgressRequestSchema, { keyResultId: kr.id }));
  expect(stored.goalProgress).toHaveLength(1);
  expect((await catalog()).objectives?.find((entry) => entry.id === owner.id)?.archived).toBe(true);
});

test('weekly Bets update text and link independently, preserving saved-value replays', async () => {
  const kr = await result(await objective());
  const plan = await json<{ week_start: string }>(await harness.fetch('/api/tasks/v1/plan'));
  const name = `weeklyBets/${plan.week_start}-work`;
  const save = (etag: string, mask: string, body: object) =>
    harness.mutate('PATCH', `/api/tasks/v1/${name}?etag=${etag}&update_mask=${mask}`, body);
  const text = await json<WeeklyBet>(await save('', 'text', { text: 'Synthetic weekly choice' }));
  const linked = await json<WeeklyBet>(await save(text.etag, 'key_result_id', { key_result_id: kr.id }));
  expect([linked.text, linked.key_result_id, linked.key_result_title]).toEqual([text.text, kr.id, kr.title]);
  const renamed = await json<WeeklyBet>(await save(linked.etag, 'text', { text: 'A clearer weekly choice' }));
  expect(renamed.key_result_id).toBe(kr.id);
  // Replaying an older link-only write sees its saved link and keeps the newer text.
  expect(await json<WeeklyBet>(await save(text.etag, 'key_result_id', { key_result_id: kr.id }))).toEqual(renamed);
  expect(await reason(await save(text.etag, 'text', { text: 'A conflicting text' }))).toBe('ETAG_MISMATCH');
  const cleared = await json<WeeklyBet>(await save(renamed.etag, 'key_result_id', {}));
  expect([cleared.text, cleared.key_result_id ?? '', cleared.key_result_title ?? '']).toEqual([renamed.text, '', '']);
});

test('catalog and link reads do bounded indexed work when annual progress grows', async () => {
  const kr = await result(await objective({ year: 2070 }));
  const read = async () => {
    const measured = measuredReads(harness.db);
    const response = await getGoalCatalog(
      measured.db,
      create(GetGoalCatalogRequestSchema, { name: 'goalCatalog', year: 2070 }),
      ZONE,
      NOW,
    );
    return { response, metrics: measured.metrics };
  };
  const before = await read();
  await harness.db
    .prepare(
      `INSERT INTO goal_progress(id,key_result_id,note,created_at,updated_at)
    SELECT 'budget-note-'||value,?,'Synthetic historical evidence',value,value FROM json_each(?)`,
    )
    .bind(kr.id, JSON.stringify(Array.from({ length: 1000 }, (_, index) => index)))
    .run();
  const after = await read();
  expect(after.metrics).toEqual(before.metrics);
  expect(after.metrics.statements).toBe(2);
  expect(after.metrics.rowsRead).toBeLessThan(12);
  expect(after.response).toEqual(before.response);
  const measured = measuredReads(harness.db);
  const page = await listTasks(
    measured.db,
    create(ListTasksRequestSchema, { view: 'all', keyResultId: kr.id }),
    ZONE,
    NOW,
  );
  expect(page.tasks).toEqual([]);
  expect(measured.metrics.rowsRead).toBeLessThanOrEqual(2);
});

test('unfiltered list cursors made before goal links keep working', async () => {
  const first = await listTasks(harness.db, create(ListTasksRequestSchema, { view: 'all', pageSize: 1 }), ZONE, NOW);
  const last = first.tasks[0];
  if (!last) throw new Error('Missing synthetic first task');
  const oldToken = encodePageToken([last.sortOrder ?? 0, last.id], {
    view: 'all',
    project: '',
    parent: '',
    query: '',
    label: '',
    filter: '',
    date: '2030-04-15',
    order: 'sort_order ASC',
    includeCompleted: false,
    includeDescription: false,
    taskIds: '[]',
  });
  const next = await listTasks(
    harness.db,
    create(ListTasksRequestSchema, { view: 'all', pageSize: 1, pageToken: oldToken }),
    ZONE,
    NOW,
  );
  expect(next.tasks).toHaveLength(1);
  expect(next.tasks[0]?.id).not.toBe(last.id);
});

test('annual and milestone limits fail without creating partial resources', async () => {
  await harness.db
    .prepare(
      `INSERT INTO objectives(id,title,year,created_at,updated_at)
    SELECT 'limit-objective-'||value,'Synthetic bounded objective',2080,1,1 FROM json_each(?)`,
    )
    .bind(JSON.stringify(Array.from({ length: 20 }, (_, index) => index)))
    .run();
  const rejected = await harness.mutate('POST', `/api/tasks/v1/objectives?request_id=${randomUUID()}`, {
    title: 'Twenty-first',
    year: 2080,
  });
  expect(await reason(rejected)).toBe('PRECONDITION_FAILED');
  const owner = await objective({ year: 2081 });
  await harness.db
    .prepare(
      `INSERT INTO key_results(id,objective_id,title,created_at,updated_at)
    SELECT 'limit-result-'||value,?,'Synthetic bounded result',1,1 FROM json_each(?)`,
    )
    .bind(owner.id, JSON.stringify(Array.from({ length: 100 }, (_, index) => index)))
    .run();
  expect(
    await reason(
      await harness.mutate('POST', `/api/tasks/v1/keyResults?request_id=${randomUUID()}`, {
        objective_id: owner.id,
        title: 'Hundred-and-first',
      }),
    ),
  ).toBe('PRECONDITION_FAILED');
  const other = await objective({ year: 2082 });
  expect(
    await reason(
      await harness.mutate('POST', `/api/tasks/v1/keyResults?request_id=${randomUUID()}`, {
        objective_id: other.id,
        title: 'Too many milestones',
        milestones: Array.from({ length: 21 }, (_, index) => ({
          id: `m${String(index)}`,
          title: 'Synthetic milestone',
        })),
      }),
    ),
  ).toBe('BAD_REQUEST');
});
