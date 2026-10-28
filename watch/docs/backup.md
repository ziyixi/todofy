# Backup and restore

`WatchState` (the object `watch-v1`) holds the only copy of every watch, snapshot, change, event and task request, and
the private bucket `watch-evidence` holds the page texts and screenshots its snapshots name. The object backs both up
every day into its own private bucket `watch-backups` (binding `BACKUPS`), and restores a backup into an empty object
when the owner asks. Nothing outside the object reads it: no cron, secret, service or new route.

## What a backup holds

Every table of the object's SQLite, all rows, and every evidence object its ready snapshots name:

| Table | Holds |
| --- | --- |
| `watches`, `snapshots`, `changes` | the settings and scheduler state, the normalized texts (BLOBs), every change kept |
| `notifications`, `intents` | the outbox and event feed, the task requests to Tasks with their state |
| `evidence_snapshots`, `evidence_deletions` | the evidence index, and the keys queued for deletion in `watch-evidence` |
| `hosts`, `robots`, `ledger`, `url_fetches`, `requests` | the etiquette per host (backoff included), robots.txt verdicts, the daily request and browser ledger, the URLs' 15 minutes, the AIP-155 request log |
| `meta` | the store's settings: digest day, guard, feed floor, last pass |
| `sqlite_sequence` | the AUTOINCREMENT heads, so snapshot ids and the event feed's sequence continue where they were |

Not backed up, by design (`EXCLUDED_TABLES` in `worker/src/backup.ts`, also listed in each manifest):

- `previews`: PreviewWatch's 15-minute store of a page fetched for the block picker, a cache of the site that is never
  read after 15 minutes.
- `backup_evidence`: the backup's own record of the evidence it copied; a restore rebuilds it from the manifest.
- The `meta` rows `backup`, `restore` and `schema_version`: the store's own bookkeeping of a backup, a restore and its
  schema (the manifest records the schema version).

Evidence objects of interrupted uploads (`ready = 0`, which the next pass deletes anyway) are not copied. An object a
ready snapshot names that the evidence bucket no longer holds is listed as `missing` in the manifest.

## Schedule and steps

A job starts every day at 11:23 UTC (Mail Hero copies at 04:17, Model Router at 04:47, Tasks on Sundays at 10:00), and
at once when the object has no backup state: the first alarm after the release that bound the bucket, or the first
one of a new object. Every owner API call and Home's `status()` bring the alarm forward to a backup that is due.

An empty store (no watch and nothing a watch made) is never backed up, so a new object made after a disaster cannot
push the good backups out; Home then raises `backup_stale` three days after its first step.

A job runs one bounded step per alarm, a second apart (Workers Free: 30 s of CPU, 128 MB per invocation):

1. the tables, read page by page into gzip NDJSON parts of at most 4 MiB (16 MiB a step);
2. the evidence: each object a ready snapshot names and no earlier backup copied is read from `watch-evidence` and
   written once to `evidence/<its key>` with its SHA-256 in its metadata (at most 40 reads or 24 MiB a step, an
   object the bucket lost counted too, so a step stays far inside an invocation's 1,000 calls to Cloudflare
   services); an object copied before costs no R2 call (`backup_evidence` records it), unless the bucket has no
   `latest.json` (new, or made again after its loss): then every object is copied again;
3. the manifest, `latest.json`, then retention. A repeated last step writes only `latest.json`: a stored manifest is
   never written again.

While a job runs the scheduler waits (no check, delivery or cleanup) and so does every write, the owner's and the
private `WatchApi` binding's: the API answers `BACKUP_RUNNING` and the UI says so ("正在备份，请稍后再试"). The copy is therefore one consistent point: the rows, and the
evidence they name. A daily job takes about three steps (a few seconds); the first one copies every evidence object
(40 a step, a minute or two). A cursor moves only after its part or copy is stored, so a failed step runs again from
there and writes the same keys. Three failed steps in a row fail the job; writes go on, and it starts again 6 hours
later, or at the next daily slot after three failed jobs in a row.

## Layout

```
backups/<job start>/<table>/<n>.ndjson.gz   one JSON array per row, in the manifest's column order; a BLOB as {"base64": ...}
backups/<job start>/manifest.json           written after every part: a prefix without it is incomplete
evidence/<key>                               one copy of each evidence object (customMetadata sha256)
latest.json                                  {"key": "backups/<job start>/"}, after the manifest
```

`<job start>` is the UTC second the job started (`backups/2026-10-28T112300Z/`). The manifest (format
`watch-backup-v1`) holds the schema version, each table with its columns, row count, bytes and every part's key, rows
and SHA-256, and every evidence key the snapshots name with its copy's SHA-256 and size (`evidence.objects`) or
`evidence.missing`. A job never rewrites a complete backup.

## Retention

