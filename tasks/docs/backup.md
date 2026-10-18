# Backup and restore

Tasks' D1 holds the only copy of every task, project and completion. Two copies protect it: D1 Time Travel
(7 days on Workers Free) for a recent mistake, and a weekly backup in Todofy's private R2 bucket for older
points and a lost database.

## What the weekly backup holds

Todofy's weekly backup job (`todofy/worker/todofy/runtime/backup.py`) runs every Sunday at 10:00 UTC and
copies Tasks' D1 together with Todofy's own. It reads Tasks through the existing read-write `TASKS`
binding and its machine-only `TasksApi.exportBackup` method (`worker/src/backup.ts`), which has no HTTP route
and refuses FlowDay's `read` binding. The backup adds no binding, bucket, cron, secret or retention of its
own:

- The rows go to `todofy-backups` under `backups/<job start>/tasks/<table>/<n>.ndjson.gz`, next to Todofy's
  tables. The manifest's `tasks` section lists Tasks' applied migration, each table's columns, key, row count
  and the SHA-256 of every part.
- Every table a restore needs is included: projects, sections, labels, filters, tasks, completions and request
  receipts. `task_labels` and the change feed are left out, because inserts rebuild them.
- The newest six complete backups are kept. Todofy's health page and Home show the last backup, and a failed
  or stale one (`backup_failed`, `backup_stale`). Without the `TASKS` binding a job fails with
  `tasks_unavailable`.
- The first job after the release that added Tasks runs at Todofy's next alarm instead of the next Sunday.

Todofy's ledger hold does not stop owner edits in Tasks, so the copy is a fuzzy snapshot: an edit made during
the minute or so the job runs may or may not be in it. The manifest records Tasks' change sequence when the job
planned and when it ended. The restore tool warns when they differ, and it refuses a backup whose live rows
reference rows it lacks.

## Recent mistake: Time Travel (within 7 days)

From `tasks/worker`, find the time just before the mistake and restore the database in place:

```sh
npx wrangler d1 time-travel info DB --config ../wrangler.toml
npx wrangler d1 time-travel restore DB --timestamp <RFC 3339 time> --config ../wrangler.toml
```

Then reset FlowDay's mirror (step 6 below). The change feed went back with the database, so FlowDay's cursor
is now ahead of it. FlowDay's Sync fails until the reset; Tasks reports the cursor problem instead of answering
"Synced".

## Full restore into a new database

`PRIV` is a private directory outside the repository, for example
`mkdir -m 700 ~/.local/share/tasks-restore && PRIV=$_`. The files written there hold task content; delete them
afterwards.

1. Set the GitHub variable `TODOFY_FORCE_PAUSE_TODOIST=true` and run the workflow on `main`. Todofy then stops
   creating tasks from mail, reminders and intents. Do not edit in Tasks, Plan or FlowDay until step 8.
2. From `tasks/worker`, create the new database: `npx wrangler d1 create tasks-restore`. It prints the new id.
3. From `todofy/`, download the backup whose key the health page shows. `download` checks every part,
   including the Tasks parts:
   ```sh
   python3 tools/backup_restore.py download --backup backups/<job start> --out "$PRIV/restore" --remote
   ```
4. From `tasks/`, write the restore config, apply the migrations, load the rows and verify the counts:
   ```sh
   node tools/backup-restore.ts config --database-name tasks-restore --database-id <the new id> \
     --out "$PRIV/tasks-restore.toml"
   (cd worker && npx wrangler d1 migrations apply DB --remote --config "$PRIV/tasks-restore.toml")
   node tools/backup-restore.ts sql --in "$PRIV/restore" --out "$PRIV/tasks-restore.sql"
   (cd worker && npx wrangler d1 execute DB --remote --config "$PRIV/tasks-restore.toml" --file "$PRIV/tasks-restore.sql")
   node tools/backup-restore.ts verify --in "$PRIV/restore" --config "$PRIV/tasks-restore.toml" --remote
   ```
   `config` writes a config with only the new database's `DB` binding, the committed account and
   `tasks/migrations` by absolute path; it has no Worker. It refuses the production database's id or name, a
   path inside the repository and an existing file. Never copy `tasks/wrangler.toml` for this: its
   `database_id` is the live database. `sql` checks every part again and writes one
   `INSERT ... ON CONFLICT DO NOTHING` per row, parents first, so a re-run after a partial load is safe. Triggers
   rebuild `task_labels`, `project_archived` and the change feed. `verify` ends with `verify PASS`.
