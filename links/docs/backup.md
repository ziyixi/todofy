# Backup and restore

The links app's D1 database `links` holds the only copy of every short link, its kept revisions and the request IDs
of the last day. Two copies protect it: D1 Time Travel (7 days on Workers Free) for a recent mistake, and the app's
own daily backup in its private R2 bucket `links-backups` for older points and a lost database.

## What the daily backup holds

Every table of `migrations/`, every row and every column (`worker/src/backup.ts`):

| Table | What it is |
| --- | --- |
| `links` | every link, deleted ones too until they are purged (key, target, path mode, visibility, description, tags, expiry, times, current revision, etag) |
| `link_revisions` | the content of each kept revision, the last 20 per link (undo and rollback) |
| `request_log` | the first answer of each mutation sent with a request ID, kept for a day (a repeat gets the same answer) |

Nothing is left out. wrangler's own `d1_migrations` is not copied: the manifest names the newest applied migration,
and a restore applies the migrations itself. The app keeps no click or visit data (a redirect writes nothing,
[design](design.md) §1), so there is none to copy. `test/runtime/backup.test.ts` fails when a migration adds a table
or a column that `BACKUP_TABLES` does not name.

### Schedule and steps

The Worker's one cron trigger (`*/5 * * * *`, `wrangler.toml`) runs the backup (`worker/src/backup-runner.ts`). A
tick reads the bucket's `state.json`; when no job is due or running it stops there. A job starts every day at
05:25 UTC, and at the first tick when the bucket holds no `state.json` yet: right after the release that bound the
bucket, or after the state was lost. It needs no secret, credential or binding to another app; "Infra apply"
created the bucket (`infra/storage.tf`).

Each tick of a job is one bounded step, within Workers Free's 10 ms of CPU (`test/runtime/cpu.test.ts` measures each
kind of step, about 1 to 4 ms) and well under 50 D1 statements:

1. The plan, one batch: the newest applied migration and the change mark (each table's row count and the newest
   `links.update_time`).