In code, never an R2 lifecycle rule, so a stopped job never ages out the last good copies. After each new complete
backup the newest 30 complete ones are kept, and so is any prefix newer than the new one (another object's); every
older complete backup and every incomplete prefix older than the new one are deleted (a deleted backup loses its
manifest first, so it is never complete with parts missing). An evidence copy stays while any kept manifest names it
and is deleted after the last one goes. Retention lists only the
prefixes under `backups/` (one LIST a day); a complete backup's parts are deleted by the keys its manifest names.

Watch's own evidence retention is unchanged (the latest 20 captures per watch and the rule references): a copy of a
capture Watch has pruned stays only as long as a kept backup names it, at most 30 days.

## Status and alerts

- The 健康 page shows 备份 (the newest complete backup's age, or that the last job failed) and, after a restore, its
  verification.
- Home's tile (ops-v1): the counter `backup_age_seconds` and `last_backup_at`; `backup_stale` (critical: no complete
  backup for 3 days, counted from the first step while there is none) and `backup_failed` (warning: the last job
  failed). Both are app-only signals (`app.toml`).

## Cost and storage

Expected for the owner's store (tens of watches, a few changes a day), not measured in production yet:

- Tables: every row read once a day (a few thousand SQLite rows; about 15,000 at every bound), one meta row written a
  step; a few MiB of gzip parts a day, tens of MiB for the 30 kept. At every bound at once (50 watches, each with 200
  changes of 32 KiB diffs and 22 snapshots of 64 KiB) a backup would be about 175 MiB and 30 of them about 5 GiB,
  half of the account's free R2 storage: far beyond the store's real size, so watch the bucket's size after the first
  weeks.
- Evidence: one copy of each capture (at most 256 KiB of text, usually tens of KiB) and each screenshot (at most
  1 MiB) made in the last 30 days or still named: a few to a few hundred MiB, most of it screenshots of browser
  watches.
- R2 operations a day: one PUT per part (about 15), per new evidence object, for the manifest and `latest.json` (Class
  A, well under 100), one LIST of prefixes, about 30 manifest GETs (Class B); deletes are free. Free tier: 1 million
  Class A and 10 million Class B a month, shared by the account.
- Owner writes wait for the seconds a daily job runs (`BACKUP_RUNNING`, worth repeating).
- A restore writes every row once (a few thousand SQLite rows; about 15,000 and their indexes at every bound, against
  the account's 100,000 a day shared with Mail Hero) and one PUT per evidence object the evidence bucket lacks.

## Restore

The restore runs inside `WatchState`: it reads a named backup from its own `BACKUPS` bucket, checks each part's SHA-256
and row count before it inserts a row, and works only on an EMPTY store (no watch, snapshot, change, event, task
request or evidence index; otherwise `STORE_NOT_EMPTY`). It runs in bounded alarm steps a second apart:

1. it clears the store's operational rows (a new object's alarm writes a few);
2. it copies every evidence object of the manifest back into `watch-evidence` (the bound evidence bucket), its copy's
   SHA-256 checked first; an object the bucket already holds with the same size stays (a copy that fails its hash is
   never written and is counted). A step looks at most at 200 objects (a HEAD each) and copies at most 40 or 24 MiB;
3. it loads the parts, one transaction per part with its cursor, so a repeated step never loads a part twice;
4. it counts every table against the manifest (the verification), then keeps the old state from acting again:
   notifications the backup had not delivered are marked delivered and open task requests end `superseded` (code
   `restored`) without being sent, so no burst of old tasks reaches Tasks; the changes stay in the inbox. The event
   feed's sequence moves 2^32 ahead and its floor with it: a reader's saved position (Personal MCP's Dots) gets
   `CURSOR_EXPIRED` once, reports the gap and takes a new baseline, and no new event repeats a sequence it saw, so no
   old Work report is made again. The next alarm backs the restored store up (the evidence copies are already in the
   bucket, so it writes only its parts; after an `upload` into a new bucket, which has no `latest.json`, it copies
   the evidence once more).

The evidence goes first, so no restored row names an object that is not back yet. While the restore runs, or after it
failed, every other write is refused (`RESTORE_RUNNING`; Home's `setGuard` answers `unavailable`), the scheduler and
the daily backup wait; reads go on. Three
failed steps in a row fail it (`part_missing`, `part_mismatch`, `count_mismatch`, `manifest_changed` or
`storage_error`); writes stay refused, and starting the restore again begins from step 1. The 健康 page shows its
progress and, when it ends, its verification: the rows of every table against the manifest and the evidence counts
(restored, already present, missing, failing their hash).

### Recent mistake: Cloudflare's point-in-time recovery

SQLite Durable Objects keep 30 days of point-in-time recovery (`ctx.storage.getBookmarkForTime` and
`onNextSessionRestoreBookmark`). Watch has no owner call for it, and it cannot be rehearsed locally, so it is not a
path today: a recent mistake is restored from the daily backup like anything else (losing at most a day).

### Getting an empty store

- **The object's data is wrong or lost, the Worker works**: point the Worker at a new object. Change `WATCH_OBJECT` in
  `worker/src/env.ts` from `watch-v1` to `watch-v2` (then `-v3`, never a name used before) and push; `Watch deploy`
  ships it. Every route, Ops and `WatchApi` then address the new, empty object. The old one keeps its data and stops:
  its next alarm sees that the Worker no longer addresses it and never arms another (no check, task or backup). To go
  back, set the old name again: the first API call arms its alarm. Both objects use the same `watch-evidence`, so
  evidence the new object has pruned meanwhile is gone for the old one too (its snapshots say unavailable).
- **The namespace or the account is gone**: deploy the Worker (`docs/rebuild.md`); its `watch-v1` is a new, empty
  object.
- **`watch-backups` is gone too**: create it through `infra/` ("Infra apply"), then upload an owner download into it
  (below) before restoring.
- **Only `watch-evidence` is gone**: the rows are intact. Restore into a new object (the first case): the restore puts
  the evidence back.

### Step by step

1. If the old object still runs, nothing needs stopping by hand: the new object takes over at the deploy, and the old
   one stops at its next alarm.
2. Make the store empty (above) and open `https://watch.ziyixi.science/status` signed in. On an empty store the page
   offers 从备份恢复: leave the name empty for the newest backup (`latest.json`), or type one
   (`backups/2026-10-28T112300Z/`; the R2 dashboard or `download` lists them). The API call is the same:
   `POST /api/v1/serviceStatus:restoreBackup` with `{"name": "serviceStatus", "backup": ""}`, behind Access, the exact
   Origin and `X-CSRF-Token: 1` like every owner write. The private `WatchApi` binding may not call it.
3. Refresh the page until it says 已从 … 恢复, then compare the verification: every table `n / n 行`, evidence
   缺失 0 and 校验不符 0. A failed restore names its code; start it again (the same name or another backup).
4. Check a watch and its evidence (查看截图); the first checks then run as after any downtime. A pending change of the
   backup is confirmed by its confirmation fetch as usual and may be notified once.
5. The restored object backs itself up at its next alarm, a second after the restore: 健康 and Home show that
   backup's age, then a new one every day at 11:23 UTC.

### On the owner's machine

`tools/backup-restore.ts` (Node, no dependencies) works on a private directory outside the repository, owner-only, and
never prints row or page content. `PRIV` is such a directory, for example `mkdir -m 700 ~/.local/share/watch-restore &&
PRIV=$_`; delete it afterwards. From `watch/`:

```sh
node tools/backup-restore.ts download --out "$PRIV/restore" --remote                      # the newest backup
node tools/backup-restore.ts download --out "$PRIV/restore" --remote --backup backups/<job start>/
node tools/backup-restore.ts verify --in "$PRIV/restore"
node tools/backup-restore.ts upload --in "$PRIV/restore" --bucket watch-backups --remote  # into a new, empty bucket
```

`download` reads `latest.json` (or the named backup), the manifest, every part and every evidence copy with
`wrangler r2 object get --remote`, and checks each against the manifest's SHA-256; `verify` checks a download again
(SHA-256, gzip, rows and columns, evidence sizes). `upload` puts a checked download into a bucket, the evidence and
parts first and the manifest last, never `latest.json`: name the backup when restoring from it. `--local --persist-to
<dir>` in place of `--remote` works on local buckets.

### What a restore does not bring back

- What happened after the backup (at most a day): its changes, events and evidence. The first checks after the
  restore compare the pages with the restored notified state and report what changed since, as after any downtime.
- Tasks the backup had not handed to Tasks yet (settled, not sent: the changes are in the inbox), and Tasks' or
  Personal MCP's own records, which their apps keep.
- The Worker's secrets (`ACCESS_OWNER*`, from GitHub as at every deploy) and its code and configuration (git).
- PreviewWatch's 15-minute cache, and the backup state: the new object keeps its own and backs itself up right
  after the restore.

## Tested

- `worker/test/runtime/backup.test.ts` (workerd, real SQLite and R2): a store with a row in every table backed up in
  bounded steps (parts within 4 MiB, 16 MiB and 40 evidence copies a step, one PUT per object), the next day copying no
  evidence again; a failed step repeated without duplicates; a failed job retried 6 hours later; 30 kept backups and
  their evidence, nothing older; an empty store skipped; restores refused (store not empty, unknown, newer schema);
  a restore with lost evidence equal row for row and byte for byte, with its verification; a changed part failing a
  restore that a repeated restore then completes; Home's view; the R2 calls of a step (210 evidence objects and 45
  lost ones: at most 40 GETs a backup step, at most 200 HEADs a restore step); the restored store's own backup at its
  next alarm; a repeated last step that never rewrites the manifest; a newer prefix and its evidence kept; a backup
  bucket emptied and made again getting every evidence copy again; a table the backup cannot name failing the job
  while the scheduler goes on.
- `worker/test/runtime/restore.test.ts` (the real `WatchState`): a day of watches, changes, a screenshot, tasks and an
  unsent task request backed up from the alarm with writes refused meanwhile; `download`, `verify` and `upload` with
  wrangler into a new namespace's bucket; the owner's restore there (the private binding refused, writes and Home's
  guard refused meanwhile, its own backup right after), equal row for row with every evidence object byte for byte in an empty evidence bucket; then a day of
  checks and the digest send no task and a saved feed position expires. An object the Worker no longer addresses stops
  its alarm.
- `tools/test/backup-restore.test.mjs`: the tool against a stand-in for wrangler.

None of this is a production restore yet.