5. Set the `tasks` entry of `[d1_databases]` in `config/resources.toml` to the new id. Then run
   `python3.12 tools/cloud-config/generate.py` (it rewrites `tasks/wrangler.toml`), commit and push to `main`.
   That push releases Tasks on the restored database. The committed `database_name` stays `tasks`, because
   wrangler binds the database by its id.
6. Reset FlowDay's mirror. It hides the mirrored tasks and forgets the Tasks cursor and catalog, and queues,
   timers and work records keep their task IDs. From `flowday/worker`:
   ```sh
   npx wrangler d1 execute DB --remote --config ../wrangler.toml --file ../deploy/reset-tasks-mirror.sql
   ```
   Open FlowDay and press Sync until it reports Synced. The replay brings back every task the restored database
   holds; a task deleted in FlowDay stays deleted.
7. Open `https://tasks.ziyixi.science/api/plus/v1/plan:verifyPlanStore`: planning reaches Todofy through the
   Tasks host, and the orphan counts are 0. Planning facts and Mail links of tasks created after the backup
   point at tasks the restored database lacks. Plan no longer shows those tasks, and converting such a Mail
   item creates a new Inbox task.
8. Set `TODOFY_FORCE_PAUSE_TODOIST=false` and run the workflow on `main`.

Keep the old database until the restored one has run for a while, then delete it on purpose
(`npx wrangler d1 delete <old name>`); it holds task content too.

A Todoist re-import ([import.md](import.md)) is not a recovery path. It only rebuilds the state of the
2026-10-17 cutover, and every native task, edit and completion since then would be lost.

## Rehearse locally

The same commands work on a local copy: pass `--local --persist-to "$PRIV/d1"` in place of `--remote` to
`migrations apply`, `execute` and `verify`, and any new UUID as the database id. `node --test
tasks/tools/test/backup-restore.test.mjs` and `todofy/tests/runtime/test_backup.py` (a real backup of a real
Tasks Worker, restored into a new local D1 and compared table by table) cover the tools with synthetic data.

## One-time FlowDay estimate backfill

Since 2026-10-18 a task's estimate is its Tasks duration alone. Before that, FlowDay kept its own estimate for a
mirrored task once the owner set one there (`estimate_override=1`), and Plan showed that value. Run this once,
right after the release that made the change: FlowDay's sync now replaces such an estimate as soon as its task
changes in Tasks. `tools/prepare-estimate-backfill.ts` (logic in `tools/estimate-backfill.ts`) copies every
FlowDay value that differs into Tasks with Tasks' own write semantics: `revision+1`, `updated_at` in
milliseconds and a change-feed row, so FlowDay's mirror learns the value. Each statement applies only to the
revision it read, so a task edited in between is left alone and counted again by the next dry run. Missing or
deleted tasks, values outside 0 to 10,080 minutes and malformed ids are skipped and counted.

From the repository root, with `PRIV` as above:

```sh
(cd flowday/worker && npx wrangler d1 execute DB --remote --config ../wrangler.toml --json \
  --command "SELECT id, estimated_mins FROM tasks WHERE estimate_override=1 AND todoist_id IS NOT NULL" \
  > "$PRIV/flowday-overrides.json")
(cd tasks/worker && npx wrangler d1 execute DB --remote --config ../wrangler.toml --json \
  --command "SELECT id, duration_minutes, revision FROM tasks WHERE deleted_at IS NULL" \
  > "$PRIV/tasks-durations.json")
# Dry run: prints counts only.
node tasks/tools/prepare-estimate-backfill.ts --flowday "$PRIV/flowday-overrides.json" --tasks "$PRIV/tasks-durations.json"
node tasks/tools/prepare-estimate-backfill.ts --flowday "$PRIV/flowday-overrides.json" --tasks "$PRIV/tasks-durations.json" \
  --output "$PRIV/estimate-backfill.sql"
# Note the current bookmark first, so Time Travel can undo the update.
(cd tasks/worker && npx wrangler d1 time-travel info DB --config ../wrangler.toml)
(cd tasks/worker && npx wrangler d1 execute DB --remote --config ../wrangler.toml --file "$PRIV/estimate-backfill.sql")
```

Then check it:

1. Export Tasks again (the second command) and dry-run: `update_count` is 0.
2. Open FlowDay and press Sync until it reports Synced. Export FlowDay again (the first command) and dry-run:
   `update_count` is still 0, because the mirror now shows the Tasks values.
3. Delete the three files in `$PRIV`; they hold task ids and estimates.

`node --test tasks/tools/test/estimate-backfill.test.mjs` covers the generator on synthetic rows.
