// tools/backup-restore.ts on node:sqlite: synthetic Tasks rows exported the way the backup stores them (gzip NDJSON
// parts and a manifest), turned into SQL and loaded into a database with only the migrations applied. The real
// export, download and wrangler commands run in todofy/tests/runtime/test_backup.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  FOCUS_TABLES,
  PLANNING_TABLES,
  RESTORE_ORDER,
  RestoreError,
  readBackup,
  restoreConfig,
  restoreSql,
} from '../backup-restore.ts';

const TOOL = fileURLToPath(new URL('../backup-restore.ts', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));
const FILES = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const PREFIX = 'backups/2026-10-18T100000Z/tasks/';
const PRODUCTION = readFileSync(fileURLToPath(new URL('../../wrangler.toml', import.meta.url)), 'utf8');
const PRODUCTION_ID = /database_id = "([^"]+)"/.exec(PRODUCTION)[1];

function migrated(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)');
  for (const name of FILES) {
    db.exec(readFileSync(join(MIGRATIONS, name), 'utf8'));
    db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(name);
  }
  return db;
}

function seed(db) {
  db.exec(`
    INSERT INTO projects(id,title,parent_id,inbox,sort_order,created_at,updated_at) VALUES
      ('inbox','Inbox','',1,0,1,1),('work','Synthetic work','',0,1.5,1,2),('nested','Synthetic nested','work',0,2,1,3);
    INSERT INTO projects(id,title,created_at,updated_at,deleted_at) VALUES('gone','Deleted project',1,1,5);
    INSERT INTO sections(id,title,project_id,created_at,updated_at) VALUES('s1','段落','work',1,1);
    INSERT INTO labels(id,title,color,created_at,updated_at) VALUES('l1','synthetic','#246fe0',1,1);
    INSERT INTO labels(id,title,created_at,updated_at,deleted_at) VALUES('l-old','old',1,1,4);
    INSERT INTO filters(id,title,query,color,created_at,updated_at) VALUES('f1','Synthetic','today & #Inbox','#db4035',1,1);
    INSERT INTO tasks(id,title,project_id,section_id,label_ids,sort_order,revision,created_at,updated_at)
      VALUES('t-child','Stored first','work','s1','["l1"]',0.30000000000000004,4,1,1);
    INSERT INTO tasks(id,title,project_id,sort_order,recurrence,due_date,created_at,updated_at)
      VALUES('t-parent','Stored second','work',2,'every week','2026-10-20',1,1);
    UPDATE tasks SET parent_id='t-parent', kind='step' WHERE id='t-child';
    INSERT INTO tasks(id,title,project_id,parent_id,label_ids,created_at,updated_at,deleted_at)
      VALUES('t-deleted','Deleted under a deleted project','gone','t-missing','["l-old"]',1,1,9);
    INSERT INTO tasks(id,title,completed,completed_at,created_at,updated_at) VALUES('t-done','Done',1,7,1,7);
    INSERT INTO completions(sequence,id,task_id,title,completed_at,imported) VALUES
      (5,'c5','t-parent','Stored second',3,1),(9,'c9','t-done','Done',7,0);
    INSERT INTO requests(id,fingerprint,response,created_at,revision_guard)
      VALUES('00000000-0000-4000-8000-000000000009','f','{"title":"it''s"}',1,1);
    INSERT INTO day_steps(day,task_id,position,done_at,created_at,updated_at) VALUES
      ('2026-10-19','t-child',1.5,NULL,1,1),('2026-10-19','t-done',0.75,7,1,7);
    INSERT INTO focus_entries(id,task_id,day,seconds,started_at,source,area,created_at,updated_at) VALUES
      ('e-timer','t-done','2026-10-19',1500,5,'timer','work',7,7),('e-manual','t-child','2026-10-18',900,NULL,'manual','',3,3);
    UPDATE focus_timer SET state='running',task_id='t-child',day='2026-10-19',area='personal',started_at=10,
      segment_start=12,saved_seconds=60,revision=3,updated_at=12 WHERE id='timer';
    UPDATE tasks SET stage='committed',committed_week='2026-10-19',area='work',lead_days=3,deadline='2026-10-23',
      planning_flags='["active"]' WHERE id='t-parent';
    INSERT INTO task_dependencies(task_id,prerequisite_id,baseline_count,created_at,updated_at,deleted_at) VALUES
      ('t-parent','t-done',0,2,2,NULL),('t-child','t-parent',4,3,5,5);
    INSERT INTO weekly_bets(week_start,area,text,revision,created_at,updated_at) VALUES
      ('2026-10-19','work','Synthetic “goal” it''s',2,1,3);
    UPDATE plan_board SET lanes='{"committed":["t-parent"]}',revision=4,created_at=1,updated_at=6 WHERE id='board';
  `);
  db.prepare("INSERT INTO tasks(id,title,description,created_at,updated_at) VALUES('t-nul','NUL',?,1,1)").run(
    "a\0b “quoted” it's\n第二行",
  );
}

