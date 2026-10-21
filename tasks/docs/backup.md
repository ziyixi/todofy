# Backup and restore

Tasks' D1 holds the only copy of every task, project and completion. Two copies protect it: D1 Time Travel
(7 days on Workers Free) for a recent mistake, and a weekly backup in Todofy's private R2 bucket for older
points and a lost database.

## What the weekly backup holds

Todofy's weekly backup job (`todofy/worker/todofy/runtime/backup.py`) runs every Sunday at 10:00 UTC and
copies Tasks' D1 together with Todofy's own. It reads Tasks through the existing read-write `TASKS`
binding and its machine-only `TasksApi.exportBackup` method (`worker/src/backup.ts`), which has no HTTP route
and refuses a `read` binding. The backup adds no binding, bucket, cron, secret or retention of its
own:

- The rows go to `todofy-backups` under `backups/<job start>/tasks/<table>/<n>.ndjson.gz`, next to Todofy's
  tables. The manifest's `tasks` section lists Tasks' applied migration, each table's columns, key, row count
  and the SHA-256 of every part.
- Every table a restore needs is included: projects, sections, labels, filters, tasks, completions, request
  receipts; since `0005_focus.sql`, Focus's day queues (`day_steps`), time records (`focus_entries`) and the one
  timer (`focus_timer`); and since `0006_planning.sql`, each task's planning columns, its dependencies
  (`task_dependencies`), the weekly goals (`weekly_bets`) and Plan's lane orders (`plan_board`). `task_labels` and
  the change feed are left out, because inserts rebuild them.
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

## Full restore into a new database

`PRIV` is a private directory outside the repository, for example
`mkdir -m 700 ~/.local/share/tasks-restore && PRIV=$_`. The files written there hold task content; delete them
afterwards.

1. Set the GitHub variable `TODOFY_FORCE_PAUSE_TODOIST=true` and run the workflow on `main`. Todofy then stops
   creating tasks from mail, reminders and intents. Do not edit in Tasks or Plan until step 7.
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
   rebuild `task_labels`, `project_archived` and the change feed. The backed-up timer and lane orders replace the
   idle timer and empty board the migrations seed. A backup made before `0005_focus.sql` has no Focus tables: `sql`
   says so in a `NOTE` line, they restore empty with the idle timer, and `verify` expects 0, 0 and 1 rows in them. A
   backup made before `0006_planning.sql` has no planning: its tasks take the columns' defaults (no stage,
   unassigned, no flags), and the three planning tables restore as migrated (0, 0 and 1 rows), named in a `NOTE`
   line. The planning facts of that time were in Todofy's planning store, which Todofy's migration
   `0013_drop_plan_store.sql` dropped; Todofy's backups made before it still hold them as files, and its restore
   tool leaves those tables out.
   A backup made before `0007_timer_pause.sql` has no `focus_timer.paused_at`: the timer restores without it, so a
   paused session resumes now.
   `verify` ends with `verify PASS`.
5. Switch the Tasks Worker to the new database. This step is not rehearsed, and a push alone does not do it:
   the release's preflight finds the live `DB` binding on the old id and stops (`STATEFUL_BINDING_CHANGED`
   needs a manual change).
   - Set the `tasks` entry of `[d1_databases]` in `config/resources.toml` to the new id, run
     `python3.12 tools/cloud-config/generate.py` (it rewrites `tasks/wrangler.toml`) and commit without pushing.
     The committed `database_name` stays `tasks`, because wrangler binds the database by its id.
   - From a clean checkout of that commit, deploy Tasks once by hand as `.github/actions/release-tasks` does,
     but without `--secrets-file`, so the Worker keeps its secrets:
     ```sh
     for dir in packages/planning-ui packages/task-dates tasks/worker tasks/web; do npm ci --prefix "$dir"; done
     npm run build --prefix tasks/web
     (cd tasks/worker && GITHUB_SHA=$(git rev-parse HEAD) node ../deploy/deploy-vars.mjs exec -- \
       npx --no-install wrangler deploy --config ../wrangler.toml)
     ```
     From `tasks/worker`, `npx wrangler deployments status --config ../wrangler.toml` names the version, and
     `npx wrangler versions view <that version> --config ../wrangler.toml` lists `DB` with the new id. Go on
     to step 6 only then.
   - Push the commit to `main`. Its preflight now finds the binding it expects and releases the same code.
   - `infra/` still holds the old database as `cloudflare_d1_database.app["tasks"]`, so "Infra drift" and the
     reconcile report the id difference, and the new database as unregistered, until the infra state is moved
     to it ([import notes](../../infra/README.md#import-notes)). Keep the old database until then.
6. Open Plan: the restored tasks carry their planning facts and dependencies. Mail links of tasks created after
   the backup point at tasks the restored database lacks; converting such a Mail item creates a new Inbox task.
7. Set `TODOFY_FORCE_PAUSE_TODOIST=false` and run the workflow on `main`.
8. Open Focus. The timer comes back as it was backed up: a session that was running then still runs, counting from
   then (at most 4 hours, or its pomodoro's length). Stop it, then fix the new record's minutes if needed.

Keep the old database until the restored one has run for a while, then delete it on purpose
(`npx wrangler d1 delete <old name>`); it holds task content too.

A Todoist re-import ([import.md](import.md)) is not a recovery path. It only rebuilds the state of the
2026-10-17 cutover, and every native task, edit and completion since then would be lost.

## Rehearse locally

The same commands work on a local copy: pass `--local --persist-to "$PRIV/d1"` in place of `--remote` to
`migrations apply`, `execute` and `verify`, and any new UUID as the database id. `node --test
tasks/tools/test/backup-restore.test.mjs` and `todofy/tests/runtime/test_backup.py` (a real backup of a real
Tasks Worker, restored into a new local D1 and compared table by table) cover the tools with synthetic data.

## One-time planning import

Until the release that added `0006_planning.sql`, Todofy kept each task's planning facts, the dependencies, the
weekly goals and Plan's lane orders. Right after that release, on 2026-10-20, the owner ran the one-time Tasks
planning import, which copied them into Tasks; its last dry run counted 0 pending. Its workflow, generator and tests
were then deleted; they are at `777d5f01` (`git show 777d5f01:tasks/tools/planning-import.ts`). Todofy's migration
`0013_drop_plan_store.sql` dropped the store it read.
