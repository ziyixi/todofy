// tools/estimate-backfill.ts on node:sqlite: synthetic FlowDay overrides and Tasks rows exported the way
// `wrangler d1 execute --json` answers, and the generated SQL applied to a database with Tasks' migrations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { EstimateBackfillError, estimateBackfillSql, prepareEstimateBackfill } from '../estimate-backfill.ts';

const TOOL = fileURLToPath(new URL('../prepare-estimate-backfill.ts', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));
const NOW = 1_792_000_000_123;

function migrated() {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS, name), 'utf8'));
  db.exec(`
    INSERT INTO tasks(id,title,duration_minutes,revision,created_at,updated_at) VALUES
      ('same','Synthetic same',30,2,1,1000),('differs','Synthetic differs',0,3,1,1000),
      ('cleared','Synthetic cleared',45,1,1,1000),('stale','Synthetic stale',10,5,1,1000),
      ('untouched','Synthetic untouched',25,4,1,1000);
    INSERT INTO tasks(id,title,duration_minutes,created_at,updated_at,deleted_at)
      VALUES('deleted','Synthetic deleted',5,1,1000,2000);
  `);
  return db;
}

/** What `wrangler d1 execute --json --command <sql>` prints. */
const answer = (results) => [{ results, success: true, meta: {} }];
const tasksExport = (db) =>
  answer(db.prepare('SELECT id, duration_minutes, revision FROM tasks WHERE deleted_at IS NULL').all());
const flowdayExport = () =>
  answer([
    { id: 'same', estimated_mins: 30 },
    { id: 'differs', estimated_mins: 90 },
    { id: 'cleared', estimated_mins: null },
    { id: 'stale', estimated_mins: 20 },
    { id: 'deleted', estimated_mins: 15 },
    { id: 'missing', estimated_mins: 15 },
    { id: 'bad id', estimated_mins: 15 },
    { id: 'too-long', estimated_mins: 10081 },
    { id: 'fraction', estimated_mins: 12.5 },
  ]);
const rows = (db) =>
  db
    .prepare('SELECT id, duration_minutes, revision, updated_at FROM tasks ORDER BY id')
    .all()
    .map((row) => ({ ...row }));

test("copies FlowDay's differing estimates with Tasks' write semantics and skips everything else", () => {
  const db = migrated();
  const plan = prepareEstimateBackfill(flowdayExport(), tasksExport(db), NOW);
  assert.deepEqual(plan.updates, [
    { id: 'cleared', minutes: 0, revision: 1 },
    { id: 'differs', minutes: 90, revision: 3 },
    { id: 'stale', minutes: 20, revision: 5 },
  ]);
  assert.equal(plan.overrides, 9);
  assert.equal(plan.unchanged, 1);
  assert.deepEqual(plan.skipped, { missing: 2, invalidValue: 2, invalidId: 1 });

  const before = rows(db);
  // Edited in Tasks after the export: its statement no longer matches the revision.
  db.exec("UPDATE tasks SET title='Edited elsewhere',revision=6,updated_at=1500 WHERE id='stale'");
  const sequence = db.prepare('SELECT max(sequence) AS m FROM changes').get().m;
  db.exec(estimateBackfillSql(plan));

  const after = new Map(rows(db).map((row) => [row.id, row]));
  assert.deepEqual(after.get('differs'), { id: 'differs', duration_minutes: 90, revision: 4, updated_at: NOW });
  assert.deepEqual(after.get('cleared'), { id: 'cleared', duration_minutes: 0, revision: 2, updated_at: NOW });
  assert.deepEqual(after.get('stale'), { id: 'stale', duration_minutes: 10, revision: 6, updated_at: 1500 });
  for (const id of ['same', 'untouched', 'deleted'])
    assert.deepEqual(
      after.get(id),
      before.find((row) => row.id === id),
    );
  // The tasks_update trigger appended one change row per applied update, so FlowDay's mirror learns the value.
  assert.deepEqual(
    db
      .prepare('SELECT resource, resource_id, changed_at FROM changes WHERE sequence > ? ORDER BY sequence')
      .all(sequence)
      .map((row) => ({ ...row })),
    [
      { resource: 'tasks', resource_id: 'cleared', changed_at: NOW },
      { resource: 'tasks', resource_id: 'differs', changed_at: NOW },
    ],
  );

  // A dry run against the new Tasks state finds only the task edited elsewhere, at its new revision.
  const again = prepareEstimateBackfill(flowdayExport(), tasksExport(db), NOW + 1);
  assert.deepEqual(again.updates, [{ id: 'stale', minutes: 20, revision: 6 }]);
});

