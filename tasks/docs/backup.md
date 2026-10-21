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
  (`task_dependencies`), the weekly goals (`weekly_bets`) and Plan's lane orders (`plan_board`); and since
  `0008_mail_gtd_inbox.sql`, the mail categories (`mail_settings`), the GTD days (`gtd_days`), the weekly reviews
  (`weekly_reviews`), TaskInbox's routes (`task_inbox_routes`) and its daily counts (`task_inbox_days`).
  `task_labels` and the change feed are left out, because inserts rebuild them.
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

1. Do not edit in Tasks or Plan until step 7. Nothing else needs pausing: Home's daily task and Watch's
   notifications retry their frozen requests, and the GTD day and the weekly review are idempotent. A task a machine
   writer creates before the switch is in the old database only.
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
   rebuild `task_labels`, `project_archived` and the change feed. The backed-up timer, lane orders and mail
   categories replace the idle timer, empty board and empty categories the migrations seed. A backup made before `0005_focus.sql` has no Focus tables: `sql`
   says so in a `NOTE` line, they restore empty with the idle timer, and `verify` expects 0, 0 and 1 rows in them. A
   backup made before `0006_planning.sql` has no planning: its tasks take the columns' defaults (no stage,
   unassigned, no flags), and the three planning tables restore as migrated (0, 0 and 1 rows), named in a `NOTE`
   line. The planning facts of that time were in Todofy's planning store, which Todofy's migration
   `0013_drop_plan_store.sql` dropped; Todofy's backups made before it still hold them as files, and its restore
   tool leaves those tables out.
   A backup made before `0007_timer_pause.sql` has no `focus_timer.paused_at`: the timer restores without it, so a
   paused session resumes now. A backup made before `0008_mail_gtd_inbox.sql` has none of its five tables: they
   restore as migrated (no mail categories, 1 row in `mail_settings` and none in the others), named in a `NOTE`
   line.
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
7. Open Mail and GTD: Mail lists the pending mail and the categories, and GTD the restored days.
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

## One-time Todofy import

Until the release that added `0008_mail_gtd_inbox.sql`, Todofy kept the GTD days and weekly reviews, the Mail
categories and, as frozen rows, the projects its daily reminder and review went to. Since then Tasks keeps them and
nothing writes Todofy's copies, so right after that release `tools/prepare-todofy-import.ts` (logic in
`tools/todofy-import.ts`) copies them into Tasks:

- Every GTD day and weekly review Tasks lacks, with Todofy's values; times become milliseconds, and a review Todofy
  left `sending` reads as `unknown`, as Todofy read it. A day or week Tasks has already is left as it is.
- The Mail categories whose labels are live in Tasks, in their order with their IDs, and the next ID. They are
  copied once: the statement needs `mail_settings.created_at` 0 and records when it ran, so a set the owner saved in
  Tasks first is never replaced. A category whose label is gone is counted as `skipped`.
- The project of the newest reminder and of the newest review Todofy created, as the routes `home` (Home's daily
  task) and `review`, while that project is live and the source has no route. A gone project is `skipped`, and those
  tasks go to the Inbox.

Every statement repeats its guard, so running the import again changes nothing. No secret or private value is
needed: the projects come from Todofy's rows, not from the retired project secrets.

The owner runs [Tasks Todofy import](../../.github/workflows/tasks-todofy-import.yml) from GitHub Actions on
`main`. It runs in the `production` environment with the releases' Cloudflare token and in the Tasks release's
concurrency group. It answers the generator's read-only SELECTs from both databases into a private directory on
the runner, deletes the directory at the end, and prints counts only: `days`, `reviews`, `categories` and `routes`,
each with `all`, `pending`, `present` and `skipped`, and `pending` in all. No task, label, project, mail or ID
reaches the log.

1. Run it with `apply` unchecked and read the counts. Avoid Sunday from 09:30 UTC to Monday, when the review runs.
2. Run it with `apply` checked. It counts, prints Tasks' Time Travel bookmark, applies the SQL with
   `wrangler d1 execute --file`, then counts again and fails unless nothing is left pending. A failed apply prints
   only `TODOFY_IMPORT_APPLY_FAILED`; D1 then returns to its state before the file, and the run can be repeated.
3. In the browser, check Mail's category shortcuts, Plan's weekly review and the GTD page's trend.

To undo the import, restore the printed bookmark from `tasks/worker`:
`npx wrangler d1 time-travel restore DB --bookmark=<bookmark> --config ../wrangler.toml`. That also undoes every edit
made in Tasks since.

`node --test tasks/tools/test/todofy-import.test.mjs` covers the generator on synthetic rows: both apps' schemas from
their migrations, the exports on read-only connections, and the copied rows read back through the Tasks API on real
D1. `.github/scripts/test_tasks_todofy_import_workflow.py` pins the workflow. The workflow, the tool and their tests
are deleted together with Todofy's copies.