2. Export steps: pages of each table in key order, at most 100 rows and half a MiB each, until the step has read 30
   statements or 128 KiB of rows; what a step read of a table is stored as one part. A table's cursor (the last key
   stored) moves only after its part is stored, so a failed step reads the same pages again and overwrites the same
   keys. D1 counts about three rows read per row copied (the window that bounds a page's size).
3. The last step: the change mark again, a check that every part in the bucket has the size and SHA-256 the job
   recorded, then `manifest.json` and `latest.json`, then retention.

Three failed steps in a row fail the job; it starts again an hour later, or at the next daily slot after the third
failed job in a row. A backup of a few hundred links and their revisions takes a handful of ticks, under half an
hour.

### Layout

```
backups/<job start>/<table>/<n>.ndjson.gz   one gzip part per table and step: one JSON array per row, in the
                                            manifest's column order, rows in key order
backups/<job start>/manifest.json           written last: a prefix without it is incomplete
latest.json                                 {"key": "backups/<job start>/"}, after the manifest
state.json                                  the running job's cursors and the last result
```

`<job start>` is the UTC second the job started, e.g. `backups/2026-10-28T052500Z/`. The manifest (format
`links-backup-v1`) has a `links` section: `schema_version` (the newest applied migration), `change_mark` (`start`
and `end`) and each table with its `columns`, `key`, `rows`, `bytes` and every part's key, row count, size and
SHA-256. Each part also carries its SHA-256 as R2 custom metadata.

### Retention

After each new backup the newest 30 complete ones are kept, and older complete ones and every incomplete prefix older
than the new one are deleted. A job never rewrites a complete backup, never deletes a prefix newer than its own, and
deletes nothing when the bucket lists more than 5,000 objects. Retention is in the code, not an R2 lifecycle rule: a
stopped job never ages out the last good copies.

### What Home shows

The 短链接 tile is the app's Ops answer (`worker/src/ops.ts`, contracts/ops-v1): `backup_age_seconds` and
`last_backup_at` once a backup is complete, `backup_stale` (critical: no complete backup for 3 days, or 3 days after
the first step while there is none) and `backup_failed` (warning: the last job failed, or the bucket did not answer
for `state.json`).

Owner edits continue while a job runs, so the copy is a fuzzy snapshot: an edit made meanwhile may or may not be in
it. The restore tool warns when the manifest's two change marks differ. The bucket holds every link, private ones
too: keep it private.

## Recent mistake: Time Travel (within 7 days)

From `links/worker`, find the time just before the mistake and restore the database in place (the owner's decision;
it rewinds every link to that time):

```sh
npx wrangler d1 time-travel info DB --config ../wrangler.toml
npx wrangler d1 time-travel restore DB --timestamp <RFC 3339 time> --config ../wrangler.toml
```

## Full restore into a new database

`PRIV` is a private directory outside the repository, for example
`mkdir -m 700 ~/.local/share/links-restore && PRIV=$_`. The files written there hold every link; delete them
afterwards.

1. Do not edit in the launcher until step 6. Redirects keep working from the old database meanwhile; nothing else
   writes to it.
2. From `links/worker`, create the new database: `npx wrangler d1 create links-restore`. It prints the new id.
3. From `links/`, download the newest backup. `download` reads `latest.json`, fetches the manifest and every part
   with `wrangler r2 object get` and checks each part's SHA-256, row count and columns against the manifest;
   `--backup backups/<job start>` picks an older one (the R2 dashboard lists the prefixes):
   ```sh
   node tools/backup-restore.ts download --out "$PRIV/restore" --remote
   ```
4. From `links/`, write the restore config, apply the migrations, load the rows and verify them:
   ```sh
   node tools/backup-restore.ts config --database-name links-restore --database-id <the new id> \
     --out "$PRIV/links-restore.toml"
   (cd worker && npx wrangler d1 migrations apply DB --remote --config "$PRIV/links-restore.toml")
   node tools/backup-restore.ts sql --in "$PRIV/restore" --out "$PRIV/links-restore.sql"
   (cd worker && npx wrangler d1 execute DB --remote --config "$PRIV/links-restore.toml" --file "$PRIV/links-restore.sql")
   node tools/backup-restore.ts verify --in "$PRIV/restore" --config "$PRIV/links-restore.toml" --remote
   ```
   `config` writes a config with only the new database's `DB` binding, the committed account and `links/migrations`
   by absolute path; it has no Worker. It refuses the production database's id or name, a path inside the repository
   and an existing file. Never copy `links/wrangler.toml` for this: its `database_id` is the live database. `sql`
   checks every part again and writes one `INSERT ... ON CONFLICT DO NOTHING` per row, so a re-run after a partial
   load is safe; it starts with a `WARN` line when the links changed while the backup ran. `verify` checks that the
   backup's migration is applied and reads every table back in key order, 500 rows per query, comparing each row
   value for value with the backup; it prints `PASS` or `FAIL` per table (`differing=` counts rows that differ) and
   ends with `verify PASS`.
5. Switch the Worker to the new database. This step is not rehearsed, and a push alone does not do it: the
   release's preflight finds the live `DB` binding on the old id and stops (`STATEFUL_BINDING_CHANGED` needs a
   manual change).
   - Set the `links` entry of `[d1_databases]` in `config/resources.toml` to the new id, run
     `python3.12 tools/cloud-config/generate.py` (it rewrites `links/wrangler.toml`) and commit without pushing. The
     committed `database_name` stays `links`, because wrangler binds the database by its id.
   - From a clean checkout of that commit, deploy the links app once by hand as `.github/actions/release-links`
     does, but without `--secrets-file`, so the Worker keeps its secrets:
     ```sh
     pnpm install --frozen-lockfile
     npm run build --prefix links/web
     (cd links/worker && GITHUB_SHA=$(git rev-parse HEAD) node ../deploy/deploy-vars.mjs exec -- \
       npx --no-install wrangler deploy --config ../wrangler.toml)
     ```
     From `links/worker`, `npx wrangler deployments status --config ../wrangler.toml` names the version, and
     `npx wrangler versions view <that version> --config ../wrangler.toml` lists `DB` with the new id.
   - Push the commit to `main`. Its preflight now finds the binding it expects and releases the same code.
   - `infra/` still holds the old database as `cloudflare_d1_database.app["links"]`, so "Infra drift" and the
     reconcile report the id difference, and the new database as unregistered, until the infra state is moved to
     it ([import notes](../../infra/README.md#import-notes)). Keep the old database until then.
6. Open the launcher (`https://s.ziyixi.science/_/`): it lists the restored links, 显示已删除 the deleted ones, and a
   link's history its kept revisions. A public link redirects anonymously.

Keep the old database until the restored one has run for a while, then delete it on purpose
(`npx wrangler d1 delete <old name>`); it holds every link too.

## What a restore does not bring back

- Edits made after the backup (at most a day of them): Time Travel covers the last 7 days of the old database while
  it exists, and the launcher's 导出 file is another copy of the live links.
- `request_log` holds a day of request IDs at most: a restored one is answered again only within a day of its
  first request, and the next write purges the older ones. A request repeated after that applies anew.
- The backup's own `state.json` is not restored: a new bucket, or a lost state, starts a new job at the first tick.
- The Worker, its secrets, the Custom Domain and the Access application are not data: `infra/` and `Links deploy`
  recreate them ([README](../README.md#deploy)). In another account, pass that account's bucket with
  `download --bucket <name>` and restore into its own new database the same way.

## Rehearse locally

The same commands work on a local copy: pass `--local --persist-to "$PRIV/d1"` in place of `--remote` to
`migrations apply`, `execute` and `verify`, and any new UUID as the database id; `download --local --persist-to <dir>`
reads a local bucket. `worker/test/runtime/backup.test.ts` runs the backup from the cron tick on real D1 and R2,
downloads it with wrangler, restores it into a new local D1, verifies it and compares every table of the restored
database with the original row for row; `node --test tools/test/*.test.mjs` covers the tool on synthetic data.