function columns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);
}

/** The tasks columns 0006_planning.sql added, which an older backup's tasks lack. */
const PLANNING_COLUMNS = ['stage', 'committed_week', 'area', 'lead_days', 'planning_flags'];
/**
 * What Todofy's job stores for the Tasks section: two parts per table, skipping the rows `skip` names. A backup made
 * before 0006_planning.sql has neither its tables nor its tasks columns (`beforePlanning`).
 */
function backupOf(
  db,
  root,
  { skip = () => false, change = { start: 3, end: 3 }, tables: names = RESTORE_ORDER, beforePlanning = false } = {},
) {
  const tables = names.map((name) => {
    const names = columns(db, name).filter(
      (column) => !(beforePlanning && name === 'tasks' && PLANNING_COLUMNS.includes(column)),
    );
    const rows = db
      .prepare(`SELECT ${names.join(',')} FROM ${name} ORDER BY rowid`)
      .all()
      .filter((row) => !skip(name, row))
      .map((row) => JSON.stringify(names.map((column) => row[column])));
    const parts = [rows.slice(0, 2), rows.slice(2)]
      .filter((part) => part.length)
      .map((lines, index) => {
        const data = gzipSync(lines.join('\n') + '\n');
        const key = `${PREFIX}${name}/${String(index + 1).padStart(5, '0')}.ndjson.gz`;
        mkdirSync(dirname(join(root, 'parts', key)), { recursive: true });
        writeFileSync(join(root, 'parts', key), data);
        return { key, rows: lines.length, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
      });
    return { name, columns: names, key: ['id'], max_rowid: 0, rows: rows.length, bytes: 0, parts };
  });
  const tasks = { schema_version: FILES.at(-1), change_sequence: change, tables };
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ format: 'todofy-d1-backup-v1', tables: [], tasks }));
}

function dump(db) {
  const keys = {
    completions: 'sequence',
    day_steps: 'day,task_id',
    task_dependencies: 'task_id,prerequisite_id',
    weekly_bets: 'week_start,area',
  };
  return Object.fromEntries(
    [...RESTORE_ORDER, 'task_labels'].map((name) => [
      name,
      db
        .prepare(`SELECT * FROM ${name} ORDER BY ${keys[name] ?? (name === 'task_labels' ? 'task_id,label_id' : 'id')}`)
        .all(),
    ]),
  );
}

