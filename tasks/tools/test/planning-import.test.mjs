// tools/planning-import.ts: synthetic Todofy and Tasks databases built from both apps' migrations, the EXPORTS run
// read-only against them and answered the way `wrangler d1 execute --json` answers, and the generated SQL applied to
// Tasks, on node:sqlite and once on the Tasks Worker's real D1, read back through the Tasks API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { EXPORTS, PlanningImportError, planningImportSql, preparePlanningImport } from '../planning-import.ts';
import { startHarness } from '../../worker/test/runtime/harness.ts';

const TOOL = fileURLToPath(new URL('../prepare-planning-import.ts', import.meta.url));
const MIGRATIONS = {
  todofy: fileURLToPath(new URL('../../../todofy/migrations/', import.meta.url)),
  tasks: fileURLToPath(new URL('../../migrations/', import.meta.url)),
};
/** Milliseconds: every synthetic Tasks row's last change. */
const ROW_TIME = 1_790_000_000_000;

/** Tasks after the release: `changed` got a stage there, and Tasks keeps a removed dependency and a cleared Bet. */
const TASKS_SEED = [
  'INSERT INTO tasks(id,title,created_at,updated_at) VALUES' +
    "('due','Synthetic due',1,1790000000000),('undated','Synthetic undated',1,1790000000000)," +
    "('current','Synthetic current',1,1790000000000),('changed','Synthetic changed',1,1790000000000)," +
    "('plain','Synthetic plain',1,1790000000000),('lead-only','Synthetic lead only',1,1790000000000)," +
    "('done','Synthetic done',1,1790000000000),('gone','Synthetic gone',1,1790000000000)",
  "UPDATE tasks SET deadline='2026-11-02' WHERE id='due'",
  "UPDATE tasks SET completed=1,completed_at=1790000000000 WHERE id='done'",
  "UPDATE tasks SET deleted_at=1790000000500 WHERE id='gone'",
  "UPDATE tasks SET stage='quarterly' WHERE id='changed'",
  'INSERT INTO task_dependencies(task_id,prerequisite_id,created_at,updated_at,deleted_at) ' +
    "VALUES('changed','due',1790000000000,1790000000100,1790000000100)",
  'INSERT INTO weekly_bets(week_start,area,text,revision,created_at,updated_at) ' +
    "VALUES('2026-10-26','work','',2,1,1790000000000)",
];
/** Todofy's planning store: plan_tasks 9 is a Todoist-era identity and 10 names a task Tasks never had. */
const TODOFY_SEED = [
  'INSERT INTO plan_tasks(id,provider,external_id,created_at) VALUES' +
    "(1,'tasks','due',1),(2,'tasks','undated',1),(3,'tasks','current',1),(4,'tasks','changed',1)," +
    "(5,'tasks','plain',1),(6,'tasks','lead-only',1),(7,'tasks','done',1),(8,'tasks','gone',1)," +
    "(9,'todoist','due',1),(10,'tasks','missing',1)",
  'INSERT INTO plan_task_state' +
    '(task_id,stage,area,lead_days,quick,waiting,blocked,routine,request_id,updated_at) VALUES' +
    "(1,'committed','work',7,1,0,0,0,'r',1790000100),(2,'weekly','personal',3,0,1,1,0,'r',1789000000)," +
    "(3,'committed','unassigned',0,0,0,0,0,'r',1789000000),(4,'monthly','work',0,0,0,0,0,'r',1789000000)," +
    "(5,'none','unassigned',0,0,0,1,0,'r',1789000000),(6,'none','unassigned',7,0,0,0,0,'r',1789000000)," +
    "(7,'none','work',0,0,0,0,1,'r',1789000000),(8,'weekly','work',0,0,0,0,0,'r',1789000000)," +
    "(9,'weekly','work',0,0,0,0,0,'r',1789000000),(10,'monthly','work',0,0,0,0,0,'r',1789000000)",
  "INSERT INTO plus_settings(id,mapping,timezone,week_start,enabled) VALUES(1,'[]','UTC','2026-01-05',1)",
  "INSERT INTO plus_weeks(task_id,week_start,committed,bet) VALUES('due','2099-01-05',1,0),('plain','2026-01-05',0,1)",
  'INSERT INTO plan_edges(task_id,prerequisite_id,baseline_count,created_at) VALUES' +
    '(1,2,2,1789000001),(2,7,0,1789000002),(7,1,0,1789000003),(1,8,0,1789000004),(4,1,0,1789000005),(9,1,0,1789000006)',
  'INSERT INTO plan_notes(period,area,kind,body,updated_at) VALUES' +
    "('2026-10-19','work','bets','Owner''s synthetic goal',1789500000)," +
    "('2026-10-19','personal','bets','',1789500001)," +
    "('2026-10-12','personal','bets','Synthetic rest — ünïcödé 🚀',1789400000)," +
    "('2026-10-26','work','bets','Synthetic next',1789600000),('2026-10-19','','review','[]',1789500000)",
  'INSERT INTO plan_settings(key,value,updated_at) VALUES' +
    `('board','{"lanes":{"committed":[3,1],"waiting":[2,8,9],"start":[1]}}',1789700000),('native','{}',1)`,
];

