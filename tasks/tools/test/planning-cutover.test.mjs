import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { preparePlanningCutover, planningCutoverSql } from '../planning-cutover.ts';
import { startHarness } from '../../worker/test/runtime/harness.ts';

function snapshot() {
  return {
    version: 1,
    source: 'todoist',
    exported_at: '2026-10-17T00:00:00Z',
    time_zone: 'UTC',
    archived_contents_verified: true,
    recurring_history_verified: true,
    projects: [{ id: 'inbox', name: 'Inbox', inbox_project: true }],
    sections: [],
    labels: [],
    filters: [],
    completed: [],
    tasks: ['source-a', 'source-b'].map((id) => ({
      id,
      content: 'Synthetic task',
      project_id: 'inbox',
      added_at: '2026-10-01T00:00:00Z',
      priority: 1,
      completed_count: 6,
      labels: [],
    })),
  };
}
function metadata() {
  return {
    plan_tasks: [
      { id: 12, provider: 'todoist', external_id: 'source-a', created_at: 1000, closed_at: null, closed_as: null },
      { id: 13, provider: 'todoist', external_id: 'source-b', created_at: 1001, closed_at: null, closed_as: null },
      {
        id: 77,
        provider: 'todoist',
        external_id: 'old-deleted',
        created_at: 500,
        closed_at: 999,
        closed_as: 'deleted',
      },
    ],
    plan_edges: [{ task_id: 12, prerequisite_id: 13, kind: 'waits_for', baseline_count: 6, created_at: 1100 }],
    plan_marks: [{ task_id: 12, kind: 'committed', period: '2026-10-19', created_at: 1200 }],
  };
}
async function setup() {
  const harness = await startHarness();
  await harness.db
    .prepare('CREATE TABLE summaries(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,imported INTEGER NOT NULL)')
    .run();
  const migration = await readFile(new URL('../../../todofy/migrations/0007_plan_store.sql', import.meta.url), 'utf8');
  for (const sql of migration.replace(/--[^\n]*/g, '').split(';')) if (sql.trim()) await harness.db.prepare(sql).run();
  const initial = metadata();
  for (const row of initial.plan_tasks)
    await harness.db
      .prepare('INSERT INTO plan_tasks(id,provider,external_id,created_at,closed_at,closed_as) VALUES(?,?,?,?,?,?)')
      .bind(row.id, row.provider, row.external_id, row.created_at, row.closed_at, row.closed_as)
      .run();
  const edge = initial.plan_edges[0];
  await harness.db
    .prepare('INSERT INTO plan_edges(task_id,prerequisite_id,kind,baseline_count,created_at) VALUES(?,?,?,?,?)')
    .bind(edge.task_id, edge.prerequisite_id, edge.kind, edge.baseline_count, edge.created_at)
    .run();
  const mark = initial.plan_marks[0];
  await harness.db
    .prepare('INSERT INTO plan_marks(task_id,kind,period,created_at) VALUES(?,?,?,?)')
    .bind(mark.task_id, mark.kind, mark.period, mark.created_at)
    .run();
  return harness;
}

test('switches provider in place while preserving edge, mark and closed-history identities', async () => {
  const harness = await setup();
  try {
    const plan = preparePlanningCutover(snapshot(), metadata());
    assert.deepEqual(plan.targetIds, [12, 13]);
    assert.equal(plan.untouchedHistorical, 1);
    const sql = planningCutoverSql(plan);
    await harness.db.prepare(sql).run();
    await harness.db.prepare(sql).run();
    const identities = (await harness.db.prepare('SELECT * FROM plan_tasks ORDER BY id').all()).results;
    assert.deepEqual(
      identities,
      metadata().plan_tasks.map((row) => ({ ...row, provider: row.id === 77 ? 'todoist' : 'tasks' })),
    );
    assert.deepEqual((await harness.db.prepare('SELECT * FROM plan_edges').all()).results, metadata().plan_edges);
    assert.deepEqual((await harness.db.prepare('SELECT * FROM plan_marks').all()).results, metadata().plan_marks);
  } finally {
    await harness.dispose();
  }
});

test('a stale plan or conflicting native identity aborts the entire SQL statement', async () => {
  const harness = await setup();
  try {
    const sql = planningCutoverSql(preparePlanningCutover(snapshot(), metadata()));
    await harness.db
      .prepare("INSERT INTO plan_tasks(id,provider,external_id,created_at) VALUES(99,'tasks','source-a',2000)")
      .run();
    await assert.rejects(() => harness.db.prepare(sql).run());
    const source = (await harness.db.prepare('SELECT provider FROM plan_tasks WHERE id IN(12,13) ORDER BY id').all())
      .results;
    assert.deepEqual(source, [{ provider: 'todoist' }, { provider: 'todoist' }]);
    await harness.db.prepare('DELETE FROM plan_tasks WHERE id=99').run();
    await harness.db.prepare('UPDATE plan_edges SET baseline_count=7').run();
    await assert.rejects(() => harness.db.prepare(sql).run());
    assert.equal((await harness.db.prepare('SELECT provider FROM plan_tasks WHERE id=12').first()).provider, 'todoist');
  } finally {
    await harness.dispose();
  }
});

test('missing referenced source tasks and duplicate identities block preparation', () => {
  const missing = snapshot();
  missing.tasks = missing.tasks.filter((task) => task.id !== 'source-b');
  const plan = preparePlanningCutover(missing, metadata());
  assert.equal(plan.issues[0].code, 'REFERENCED_SOURCE_TASK_MISSING');
  assert.throws(() => planningCutoverSql(plan), /UNRESOLVED/);
  const duplicate = metadata();
  duplicate.plan_tasks.push({ ...duplicate.plan_tasks[0], id: 20, provider: 'tasks' });
  assert.ok(
    preparePlanningCutover(snapshot(), duplicate).issues.some((issue) => issue.code === 'DUPLICATE_NATIVE_IDENTITY'),
  );
});


test('a recurring prerequisite cannot lose its existing completion baseline',()=>{
  const input=snapshot();input.tasks.find((task)=>task.id==='source-b').completed_count=5;
  const plan=preparePlanningCutover(input,metadata());
  assert.ok(plan.issues.some((issue)=>issue.code==='COMPLETION_BASELINE_NOT_PRESERVED'));
  assert.throws(()=>planningCutoverSql(plan),/UNRESOLVED/);
});
