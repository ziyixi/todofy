// tools/todofy-import.ts: synthetic Todofy and Tasks databases built from both apps' migrations, the EXPORTS run
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
import { EXPORTS, TodofyImportError, prepareTodofyImport, todofyImportSql } from '../todofy-import.ts';
import { encodePageToken } from '../../../proto/ts/page-token.ts';
import { startHarness } from '../../worker/test/runtime/harness.ts';

const TOOL = fileURLToPath(new URL('../prepare-todofy-import.ts', import.meta.url));
const MIGRATIONS = {
  todofy: fileURLToPath(new URL('../../../todofy/migrations/', import.meta.url)),
  tasks: fileURLToPath(new URL('../../migrations/', import.meta.url)),
};

/** Tasks after the release: its own count of 2026-10-20 and its own review of 2026-W43. */
const TASKS_SEED = [
  "INSERT INTO labels(id,title,created_at,updated_at) VALUES('l-quick','quick',1,1),('l-later','later',1,1)",
  "INSERT INTO labels(id,title,created_at,updated_at,deleted_at) VALUES('l-gone','gone',1,1,2)",
  "INSERT INTO projects(id,title,created_at,updated_at) VALUES('home-project','Synthetic ops',1,1),('review-project','Synthetic review',1,1)",
  'INSERT INTO gtd_days(day,scope,open,age_0_7,age_8_14,age_15_30,age_31_plus,oldest_days,overdue,undated,computed_at) ' +
    "VALUES('2026-10-20','all',99,0,0,0,0,0,0,0,1790000000000)",
  "INSERT INTO weekly_reviews(week,state,task_id,created_at) VALUES('2026-W43','created','tasks-review',1790000000000)",
];
/** What Todofy kept: GTD days and reviews, the Mail categories and the reminders' project. */
const TODOFY_SEED = [
  'INSERT INTO gtd_daily(day,scope,open,age_0_7,age_8_14,age_15_30,age_31_plus,oldest_days,overdue,undated,created_7d,' +
    'completed_7d,completed_source,closed_1d,mail_open,complete,computed_at) VALUES' +
    "('2026-10-19','all',30,10,8,7,5,61,3,12,9,11,'api',2,4,1,1789800000)," +
    "('2026-10-19','inbox',12,5,3,2,2,44,1,6,4,5,'api',NULL,NULL,1,1789800000)," +
    "('2026-10-20','all',31,10,8,7,6,62,4,12,NULL,NULL,'none',NULL,5,0,1789890000)," +
    "('2026-10-20','inbox',13,5,3,2,3,45,1,6,NULL,NULL,'none',NULL,NULL,0,1789890000)",
  'INSERT INTO gtd_reviews(week,state,project_id,task_id,subject,body,completed_at,created_at,updated_at) VALUES' +
    "('2026-W41','created','review-project','review-41','Review','Synthetic body',1789300000,1789200000,1789300000)," +
    "('2026-W42','sending','review-project','','Review','Synthetic body',NULL,1789800000,1789800000)," +
    "('2026-W43','failed','','','Review','Synthetic body',NULL,1789900000,1789900000)",
  'INSERT INTO plan_categories(id,scheme,name,priority,sort_order,archived_at,created_at,updated_at) VALUES' +
    "(1,'mail','quick · P4',4,0,NULL,1,1),(2,'mail','gone · P1',1,1,NULL,1,1),(3,'mail','old · P2',2,2,5,1,1)," +
    "(5,'mail','later · P2',2,3,NULL,1,1)",
  'INSERT INTO plan_settings(key,value,updated_at) VALUES' +
    `('todoist.mail','${JSON.stringify({
      categories: [
        { id: 1, label_id: 'l-quick', label: 'quick' },
        { id: 2, label_id: 'l-gone', label: 'gone' },
        { id: 5, label_id: 'l-later', label: 'later' },
      ],
      destination: '',
    })}',1)`,
  'INSERT INTO mail_reminders(day,state,task_id,subject,body,attention_count,created_at,updated_at,project_id) VALUES' +
    "('2026-10-18','created','r1','Reminder','Synthetic',1,1,1,'home-project')," +
    "('2026-10-19','created','r2','Reminder','Synthetic',1,1,1,'')," +
    "('2026-10-20','failed','','Reminder','Synthetic',1,1,1,'other-project')",
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
  const dir = mkdtempSync(join(tmpdir(), 'tasks-todofy-import-'));
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
const everything = (db) => ({
  days: plain(db.prepare('SELECT * FROM gtd_days ORDER BY day,scope').all()),
  reviews: plain(db.prepare('SELECT * FROM weekly_reviews ORDER BY week').all()),
  settings: { ...db.prepare("SELECT categories,next_category_id,revision FROM mail_settings WHERE id='mail'").get() },
  routes: plain(db.prepare('SELECT source,project_id FROM task_inbox_routes ORDER BY source').all()),
});

const PENDING_COUNTS = {
  days: { all: 4, pending: 3, present: 1, skipped: 0 },
  reviews: { all: 3, pending: 2, present: 1, skipped: 0 },
  categories: { all: 3, pending: 2, present: 0, skipped: 1 },
  routes: { all: 2, pending: 2, present: 0, skipped: 0 },
  pending: 9,
};
const IMPORTED_COUNTS = {
  days: { all: 4, pending: 0, present: 4, skipped: 0 },
  reviews: { all: 3, pending: 0, present: 3, skipped: 0 },
  categories: { all: 3, pending: 0, present: 3, skipped: 0 },
  routes: { all: 2, pending: 0, present: 2, skipped: 0 },
  pending: 0,
};
const CATEGORIES = '[{"id":1,"label_id":"l-quick","priority":4},{"id":5,"label_id":"l-later","priority":2}]';

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

test('copies the days, reviews, categories and routes Tasks lacks, once, and counts nothing pending afterwards', () => {
  const { dir, paths, tasks } = databases();
  try {
    const plan = prepareTodofyImport(exported(paths));
    assert.deepEqual(plan.counts, PENDING_COUNTS);
    const before = everything(tasks);
    tasks.exec(todofyImportSql(plan));
    const after = everything(tasks);

    // Todofy's values in milliseconds; Tasks' own count of 2026-10-20 wins.
    assert.deepEqual(after.days, [
      {
        day: '2026-10-19',
        scope: 'all',
        open: 30,
        age_0_7: 10,
        age_8_14: 8,
        age_15_30: 7,
        age_31_plus: 5,
        oldest_days: 61,
        overdue: 3,
        undated: 12,
        created_7d: 9,
        completed_7d: 11,
        closed_1d: 2,
        mail_open: 4,
        complete: 1,
        computed_at: 1_789_800_000_000,
      },
      { ...after.days[1], day: '2026-10-19', scope: 'inbox', open: 12, closed_1d: null, mail_open: null },
      before.days[0],
      { ...after.days[3], day: '2026-10-20', scope: 'inbox', open: 13, created_7d: null, complete: 0 },
    ]);
    // A review Todofy left sending reads as unknown; Tasks' own 2026-W43 stays.
    assert.deepEqual(after.reviews, [
      { week: '2026-W41', state: 'created', task_id: 'review-41', created_at: 1_789_200_000_000, completed_at: 1_789_300_000_000 },
      { week: '2026-W42', state: 'unknown', task_id: '', created_at: 1_789_800_000_000, completed_at: null },
      before.reviews[0],
    ]);
    // In Todofy's order with its IDs, without the deleted label's; the next ID passes the archived one.
    assert.deepEqual(after.settings, { categories: CATEGORIES, next_category_id: 6, revision: 2 });
    assert.ok(tasks.prepare("SELECT created_at FROM mail_settings WHERE id='mail'").get().created_at > 0);
    assert.deepEqual(after.routes, [
      { source: 'home', project_id: 'home-project' },
      { source: 'review', project_id: 'review-project' },
    ]);

    tasks.exec(todofyImportSql(plan));
    assert.deepEqual(everything(tasks), after);
    const again = prepareTodofyImport(exported(paths));
    assert.deepEqual(again.counts, IMPORTED_COUNTS);
    tasks.exec(todofyImportSql(again));
    assert.deepEqual(everything(tasks), after);
  } finally {
    tasks.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('never overwrites what Tasks wrote between the export and the import', () => {
  const { dir, paths, tasks } = databases();
  try {
    const sql = todofyImportSql(prepareTodofyImport(exported(paths)));
    // The owner saves categories in Tasks, a route appears, and the review project is deleted.
    tasks.exec(`
      UPDATE mail_settings SET categories='[{"id":1,"label_id":"l-later","priority":1}]',next_category_id=2,
        revision=2,created_at=1790000000900 WHERE id='mail';
      INSERT INTO task_inbox_routes(source,project_id,updated_at) VALUES('home','review-project',1);
      UPDATE projects SET deleted_at=1790000000900 WHERE id='review-project';
    `);
    const before = everything(tasks);
    tasks.exec(sql);
    const after = everything(tasks);
    assert.deepEqual(after.settings, before.settings);
    assert.deepEqual(after.routes, before.routes);
    assert.equal(after.days.length, 4);

    const again = prepareTodofyImport(exported(paths));
    assert.equal(again.counts.pending, 0);
    assert.deepEqual(again.counts.categories, { all: 3, pending: 0, present: 3, skipped: 0 });
    assert.deepEqual(again.counts.routes, { all: 2, pending: 0, present: 1, skipped: 1 });
  } finally {
    tasks.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the copied rows read back through the Tasks API on real D1', async () => {
  const { dir, paths, tasks } = databases();
  tasks.close();
  const harness = await startHarness();
  try {
    for (const statement of TASKS_SEED) await harness.db.prepare(statement).run();
    const answers = exported(paths);
    // The Tasks answers come from the Worker's D1, in the shape wrangler prints.
    for (const { app, name, sql } of EXPORTS)
      if (app === 'tasks') answers[name] = [await harness.db.prepare(sql).all()];
    const plan = prepareTodofyImport(answers);
    assert.deepEqual(plan.counts, PENDING_COUNTS);
    for (const statement of todofyImportSql(plan).trimEnd().split('\n')) await harness.db.prepare(statement).run();

    const read = async (path) => (await harness.fetch(`/api/tasks/v1/${path}`)).json();
    assert.deepEqual(await read('mailCategories'), {
      name: 'mailCategories',
      categories: [
        { id: '1', label_id: 'l-quick', priority: 4 },
        { id: '5', label_id: 'l-later', priority: 2 },
      ],
      etag: '2',
    });
    const reviews = await read('weeklyReviews');
    assert.deepEqual(
      reviews.weekly_reviews.map((review) => [review.name, review.state, review.review_task_id ?? '']),
      [
        ['weeklyReviews/2026-10-19', 'created', 'tasks-review'],
        ['weeklyReviews/2026-10-12', 'unknown', ''],
        ['weeklyReviews/2026-10-05', 'created', 'review-41'],
      ],
    );
    assert.equal(reviews.weekly_reviews[2].complete_time, '2026-09-13T11:46:40Z');
    const days = await read(`gtdDays?page_size=2&page_token=${encodePageToken('2026-10-20', {})}`);
    assert.deepEqual(
      days.gtd_days.map((day) => [day.name, day.recorded ?? false, day.all_projects?.open_count]),
      [
        ['gtdDays/2026-10-20', true, 99],
        ['gtdDays/2026-10-19', true, 30],
      ],
    );
    assert.equal(days.gtd_days[1].all_projects.open_mail_count, 4);
    assert.equal(days.gtd_days[1].inbox.oldest_age_days, 44);
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
      { ...exported(paths), 'todofy.gtd_daily': { results: [] } },
      changed('todofy.gtd_daily', (rows) => (rows[0].day = "2026-10-19' OR 1=1 --")),
      changed('todofy.gtd_daily', (rows) => (rows[0].open = -1)),
      changed('todofy.gtd_reviews', (rows) => (rows[0].state = 'someday')),
      changed('todofy.gtd_reviews', (rows) => (rows[0].task_id = "x' --")),
      changed('todofy.mail_categories', (rows) => (rows[0].priority = 5)),
      changed('todofy.mail_labels', (rows) => (rows[0].value = '{"categories":"x"}')),
      changed('todofy.next_category', (rows) => (rows[0].id = 2)),
      changed('todofy.routes', (rows) => (rows[0].home = 'a b')),
      changed('tasks.mail_settings', (rows) => rows.pop()),
    ])
      assert.throws(() => prepareTodofyImport(answers), TodofyImportError);

    const plan = prepareTodofyImport(exported(paths));
    plan.routes[0].projectId = "x' OR 1=1 --";
    assert.throws(() => todofyImportSql(plan), /PLAN_INVALID/);
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
    assert.deepEqual(JSON.parse(dry.stdout), { event: 'tasks_todofy_import', mode: 'dry_run', ...PENDING_COUNTS });
    assert.doesNotMatch(dry.stdout, /quick|later|project|review-41|Synthetic/);
    const pending = run('--dir', answers, '--expect-none');
    assert.notEqual(pending.status, 0);
    assert.equal(pending.stderr.trim(), 'TODOFY_IMPORT_PENDING');

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
    assert.deepEqual(JSON.parse(done.stdout), { event: 'tasks_todofy_import', mode: 'dry_run', ...IMPORTED_COUNTS });

    // A malformed answer fails with a code, never with a message that could quote the exports.
    writeFileSync(join(answers, 'todofy.mail_labels.json'), '[{"results": [Synthetic private text');
    const broken = run('--dir', answers);
    assert.notEqual(broken.status, 0);
    assert.equal(broken.stderr.trim(), 'TODOFY_IMPORT_FAILED');
    assert.equal(broken.stdout, '');
  } finally {
    tasks.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