test('a re-run after everything applied prepares no update', () => {
  const db = migrated();
  db.exec(estimateBackfillSql(prepareEstimateBackfill(flowdayExport(), tasksExport(db), NOW)));
  const again = prepareEstimateBackfill(flowdayExport(), tasksExport(db), NOW + 1);
  assert.equal(again.updates.length, 0);
  assert.equal(again.unchanged, 4);
  assert.equal(estimateBackfillSql(again), 'SELECT 0 AS updated_count;\n');
});

test('refuses exports that are not wrangler JSON answers or carry malformed Tasks rows', () => {
  const db = migrated();
  for (const [flowday, tasks] of [
    [{ results: [] }, tasksExport(db)],
    [flowdayExport(), [{ success: true }]],
    [flowdayExport(), answer([{ id: 'x', duration_minutes: '5', revision: 1 }])],
    [flowdayExport(), answer([{ id: 'x', duration_minutes: 5, revision: 0 }])],
    [
      answer([
        { id: 'same', estimated_mins: 1 },
        { id: 'same', estimated_mins: 2 },
      ]),
      tasksExport(db),
    ],
  ])
    assert.throws(() => prepareEstimateBackfill(flowday, tasks, NOW), EstimateBackfillError);
  assert.throws(() => prepareEstimateBackfill(flowdayExport(), tasksExport(db), 0), EstimateBackfillError);
  assert.throws(
    () => estimateBackfillSql({ updates: [{ id: "x' OR 1=1 --", minutes: 1, revision: 1 }], now: NOW }),
    EstimateBackfillError,
  );
});

test('the CLI dry run prints counts only, and --output writes a private file outside the repository', () => {
  const db = migrated();
  const dir = mkdtempSync(join(tmpdir(), 'tasks-estimates-'));
  try {
    writeFileSync(join(dir, 'flowday.json'), JSON.stringify(flowdayExport()));
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify(tasksExport(db)));
    const args = [TOOL, '--flowday', join(dir, 'flowday.json'), '--tasks', join(dir, 'tasks.json')];
    const dry = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(JSON.parse(dry.stdout), {
      event: 'flowday_estimate_backfill',
      mode: 'dry_run',
      override_count: 9,
      update_count: 3,
      unchanged_count: 1,
      skipped_missing_count: 2,
      skipped_invalid_value_count: 2,
      skipped_invalid_id_count: 1,
    });
    assert.doesNotMatch(dry.stdout, /Synthetic|differs|cleared/);

    const output = join(dir, 'estimates.sql');
    const written = spawnSync(process.execPath, [...args, '--output', output], { encoding: 'utf8' });
    assert.equal(written.status, 0, written.stderr);
    assert.equal(JSON.parse(written.stdout).mode, 'private_sql_prepared');
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(readFileSync(output, 'utf8').split('\n').filter(Boolean).length, 3);
    // An existing file is never replaced, and the output may not land inside the repository.
    assert.notEqual(spawnSync(process.execPath, [...args, '--output', output], { encoding: 'utf8' }).status, 0);
    const inside = fileURLToPath(new URL('./estimates.sql', import.meta.url));
    const refused = spawnSync(process.execPath, [...args, '--output', inside], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.equal(refused.stderr.trim(), 'OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
    assert.throws(() => statSync(inside));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
