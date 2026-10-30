# Backup and restore

Tasks' D1 holds the only copy of every task, project and completion. Two copies protect it: D1 Time Travel
(7 days on Workers Free) for a recent mistake, and Tasks' own weekly backup in its private R2 bucket `tasks-backups`
for older points and a lost database.

## What the weekly backup holds

The `TaskJobs` object (`worker/src/jobs.ts`) runs the backup (`worker/src/backup-runner.ts`) every Sunday at 10:00
UTC, and at once when the object has no backup state yet: right after the release that bound the bucket, or after the
object lost its storage. It needs no cron, secret, credential or binding to another app; "Infra apply" created the
bucket (`infra/storage.tf`).

- Each job writes under its own prefix, named after the second it started:
  `backups/<job start>/<table>/<n>.ndjson.gz` (one JSON array per row, in the manifest's column order) and
  `backups/<job start>/manifest.json`, written after every part. The manifest (format `tasks-d1-backup-v1`) has a
  `tasks` section: the applied migration, Tasks' change sequence when the job planned and when it ended, and each
  table with its columns, key, row count and the SHA-256 of every part. Then `latest.json` names the new backup.
- Every table a restore needs is included: projects, sections, labels, filters, tasks, completions, request
  receipts; since `0005_focus.sql`, Focus's day queues (`day_steps`), time records (`focus_entries`) and the one
  timer (`focus_timer`); and since `0006_planning.sql`, each task's planning columns, its dependencies
  (`task_dependencies`), the weekly goals (`weekly_bets`) and Plan's lane orders (`plan_board`); and since
  `0008_mail_gtd_inbox.sql`, the mail categories (`mail_settings`), the GTD days (`gtd_days`), the weekly reviews
  (`weekly_reviews`), TaskInbox's routes (`task_inbox_routes`) and its daily counts (`task_inbox_days`).
  Goals' Objective/KR/progress tables and Task/Bet references are included as well; older backups restore them empty.
  `task_labels` and the change feed are left out, because inserts rebuild them.
- A job runs in steps a second apart, each bounded for Workers Free: the plan (one batch), then at most 30 D1
  statements of pages (15 pages of at most 100 rows and half a MiB) stored as one part per table, then the manifest.
  A failed step runs again from the parts stored so far; three failed steps in a row fail the job, which starts again
  6 hours later, or on the next Sunday after the third failed job in a row.
- After each new backup the newest six complete ones are kept, and older ones and every incomplete prefix older than
  the new one are deleted. A job never rewrites a complete backup.
- Home's Tasks tile shows the last backup's age (`backup_age_seconds`), and raises `backup_stale` (critical: no
  complete backup for 8 days) and `backup_failed` (warning: the last job failed).

Owner edits continue while a job runs (about a minute), so the copy is a fuzzy snapshot: an edit made meanwhile may
or may not be in it. The restore tool warns when the manifest's two change sequences differ, and it refuses a backup
whose live rows reference rows it lacks. The bucket holds task content: keep it private.

Until Tasks backed itself up, Todofy's weekly job copied Tasks' D1 into `todofy-backups`
(`backups/<job start>/tasks/` and its manifest's `tasks` section). Those backups rotate out of Todofy's bucket
within six weeks; until then `download --bucket todofy-backups --backup backups/<job start>` restores one the same
way.

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
3. From `tasks/`, download the newest backup. `download` reads `latest.json`, fetches the manifest and every part with
   `wrangler r2 object get` and checks each against the manifest; `--backup backups/<job start>` picks an older
   one (the R2 dashboard lists the prefixes):
   ```sh
   node tools/backup-restore.ts download --out "$PRIV/restore" --remote
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
     `python3 tools/cloud-config/generate.py` (it rewrites `tasks/wrangler.toml`) and commit without pushing.
     The committed `database_name` stays `tasks`, because wrangler binds the database by its id.
   - From a clean checkout of that commit, deploy Tasks once by hand as `.github/actions/release-tasks` does,
     but without `--secrets-file`, so the Worker keeps its secrets:
     ```sh
     pnpm install --frozen-lockfile --ignore-scripts
     source_sha=$(git rev-parse HEAD)
     bazel build //tasks --stamp --embed_label="$source_sha"
     archive=$(bazel cquery //tasks --stamp --embed_label="$source_sha" --output=files)
     mkdir "$PRIV/compiled-tasks"
     tar -xzf "$archive" -C "$PRIV/compiled-tasks"
     node tools/cf-guard/cf-guard.mjs --config tasks/wrangler.toml
     (cd tasks/worker && GITHUB_SHA="$source_sha" node ../deploy/deploy-vars.mjs exec -- \
       npx --no-install wrangler deploy "$PRIV/compiled-tasks/worker/index.js" --no-bundle \
       --config ../wrangler.toml --assets "$PRIV/compiled-tasks/web/dist")
     ```
     From `tasks/worker`, `npx wrangler deployments status --config ../wrangler.toml` names the version, and
     `npx wrangler versions view <that version> --config ../wrangler.toml` lists `DB` with the new id. Go on
     to step 6 only then.
   - Push the commit to `main`. Its preflight now finds the binding it expects and releases the same code.
   - `infra/` still holds the old database as `cloudflare_d1_database.app["tasks"]`, so "Infra drift" and the
     reconcile report the id difference, and the new database as unregistered, until the infra state is moved
     to it ([import notes](../../infra/README.md#outputs)). Keep the old database until then.
6. Open Plan: the restored tasks carry their planning facts and dependencies. Mail links of tasks created after
   the backup point at tasks the restored database lacks; converting such a Mail item creates a new Inbox task.
7. Open Mail and GTD: Mail lists the pending mail and the categories, and GTD the restored completions and time.
8. Open Focus. The timer comes back as it was backed up: a session that was running then still runs, counting from
   then (at most 4 hours, or its pomodoro's length). Stop it, then fix the new record's minutes if needed.

Keep the old database until the restored one has run for a while, then delete it on purpose
(`npx wrangler d1 delete <old name>`); it holds task content too.

A Todoist re-import ([import.md](import.md)) is not a recovery path. It only rebuilds the state of the
2026-10-17 cutover, and every native task, edit and completion since then would be lost.

## Rehearse locally

The same commands work on a local copy: pass `--local --persist-to "$PRIV/d1"` in place of `--remote` to
`migrations apply`, `execute` and `verify`, and any new UUID as the database id; `download --local --persist-to <dir>`
reads a local bucket. `tasks/worker/test/runtime/backup-runner.test.ts` runs a real backup from the jobs object,
downloads it with wrangler, restores it into a new local D1 and verifies it; `bazel test //tasks/tools:backup_restore_test` covers the tool on synthetic data, in both manifest formats.

## One-time planning import

Until the release that added `0006_planning.sql`, Todofy kept each task's planning facts, the dependencies, the
weekly goals and Plan's lane orders. Right after that release, on 2026-10-20, the owner ran the one-time Tasks
planning import, which copied them into Tasks; its last dry run counted 0 pending. Its workflow, generator and tests
were then deleted; they are at `777d5f01` (`git show 777d5f01:tasks/tools/planning-import.ts`). Todofy's migration
`0013_drop_plan_store.sql` dropped the store it read.

## One-time Todofy import

Until the release that added `0008_mail_gtd_inbox.sql`, Todofy kept the GTD days and weekly reviews, the Mail
categories and, as frozen rows, the projects its daily reminder and review went to. Right after that release the owner
ran the one-time Tasks Todofy import, a dispatched workflow whose generator copied every day and review Tasks lacked,
the categories whose labels were live (once, keeping their IDs) and the routes `home` and `review`. The next release,
pushed once the import's apply run had passed `--expect-none` (nothing pending), deleted the workflow, the generator
and their tests and dropped Todofy's copies (`0015_drop_copied_stores.sql`); `git log -- tasks/tools/todofy-import.ts`
finds them.