function migrated(path, app, seed) {
  const db = new DatabaseSync(path);
  for (const name of readdirSync(MIGRATIONS[app])
    .filter((file) => file.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS[app], name), 'utf8'));
  for (const statement of seed) db.exec(statement);
  return db;
}
function databases() {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-planning-import-'));
  const paths = { todofy: join(dir, 'todofy.sqlite'), tasks: join(dir, 'tasks.sqlite') };
  migrated(paths.todofy, 'todofy', TODOFY_SEED).close();
  return { dir, paths, tasks: migrated(paths.tasks, 'tasks', TASKS_SEED) };
}
/** What `wrangler d1 execute --json --command <sql>` prints. */
const answer = (results) => [{ results: JSON.parse(JSON.stringify(results)), success: true, meta: {} }];
/** Every EXPORTS query, each on a read-only connection, so none of them can write. */
function exported(paths) {
  const answers = {};
  for (const { app, name, sql } of EXPORTS) {
    const db = new DatabaseSync(paths[app], { readOnly: true });
    try {
      answers[name] = answer(db.prepare(sql).all());
    } finally {
      db.close();
    }
  }
  return answers;
}
const plain = (rows) => rows.map((row) => ({ ...row }));
const planning = (db) =>
  plain(
    db
      .prepare(
        'SELECT id,stage,committed_week,area,lead_days,planning_flags,revision,updated_at FROM tasks ORDER BY id',
      )
      .all(),
  );
const dependencies = (db) =>
  plain(db.prepare('SELECT * FROM task_dependencies ORDER BY task_id,prerequisite_id').all());
const bets = (db) =>
  plain(
    db
      .prepare('SELECT week_start,area,text,typeof(text) AS type,revision,updated_at FROM weekly_bets ORDER BY 1,2')
      .all(),
  );
const board = (db) => ({ ...db.prepare("SELECT lanes,revision,updated_at FROM plan_board WHERE id='board'").get() });
const everything = (db) => ({
  planning: planning(db),
  dependencies: dependencies(db),
  bets: bets(db),
  board: board(db),
});

const PENDING_COUNTS = {
  states: { all: 10, pending: 4, present: 1, empty: 2, orphan: 3 },
  dependencies: { all: 6, pending: 2, present: 1, orphan: 3 },
  bets: { all: 3, pending: 2, present: 1 },
  board: { lanes: 3, tasks: 3, orphan: 2, pending: 1 },
  pending: 9,
};
const IMPORTED_COUNTS = {
  states: { all: 10, pending: 0, present: 5, empty: 2, orphan: 3 },
  dependencies: { all: 6, pending: 0, present: 3, orphan: 3 },
  bets: { all: 3, pending: 0, present: 3 },
  board: { lanes: 3, tasks: 3, orphan: 2, pending: 0 },
  pending: 0,
};

