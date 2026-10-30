# Todofy setup and recovery

The root [rebuild guide](../../docs/rebuild.md) owns first-account/bootstrap steps. Use its public profile, resource
exporter and gated infrastructure flow; do not create a second set of D1/R2/Access resources manually.

## Configuration

`wrangler.toml` owns the private Python core and D1/backups bindings. `gateway/wrangler.toml` owns public hosts, Access,
assets and cron. Generated identities come from the root public cloud/resource configuration. The core has no public
route. The owner host is behind Access; hooks hosts use their own machine credentials and must not redirect to Access.

GitHub's production environment is main-only and requires `CI gate`. Deployment injects the explicit
`TODOFY_MAINTENANCE_MODE` and `TODOFY_PROCESSING_PAUSED` variables and the selected source SHA. The gateway receives
owner identity through its declared Worker secret map. Provider connections stay only in Model Router.

The gateway's machine interface uses the existing webhook token digest and report Basic credential digest. Their
names and optional rotation inputs are declared in [app.toml](../app.toml). Configure them through the owner secret
flow, not source files or printed command arguments. A missing digest refuses that interface; it does not open it.

## Publication and checks

```sh
bazel test //todofy:check
bazel build //todofy
```

Actions verifies and stages the compiled artifact, runs hostname guards, applies migrations, deploys core then
gateway and checks actual identity, machine-path behavior and Access. The main reconcile must also pass. See
[CI/CD](ci-cd.md). Never run a bare production deploy or apply a recovery SQL file against the production config.

The gateway's DO migration tags are published storage history. Keep them on reverts; do not resurrect retired
coordinators or let two writers share one D1. Historical migration decisions remain in Git, while current transport
and storage boundaries are in the [gateway contract](gateway-contract.md).

## 7. Backups and restore

