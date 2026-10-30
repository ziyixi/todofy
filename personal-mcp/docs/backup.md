# Backup and restore

The `SubscriptionStore` object's SQLite holds the only copy of the Work memory, the event subscriptions (callback
URL and signing secret included), the source cursors, the frozen deliveries and the request receipts. The store backs
itself up every day into its own private R2 bucket `personal-mcp-backups`, and a restore loads a backup into a new,
empty store from inside the object.

## What the daily backup holds

The object's Alarm runs the backup (`worker/src/backup.ts`) daily at 05:23 UTC, and at once when the object has no
backup state yet: right after the release that bound the bucket, and right after a restore. Home's status call arms
the Alarm when a backup is due, so a quiet store gets its first backup within Home's next tick. There is no cron,
secret, service or binding to another app; "Infra apply" created the bucket (`infra/storage.tf`).

- **Everything the store keeps.** Every table: `subscriptions`, `test_events`, `step_batches`, `own_changes`,
  `event_sources`, `deliveries` (bodies and states), `work`, `work_entries` and `work_links`, with each row's rowid;
  and every KV key (`last_tool_at`, `last_subscription_at`, `last_subscription_request`). A table added later is
  backed up without a change to the backup. Left out, because a restore rebuilds them or they are not the app's data:
  `delivery_totals` (counts of deliveries by state, rebuilt by the deliveries triggers as rows go in),
  `sqlite_sequence` (SQLite's own; the restore sets the `work_entries` sequence, see below), Cloudflare's `_cf_*`
  tables, and the KV keys `backup` and `restore` (this job's and a restore's own state). The Alarm is not data: a
  restored store sets its own.
- **Layout.** Each job writes under its own prefix, named after the second it started:
  `backups/<job start>/tables/<table>/<n>.ndjson.gz` (one JSON array per row: rowid, then the columns; a blob as
  `{"blob": "<base64>"}`), `backups/<job start>/kv/<n>.ndjson.gz` (one `[key, value]` per line), then
  `backups/<job start>/manifest.json` (format `personal-mcp-backup-v1`: the schema version, each table's CREATE
  statement, columns, planned max rowid and, for `work_entries`, its AUTOINCREMENT sequence, and each part's rows,
  bytes and SHA-256), then `latest.json`, which names the new backup. A prefix without a manifest is incomplete.
- **Bounded steps.** One step per Alarm, a second apart. The first step fixes every table's max rowid; each step reads
  the KV keys and the tables, fewest rows first, up to 4 MiB of rows, without awaiting in between, and then stores one
  part per table it read. A store that fits one step is one consistent snapshot. A larger one adds the rest of its
  biggest tables (`deliveries`, `work_entries`) in later steps: rows added after the first step are left out, and a row
  changed between steps is saved as it is when its step reads it. The small tables that move a row to a new rowid when
  they replace it (`own_changes`, `work_links`, `event_sources`) and `work` come first, so they are read whole in the
  first step while they fit in it (thousands of Works). A cursor moves only after its part is stored, so a failed step
  repeats from there. Three failed steps in a row fail the job, which starts again an hour later (three times), then
  at the next 05:23.
- **Retention in code.** After each new backup, the newest 30 complete backups stay; older ones, and every incomplete
  prefix older than the new one, are deleted. A job never rewrites a complete backup and never touches another
  backup's objects. One listing of `backups/` finds the complete and incomplete prefixes, so the cleanup costs a few R2
  calls however many backups there are. A store without rows (a new object waiting for its restore) writes no backup, so `latest.json`
  keeps naming real data. There is no R2 lifecycle rule: a stopped job never ages out the last good copies.
- **Ops.** Home's Personal MCP tile shows `backup_age_seconds` and `last_backup_at`, and raises `backup_stale`
  (critical: no complete backup for 3 days, counted from the first job while there is none) and `backup_failed`
  (warning: the last job failed).

The bucket holds Work memory, callback URLs and signing secrets: keep it private, and keep downloads outside the
repository.

## A recent mistake

Cloudflare keeps 30 days of point-in-time history for SQLite Durable Objects, but only the object itself can use it
(`getBookmarkForTime`, `onNextSessionRestoreBookmark`). Personal MCP has no call for it: a rewind in place would take
the subscriptions' cursors and the Work report sequence back with it, without the restore's re-baseline below, and
local workerd cannot rehearse it. Restore the newest backup from before the mistake into a new object instead; the
old object keeps its data for comparison.

## Restore

A restore runs inside the object (`worker/src/restore.ts`), from its own `BACKUPS` bucket, and only into an empty
store. The owner starts it with one call; the object then loads the backup in steps a second apart, each up to 4 MiB of
rows from at most 20 parts. Every part is read, checked against the manifest's SHA-256 and row count, inserted with its rowids, read back and
compared byte for byte, and the cursor moves, in one transaction: a failed step repeats the part without duplicates.
Three failed steps in a row fail the restore; the same call resumes it. Until it is done the store answers every
`/mcp` request with 503 `restore_unfinished`, runs neither its event sources, deliveries nor backup, and Home shows
the app in maintenance (`maintenance_mode`, critical). Its last step writes the verification (each table's rows and
the KV keys against the manifest, and `delivery_totals` against the deliveries) to the status, marks every event
source `restored`, and lets the store back itself up at once.

### The owner call

`GET /owner/restore` answers the backup's state and the restore's (`phase`, `parts`, `error_code`,
`verification`). `POST /owner/restore` with `{"backup": "backups/<job start>/"}` starts a restore, or resumes an
unfinished one of the same backup. Both sit behind the existing Access application for `mcp.ziyixi.science` and the
object's own checks for `/mcp`: the Access assertion of the owner, and a refused foreign `Origin`; a POST must be
JSON. There is no other secret. It answers 409 `store_not_empty` for a store with rows, 409 `restore_unfinished`
for another backup while one is unfinished, 404 `backup_not_found` for a prefix without a manifest, and 422
`backup_schema_unsupported` for a backup with a table or column this release does not have.

### Step by step

`PRIV` is a private directory outside the repository, for example
an owner-controlled isolated recovery location. Its files hold Work memory and signing secrets;
delete them afterwards.

1. From `personal-mcp/`, download the newest backup and check it (`--backup backups/<job start>/` picks an older
   one; the R2 dashboard lists the prefixes). The first line names the backup:
   ```sh
   node tools/backup-restore.ts download --out "$PRIV/restore" --remote
   node tools/backup-restore.ts verify --in "$PRIV/restore"
   ```
2. Point the app at an empty store.
   - **Same account** (the store's data was lost or damaged): set `STORE_OBJECT` in `worker/src/env.ts` to a new
     name, for example `owner-2`, and release it through main Actions like any change. The Worker and Home's Ops now
     reach the new object, which is empty; the old object stops its Alarm the next time it fires and keeps its data.
     To go back, release the old name again.
   - **New account or namespace** (after a disaster): the rebuild's release creates the Worker and its namespace, so
     the `STORE_OBJECT` object is empty. "Infra apply" creates the bucket; put the downloaded backup into it, parts
     first and the manifest last (the tool refuses a bucket that already holds that backup):
     ```sh
     node tools/backup-restore.ts upload --in "$PRIV/restore" --remote
     ```
3. Right after that release, start the restore with the backup the download named:
   ```sh
   cloudflared access login https://mcp.ziyixi.science
   cloudflared access curl https://mcp.ziyixi.science/owner/restore -X POST \
     -H 'content-type: application/json' --data '{"backup":"backups/<job start>/"}'
   ```
   (Or, signed in to `https://mcp.ziyixi.science` in a browser, the same `fetch` from that page's console.) A 409
   `store_not_empty` means a Dot wrote to the new store first: choose another name in step 2 and release again.
4. Read the state until `phase` is `done`:
   ```sh
   cloudflared access curl https://mcp.ziyixi.science/owner/restore
   ```
   Every `verification` entry has `ok: true` and `restored` equal to `expected`. On `failed`, `error_code` says why
   (`part_missing`, `part_hash_mismatch`, `insert_failed`, ...); fix the cause and repeat step 3's POST to resume. A
   failed `verification_failed` cannot resume: start again from step 2 with another new name. Workers Free allows
   100,000 Durable Object rows written a day, and a delivery also writes index rows and its total: a store larger than
   that stops at the limit (`insert_failed` or `storage_error`), and the same POST the next day resumes it where it
   stopped.
5. Afterwards, Dots call the same tools; their connection and Access OAuth are unchanged. Ask a Dot to read
   `work_context` and `work_get` again before it checkpoints, and check `connection_status` and Home: the event
   sources clear `restored` at their first check, and a new backup of the restored store appears within a minute.

### After a restore: subscriptions and reports

- The restored subscriptions keep their callbacks and secrets. A business source (`task.changed`,
  `task.must_start`, `mail.ready`, `service.attention`) takes a new baseline from current state at its first check, as
  a new subscription does: a cursor behind or ahead of its source is never read, and nothing between the backup and
  the restore is replayed. Must-start revisions move past any the lost store could have used, so a new event never
  reuses an earlier event's ID.
- The Work Watch source reads on from its restored cursor. Watch events after the backup become the same reports
  (`watch:<sequence>`) the lost store made; report IDs the restored store already holds are not repeated. If Watch no
  longer has those events, or refuses the cursor because Watch itself was restored behind it, each open Work with a
  Watch gets one `blocked` gap report and the cursor starts again from now, as after an expired cursor.
- New Work entries are numbered a million past the backup's sequence, and every Work's etag moves a million up. A Work
  notice's event ID holds its entry's number, and the lost store went on numbering after the backup, so a report the
  restored store makes never reuses an event ID a Dot already received for another report; an etag a Dot kept from the
  lost store never matches, so its checkpoint is refused until it reads the Work again.
- Pending deliveries in the backup are sent again with their frozen event IDs and bodies; accepted ones are not.

### What a restore does not cover

- Anything after the backup: Work records, reports and checkpoints written since are gone. A Dot must read the Work
  again before it checkpoints; a stale etag is refused.
- Business notifications between the backup and the restore (see above); Dots read current facts through the tools.
- Business data, which stays in Tasks, Todofy, Recall, Watch and Home and their own backups.
- The ChatGPT connection, Access OAuth and secrets: Access and ChatGPT hold the connection; a new account needs the
  Access application from `infra/` and the Worker secrets from the normal release, then the existing App reconnected.

## Rehearse locally

`worker/test/runtime/restore.test.ts` runs this page in workerd: a store filled through MCP gets its first backup from
Home's status, the tool downloads, verifies and uploads it with wrangler (`--local --persist-to <dir>` in place of
`--remote`), and the owner call restores it into a new environment, which then serves the same Work, re-baselines its
business source and replays the Watch feed. `worker/test/runtime/backup.test.ts` restores a larger synthetic store and
compares every table and KV key row for row, and covers the step budgets, failed steps, a failed job, a resumed
restore, retention, Ops and a retired object. `bazel test //personal-mcp/tools:check` covers the tool.

The committed synthetic build/test path is `bazel test //personal-mcp:check`. Runtime backup/restore tests and tool checks are selected as leaves from that facade; remote recovery commands above are separate authorized operator work.