test('the exports are read-only SELECTs that both schemas answer', () => {
  const { dir, paths, tasks } = databases();
  try {
    tasks.close();
    for (const { app, sql } of EXPORTS) {
      assert.ok(['todofy', 'tasks'].includes(app));
      assert.match(sql, /^SELECT /);
    }
    assert.equal(Object.keys(exported(paths)).length, EXPORTS.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('imports facts, open dependencies, Bets and lanes once, and counts nothing pending afterwards', () => {
  const { dir, paths, tasks } = databases();
  try {
    const plan = preparePlanningImport(exported(paths));
    assert.deepEqual(plan.counts, PENDING_COUNTS);
    const before = everything(tasks);
    tasks.exec(planningImportSql(plan));

    const rows = new Map(planning(tasks).map((row) => [row.id, row]));
    // A commitment keeps its recorded week, else the week in effect; quick implies a standalone action; no deadline
    // keeps no lead days, and Todofy's blocked is no flag. updated_at is the later of the row's and the state's.
    assert.deepEqual(rows.get('due'), {
      id: 'due',
      stage: 'committed',
      committed_week: '2099-01-05',
      area: 'work',
      lead_days: 7,
      planning_flags: '["quick","task"]',
      revision: 2,
      updated_at: 1_790_000_100_000,
    });
    assert.deepEqual(rows.get('undated'), {
      id: 'undated',
      stage: 'weekly',
      committed_week: '',
      area: 'personal',
      lead_days: 0,
      planning_flags: '["waiting"]',
      revision: 2,
      updated_at: ROW_TIME,
    });
    assert.equal(rows.get('current').committed_week, '2026-01-05');
    assert.deepEqual([rows.get('done').area, rows.get('done').planning_flags], ['work', '["routine"]']);
    // Set in Tasks since the release, or nothing to import.
    for (const id of ['changed', 'plain', 'lead-only', 'gone'])
      assert.deepEqual(
        rows.get(id),
        before.planning.find((row) => row.id === id),
      );

    assert.deepEqual(dependencies(tasks), [
      ...before.dependencies,
      {
        task_id: 'due',
        prerequisite_id: 'undated',
        baseline_count: 2,
        created_at: 1_789_000_001_000,
        updated_at: 1_789_000_001_000,
        deleted_at: null,
      },
      {
        task_id: 'undated',
        prerequisite_id: 'done',
        baseline_count: 0,
        created_at: 1_789_000_002_000,
        updated_at: 1_789_000_002_000,
        deleted_at: null,
      },
    ]);
    assert.deepEqual(bets(tasks), [
      {
        week_start: '2026-10-12',
        area: 'personal',
        text: 'Synthetic rest — ünïcödé 🚀',
        type: 'text',
        revision: 1,
        updated_at: 1_789_400_000_000,
      },
      {
        week_start: '2026-10-19',
        area: 'work',
        text: "Owner's synthetic goal",
        type: 'text',
        revision: 1,
        updated_at: 1_789_500_000_000,
      },
      ...before.bets,
    ]);
    // In board order, without the tasks Tasks lacks, and each task in its first lane.
    assert.deepEqual(board(tasks), {
      lanes: '{"start":["due"],"waiting":["undated"],"committed":["current"]}',
      revision: 2,
      updated_at: 1_789_700_000_000,
    });

    const after = everything(tasks);
    tasks.exec(planningImportSql(plan));
    assert.deepEqual(everything(tasks), after);
    const again = preparePlanningImport(exported(paths));
    assert.deepEqual(again.counts, IMPORTED_COUNTS);
    assert.equal(planningImportSql(again), 'SELECT 0 AS pending_count;\n');
  } finally {
    tasks.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('never overwrites what Tasks changed between the export and the import', () => {
  const { dir, paths, tasks } = databases();
  try {
    const sql = planningImportSql(preparePlanningImport(exported(paths)));
    tasks.exec(`
      UPDATE tasks SET area='work',revision=2,updated_at=1790000000900 WHERE id='undated';
      UPDATE tasks SET deleted_at=1790000000900 WHERE id='done';
      INSERT INTO weekly_bets(week_start,area,text,created_at,updated_at)
        VALUES('2026-10-19','work','Written in Tasks',1790000000900,1790000000900);
      UPDATE plan_board SET lanes='{"weekly":["due"]}',revision=2,updated_at=1790000000900;
    `);
    const before = everything(tasks);
    tasks.exec(sql);
    const after = everything(tasks);

    assert.deepEqual(
      after.planning.find((row) => row.id === 'undated'),
      before.planning.find((row) => row.id === 'undated'),
    );
    assert.deepEqual(
      after.planning.find((row) => row.id === 'done'),
      before.planning.find((row) => row.id === 'done'),
    );
    assert.equal(after.planning.find((row) => row.id === 'due').stage, 'committed');
    assert.deepEqual(
      after.dependencies.map((row) => `${row.task_id}>${row.prerequisite_id}`),
      ['changed>due', 'due>undated'],
    );
    assert.equal(after.bets.find((row) => row.week_start === '2026-10-19').text, 'Written in Tasks');
    assert.deepEqual(after.board, before.board);

    const again = preparePlanningImport(exported(paths));
    assert.equal(again.counts.pending, 0);
    assert.deepEqual(again.counts.states, { all: 10, pending: 0, present: 4, empty: 2, orphan: 4 });
    assert.deepEqual(again.counts.dependencies, { all: 6, pending: 0, present: 2, orphan: 4 });
  } finally {
    tasks.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the imported rows read back through the Tasks API on real D1', async () => {
  const { dir, paths, tasks } = databases();
  tasks.close();
  const harness = await startHarness();
  try {
    for (const statement of TASKS_SEED) await harness.db.prepare(statement).run();
    const answers = exported(paths);
    // The Tasks answers come from the Worker's D1, in the shape wrangler prints.
    for (const { app, name, sql } of EXPORTS)
      if (app === 'tasks') answers[name] = [await harness.db.prepare(sql).all()];
    const plan = preparePlanningImport(answers);
    assert.deepEqual(plan.counts, PENDING_COUNTS);
    await harness.db.exec(planningImportSql(plan));

    const read = async (id) => (await harness.fetch(`/api/tasks/v1/tasks/${id}`)).json();
    const due = await read('due');
    assert.equal(due.stage, 'committed');
    assert.equal(due.area, 'work');
    assert.equal(due.lead_days, 7);
    assert.deepEqual(due.planning_flags, ['quick', 'task']);
    assert.deepEqual(due.dependencies, [{ prerequisite_id: 'undated', title: 'Synthetic undated' }]);
    const undated = await read('undated');
    assert.deepEqual(undated.planning_flags, ['waiting']);
    assert.deepEqual(undated.dependencies, [{ prerequisite_id: 'done', title: 'Synthetic done', done: true }]);
    // A commitment for a week that has ended reads as weekly.
    assert.equal((await read('current')).stage, 'weekly');

    const shown = await (await harness.fetch('/api/tasks/v1/plan')).json();
    assert.deepEqual(shown.lane_orders, [
      { lane: 'start', task_ids: ['due'] },
      { lane: 'waiting', task_ids: ['undated'] },
      { lane: 'committed', task_ids: ['current'] },
    ]);
    const stored = await harness.db
      .prepare("SELECT text FROM weekly_bets WHERE week_start='2026-10-12' AND area='personal'")
      .first();
    assert.equal(stored.text, 'Synthetic rest — ünïcödé 🚀');
  } finally {
    await harness.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses malformed exports and a plan it did not make', () => {
  const { dir, paths, tasks } = databases();
  try {
    tasks.close();
    const changed = (name, change) => {
      const answers = exported(paths);
      change(answers[name][0].results);
      return answers;
    };
    for (const answers of [
      { ...exported(paths), 'todofy.plan_edges': { results: [] } },
      changed('todofy.plan_tasks', (rows) => (rows[0].external_id = "x' OR 1=1 --")),
      changed('todofy.plan_tasks', (rows) => rows.push({ ...rows[0] })),
      changed('todofy.plan_task_state', (rows) => (rows[0].stage = 'someday')),
      changed('todofy.plan_task_state', (rows) => (rows[0].quick = 2)),
      changed('todofy.plan_notes', (rows) => (rows[0].period = '2026-10-20')),
      changed('todofy.plan_notes', (rows) => (rows[0].body = 'x'.repeat(161))),
      changed('todofy.plan_settings', (rows) => (rows[0].value = '{"lanes":{"start":"1"}}')),
      changed('tasks.plan_board', (rows) => rows.pop()),
    ])
      assert.throws(() => preparePlanningImport(answers), PlanningImportError);

    const unknownWeek = changed('todofy.plus_weeks', (rows) => rows.splice(0));
    unknownWeek['todofy.plus_settings'][0].results = [];
    assert.throws(() => preparePlanningImport(unknownWeek), /COMMITMENT_WEEK_UNKNOWN/);

    const plan = preparePlanningImport(exported(paths));
    plan.dependencies[0].task = "x' OR 1=1 --";
    assert.throws(() => planningImportSql(plan), /PLAN_INVALID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI lists the exports, prints counts only and writes the SQL privately outside the repository', () => {
  const { dir, paths, tasks } = databases();
  try {
    const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
    const listed = run('--exports');
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(
      listed.stdout.trimEnd().split('\n'),
      EXPORTS.map(({ app, name, sql }) => `${app}\t${name}\t${sql}`),
    );

    // As the workflow does: one `<name>.json` per answer in a private directory.
    const answers = join(dir, 'answers');
    mkdirSync(answers, { mode: 0o700 });
    const save = () => {
      for (const [name, value] of Object.entries(exported(paths)))
        writeFileSync(join(answers, `${name}.json`), JSON.stringify(value));
    };
    save();
    const dry = run('--dir', answers);
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(JSON.parse(dry.stdout), { event: 'tasks_planning_import', mode: 'dry_run', ...PENDING_COUNTS });
    assert.doesNotMatch(dry.stdout, /Synthetic|Owner|undated|lead-only|"due"/);
    const pending = run('--dir', answers, '--expect-none');
    assert.notEqual(pending.status, 0);
    assert.equal(pending.stderr.trim(), 'PLANNING_IMPORT_PENDING');

    const output = join(dir, 'import.sql');
    const written = run('--dir', answers, '--output', output);
    assert.equal(written.status, 0, written.stderr);
    assert.equal(JSON.parse(written.stdout).mode, 'private_sql_prepared');
    assert.equal(statSync(output).mode & 0o777, 0o600);
    // An existing file is never replaced, and the output may not land inside the repository.
    assert.notEqual(run('--dir', answers, '--output', output).status, 0);
    const inside = fileURLToPath(new URL('./import.sql', import.meta.url));
    const refused = run('--dir', answers, '--output', inside);
    assert.equal(refused.stderr.trim(), 'OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
    assert.throws(() => statSync(inside));

    tasks.exec(readFileSync(output, 'utf8'));
    save();
    const done = run('--dir', answers, '--expect-none');
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(JSON.parse(done.stdout), { event: 'tasks_planning_import', mode: 'dry_run', ...IMPORTED_COUNTS });

    // A malformed answer fails with a code, never with a message that could quote the exports.
    writeFileSync(join(answers, 'todofy.plan_notes.json'), '[{"results": [Synthetic private text');
    const broken = run('--dir', answers);
    assert.notEqual(broken.status, 0);
    assert.equal(broken.stderr.trim(), 'PLANNING_IMPORT_FAILED');
    assert.equal(broken.stdout, '');
  } finally {
    tasks.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