function withBackup(run, options) {
  const root = mkdtempSync(join(tmpdir(), 'tasks-restore-test-'));
  try {
    const source = migrated();
    seed(source);
    backupOf(source, root, options);
    return run(root, source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('every table but the derived ones is restored, in an order its references allow', () => {
  const tables = migrated()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name)
    .filter((name) => !['d1_migrations', 'changes', 'task_labels'].includes(name));
  assert.deepEqual([...tables].sort(), [...RESTORE_ORDER].sort());
});

test('a backup round-trips with its ids, revisions, sequences and labels, and a re-run changes nothing', () =>
  withBackup((root, source) => {
    const { sql, statements } = restoreSql(readBackup(root));
    // Every row, and one DELETE of the migration's idle timer and of its empty board before the backed-up ones.
    assert.equal(statements, 4 + 1 + 2 + 1 + 5 + 2 + 1 + 2 + 2 + 1 + 1 + 2 + 1 + 1 + 1);
    const lines = sql.split('\n');
    const at = (id) => lines.findIndex((line) => line.startsWith('INSERT INTO tasks(') && line.includes(`'${id}'`));
    assert.ok(at('t-parent') < at('t-child'), 'the parent, stored after its child, is inserted first');
    assert.ok(sql.includes("CAST(X'"), 'a NUL travels as a blob cast');
    const target = migrated();
    target.exec(sql);
    target.exec(sql);
    assert.deepEqual(dump(target), dump(source));
    assert.ok(target.prepare('SELECT count(*) AS n FROM changes').get().n > 0, 'the inserts rebuilt the change feed');
    assert.equal(target.prepare("SELECT state FROM focus_timer WHERE id='timer'").get().state, 'running');
    assert.equal(target.prepare("SELECT revision FROM plan_board WHERE id='board'").get().revision, 4);
    target.exec("INSERT INTO completions(id,task_id,title,completed_at) VALUES('c-new','t-done','Done',8)");
    assert.equal(target.prepare("SELECT sequence FROM completions WHERE id='c-new'").get().sequence, 10);
  }));

const BEFORE_FOCUS = RESTORE_ORDER.filter((name) => !FOCUS_TABLES.includes(name) && !PLANNING_TABLES.includes(name));
const BEFORE_PLANNING = RESTORE_ORDER.filter((name) => !PLANNING_TABLES.includes(name));

test('a backup made before the Focus tables restores them empty, with the idle timer', () =>
  withBackup(
    (root, source) => {
      const backup = readBackup(root);
      assert.deepEqual(
        backup.section.tables.map((table) => table.name),
        BEFORE_FOCUS,
      );
      const target = migrated();
      target.exec(restoreSql(backup).sql);
      const restored = dump(target);
      const before = dump(source);
      for (const name of BEFORE_FOCUS) assert.deepEqual(restored[name], before[name], name);
      assert.deepEqual(restored.day_steps, []);
      assert.deepEqual(restored.focus_entries, []);
      assert.deepEqual(
        restored.focus_timer.map(({ id, state, task_id, revision }) => ({ id, state, task_id, revision })),
        [{ id: 'timer', state: 'idle', task_id: '', revision: 1 }],
      );
    },
    { tables: BEFORE_FOCUS },
  ));

test('a backup made before planning moved into Tasks restores no planning facts, and the empty board', () =>
  withBackup(
    (root, source) => {
      const backup = readBackup(root);
      assert.deepEqual(
        backup.section.tables.map((table) => table.name),
        BEFORE_PLANNING,
      );
      const target = migrated();
      target.exec(restoreSql(backup).sql);
      const restored = dump(target);
      const before = dump(source);
      for (const name of BEFORE_PLANNING.filter((table) => table !== 'tasks'))
        assert.deepEqual(restored[name], before[name], name);
      const unplanned = (row) => ({
        ...row,
        stage: 'none',
        committed_week: '',
        area: 'unassigned',
        lead_days: 0,
        planning_flags: '[]',
      });
      assert.deepEqual(
        restored.tasks.map((row) => ({ ...row })),
        before.tasks.map(unplanned),
      );
      assert.deepEqual(restored.task_dependencies, []);
      assert.deepEqual(restored.weekly_bets, []);
      assert.deepEqual(
        restored.plan_board.map(({ id, lanes, revision }) => ({ id, lanes, revision })),
        [{ id: 'board', lanes: '{}', revision: 1 }],
      );
    },
    { tables: BEFORE_PLANNING, beforePlanning: true },
  ));

test('a backup with only some of the Focus tables is refused', () =>
  withBackup(
    (root) => {
      assert.throws(() => readBackup(root), /unexpected Tasks tables: .*day_steps, focus_entries, task_dependencies/);
    },
    { tables: RESTORE_ORDER.filter((name) => name !== 'focus_timer') },
  ));

test('a live row whose reference is missing from the backup is refused by id', () =>
  withBackup(
    (root) => {
      assert.throws(
        () => restoreSql(readBackup(root)),
        (error) => {
          assert.ok(error instanceof RestoreError);
          assert.match(error.message, /tasks\/t-child: label l1/);
          assert.match(error.message, /tasks\/t-child: section s1/);
          assert.doesNotMatch(error.message, /Stored first|synthetic|段落/);
          return true;
        },
      );
    },
    { skip: (table, row) => (table === 'labels' || table === 'sections') && ['l1', 's1'].includes(row.id) },
  ));

test('a part that differs from its manifest is refused', () =>
  withBackup((root) => {
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    const part = manifest.tasks.tables[4].parts[0];
    const path = join(root, 'parts', part.key);
    const data = readFileSync(path);
    data[data.length >> 1] ^= 1;
    writeFileSync(path, data);
    assert.throws(() => readBackup(root), /tasks\/00001\.ndjson\.gz: SHA-256 differs/);
    rmSync(path);
    assert.throws(() => readBackup(root), /tasks\/00001\.ndjson\.gz: missing/);
  }));

test('the config names only a new database, outside the repository, and never overwrites', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  const config = restoreConfig('tasks-restore', id);
  assert.match(config, new RegExp(`database_id = "${id}"`));
  assert.match(config, /migrations_dir = "\/.*\/tasks\/migrations"/);
  assert.doesNotMatch(config, /^(name|main) =/m);
  assert.throws(() => restoreConfig('tasks', id), /production database/);
  assert.throws(() => restoreConfig('tasks-restore', PRODUCTION_ID), /production database/);
  assert.throws(() => restoreConfig('tasks-restore', 'not-a-uuid'), /not a D1 database id/);
  const directory = mkdtempSync(join(tmpdir(), 'tasks-restore-config-'));
  try {
    const out = join(directory, 'restore.toml');
    const run = (target) =>
      spawnSync('node', [TOOL, 'config', '--database-name', 'tasks-restore', '--database-id', id, '--out', target], {
        encoding: 'utf8',
      });
    assert.equal(run(out).status, 0);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.match(run(out).stderr, /exists; nothing was written/);
    const inside = run(fileURLToPath(new URL('../do-not-create.toml', import.meta.url)));
    assert.equal(inside.status, 1);
    assert.match(inside.stderr, /OUTSIDE_REPOSITORY/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The SQL loaded into a node:sqlite file, and `verify` against it through a stand-in for `wrangler d1 execute`. */
function loaded(root, sql) {
  const file = join(root, 'target.sqlite');
  const target = migrated(file);
  target.exec(readFileSync(sql, 'utf8'));
  target.close();
  const wrangler = join(root, 'wrangler.mjs');
  writeFileSync(
    wrangler,
    `import { DatabaseSync } from 'node:sqlite';
const args = process.argv.slice(2);
const db = new DatabaseSync(process.env.TASKS_TARGET);
console.log(JSON.stringify([{ results: db.prepare(args[args.indexOf('--command') + 1]).all(), success: true }]));`,
  );
  const verify = () =>
    spawnSync('node', [TOOL, 'verify', '--in', root, '--config', 'unused.toml', '--local', '--wrangler', `node ${wrangler}`], {
      encoding: 'utf8',
      env: { ...process.env, TASKS_TARGET: file },
    });
  return { file, verify };
}

test('the CLI restores and verifies a backup made before the Focus tables', () =>
  withBackup(
    (root) => {
      const out = join(root, 'restore.sql');
      const written = execFileSync('node', [TOOL, 'sql', '--in', root, '--out', out], { encoding: 'utf8' });
      assert.match(written, /\nNOTE day_steps, focus_entries, focus_timer: not in this backup \(made before 0005/);
      assert.match(
        written,
        /\nNOTE task_dependencies, weekly_bets, plan_board: not in this backup \(made before 0006/,
      );
      const passed = loaded(root, out).verify();
      assert.equal(passed.status, 0, passed.stderr);
      assert.match(
        passed.stdout,
        /PASS requests rows=1\/1\nPASS day_steps rows=0\/0\nPASS focus_entries rows=0\/0\nPASS focus_timer rows=1\/1\nPASS task_dependencies rows=0\/0\nPASS weekly_bets rows=0\/0\nPASS plan_board rows=1\/1\nverify PASS\n$/,
      );
    },
    { tables: BEFORE_FOCUS, beforePlanning: true },
  ));

test('the CLI writes the SQL owner-only, warns about a moving snapshot and verifies the loaded database', () =>
  withBackup(
    (root) => {
      const out = join(root, 'restore.sql');
      const written = execFileSync('node', [TOOL, 'sql', '--in', root, '--out', out], { encoding: 'utf8' });
      assert.equal(statSync(out).mode & 0o777, 0o600);
      assert.match(written, /^WARN Tasks changed while the backup ran \(change 3 to 4\)/);
      assert.match(written, /PASS tasks rows=5\n/);
      assert.doesNotMatch(written, /Stored|synthetic|段落|NOTE/);
      const { file, verify } = loaded(root, out);
      const passed = verify();
      assert.equal(passed.status, 0, passed.stderr);
      assert.match(passed.stdout, new RegExp(`PASS schema_version ${FILES.at(-1)}\n`));
      assert.match(
        passed.stdout,
        /PASS requests rows=1\/1\nPASS day_steps rows=2\/2\nPASS focus_entries rows=2\/2\nPASS focus_timer rows=1\/1\nPASS task_dependencies rows=2\/2\nPASS weekly_bets rows=1\/1\nPASS plan_board rows=1\/1\nverify PASS\n$/,
      );
      new DatabaseSync(file).exec('DELETE FROM requests');
      const failed = verify();
      assert.equal(failed.status, 1);
      assert.match(failed.stdout, /FAIL requests rows=0\/1\n(?:PASS [a-z_]+ rows=\d+\/\d+\n)+verify FAIL\n$/);
    },
    { change: { start: 3, end: 4 } },
  ));