The coordinator backs D1 up to the private bucket `todofy-backups` every Sunday at 10:00 UTC, and once
right after its first deploy or whenever the object lost its state (`worker/todofy/runtime/backup.py`;
the owner UI's health page shows the last one). Each job writes every table, `legacy_mail_text`
included, under its own prefix named after the second it started: `backups/<job start>/<table>/<n>.ndjson.gz`
plus `manifest.json`, written last (tables, columns, row counts, SHA-256 per part, schema version from
`d1_migrations`); a prefix without a manifest is incomplete. A job never deletes or rewrites another
backup, so a job that fails cannot cost a complete one. After each new backup, the newest 6 complete
ones are kept and older complete ones and every older incomplete prefix are deleted. A backup that
finished early on a Sunday is not repeated at 10:00 the same day. While a backup runs (a few minutes,
30 at most) mail processing waits and owner writes answer 503; webhooks are still accepted.

Before Tasks backed itself up, each backup also held the Tasks app's D1 (`backups/<job start>/tasks/` and the
manifest's `tasks` section). Tasks now keeps its own weekly backups in its own bucket
([tasks/docs/backup.md](../../tasks/docs/backup.md)), and its restore tool also reads those older backups until they
rotate out; `download` below fetches Todofy's parts only.

Rows that D1 retention deletes (legacy text by `expires_at` or `TODOFY_LEGACY_TEXT_RETENTION_DAYS`,
reports after 90 days, owner actions after 180; since 2026-10 no summary, which only the owner deletes) stay in the backups made before the deletion until those
rotate out: about 6 weeks while backups succeed, longer while they fail. A restore brings such rows back;
the next daily retention tick deletes the ones whose time has passed again. The same holds for the summaries
the owner deletes in Tasks' Mail ([mail-api.md](mail-api.md#writes-without-receipts)); a restore brings those back too.

Summaries are the one table that now only grows by itself: about 100 rows a day of a few KB (the subject, a
summary of up to 64 KiB, usually 1-3 KB, and the brief) is roughly 40-70 MB a year in the database's 500 MB,
which it shares with `mail_events` and the rest. Deleting a mail in Tasks' Mail deletes its summary; a mail
converted to a task, or whose task is deleted, keeps its row. Watch the database size in the dashboard once a year;
the unused partial index `summaries_expiring` (the old 90-day sweep's) still costs one index write a row,
and a later migration may drop it.

Backups consume the account's shared D1/R2 allowance. Use Home's observed usage rather than old volume forecasts.
For a recent mistake, D1 Time Travel is the first option; complete backups cover older points or a lost database.
They contain no provider key or DO runtime state. The coordinator detects a restored metrics cursor and resumes
from a valid row rather than assuming the old database's row IDs still apply.

Restore into a new, empty database (with `--local --persist-to <dir>` the same commands work on a
local copy). The backup's key is on the health page (e.g. `backups/2026-10-04T100002Z/`):

```sh
npx wrangler d1 create todofy-restore        # prints the new database's id
restore_config=<a path outside the repo>/todofy-restore.toml
python3 tools/backup_restore.py restore-config --database-name todofy-restore \
  --database-id <the new id> --out "$restore_config"
python3 tools/backup_restore.py download --backup backups/<job start> --out restore/ --remote
python3 tools/backup_restore.py sql --in restore/ --out restore/restore.sql
npx wrangler d1 migrations apply DB --remote --config "$restore_config"
npx wrangler d1 execute DB --remote --config "$restore_config" --file restore/restore.sql
python3 tools/backup_restore.py verify --in restore/ --db DB --remote --config "$restore_config"
```

`restore-config` writes a config with only the new database's `DB` binding, the committed account and
this checkout's `migrations/` by absolute path; it has no Worker, so nothing can be deployed with it. It
refuses the production database's id or name, a path inside the repository and an existing file. Never
copy `wrangler.toml` for a restore: it is production, so its `database_id` is the live database (the
restore SQL would go into production), and its relative `migrations_dir` fails outside `todofy/`.

`download` checks every part against the manifest's SHA-256 and row counts, `sql` checks them again,
and `verify` compares the restored row counts with the manifest and checks that the backup's migration
is applied. `migrations apply` applies every migration in the current tree, which may be newer than the
backup; that is fine because migrations are additive and the restore SQL names its columns, and
`verify` then reports `PASS schema_version <backup's> (later migrations applied: ...)`. One caveat: a
later migration that rewrites existing rows (a backfill) does not run on rows restored after it. If one
exists, check out the commit whose newest migration matches the manifest's `schema_version`, apply
migrations and restore there, then apply the remaining migrations from the current tree.
`--no-legacy-text` (on all three commands) leaves the imported mail text out.

The `restore/` files hold mail content: keep them owner-only and delete them afterwards.

To switch production to the restored database (gateway-contract.md §6.5 explains why only one
coordinator may use a database at a time):

1. Set `TODOFY_MAINTENANCE_MODE=true` and run the workflow on `main`: the gateway refuses webhooks (Mail
   Hero retries) and owner writes, and the object stops ledger work. Mail that arrives from here on is
   held by Mail Hero, not lost.
2. Restore and `verify` as above until it prints `PASS`.
3. Commit the restored database's `database_id` (and `database_name` if it has another name) to
   `[[d1_databases]]` in `wrangler.toml` on `main`; that push checks and deploys Todofy. Its
   `migrations apply` finds every migration already applied.
4. Set `TODOFY_MAINTENANCE_MODE=false` and run the workflow on `main`. Mail Hero redelivers what it
   held during maintenance. Events Todofy acknowledged after the backup was taken are not in the
   restored database, and Mail Hero does not send an acknowledged event again: compare with Mail Hero's
   deliveries (or the old database, while it exists) before deciding whether any matter. Check the
   attention page: a row that was mid-step in the backup, if any, is recovered as after a crash
   (`summarizing` → `pending`).
5. Keep the old database until the restored one has run for a while, then delete it
   (`npx wrangler d1 delete <old name>`) on purpose; it holds mail content too.

The object keeps its own state across the switch: budgets and tick times stay; the metrics cursor
notices the other database and restarts, so the switch day and the days back to the last written one
show "未记录" in the trends. The same happens after a D1 Time Travel restore in place.
