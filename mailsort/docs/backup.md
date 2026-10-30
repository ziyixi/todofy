# Backup and restore

The SQLite Durable Object `MailsortState` (object `mailsort-v1`) is the only copy of the owner's settings, saved
prompt, priority labels, decisions and verdicts, write ledger with its undo data, historical examples, model usage and
counters. Mailsort backs it up itself every day into its private R2 bucket `mailsort-backups`, and restores a backup
into an empty object through its owner API. Gmail stays the mailbox: labels on mail are Gmail's, not the backup's.

## What the daily backup holds

`worker/src/backup.ts` reads the schema from SQLite itself, so every table is copied, including one a later release
adds, with its `CREATE` statement and indexes. Nothing in the store is a cache the app could rebuild, so nothing is left
out:

| Table | Holds |
| --- | --- |
| `meta` | Settings and the selected provider, the saved base prompt and personal rules, priority setup, schedule, Gmail sync and auth state, provider errors and holds, the schema version |
| `labels` | P1-P4 and the historical labels with their Gmail identities |
| `pending` | Mail waiting for a decision, with attempts and deferrals |
| `decisions` | Every decision and verdict; content columns until their 14-day clearing |
| `review` | The historical review queue |
| `examples` | Historical masked examples and their embeddings (blobs) |
| `ledger` | Every Gmail write with its original labels and Inbox position (the undo data) |
| `usage`, `flow`, `claude_usage`, `codex_usage` | Daily counters, the flow counters, recorded Claude usage and cost (the monthly budget), historical Codex rows |
| `feedback` | Label changes read from Gmail history, waiting to become verdicts |
| `requests` | AIP-155 request receipts (one day) |
| `retired_labels`, `gmail_parents`, `trusted_domains`, `label_aliases` | Label identity history |
| `replay` | The retired replay evaluation's results |
| `label_merge_jobs`, `label_merge_items`, `label_merge_hides` | The finished label consolidation's records |
| `unread_batch` | The explicit unread batch and its progress |

Not in the backup, by design:

- the object's key-value storage: only the backup job's and a restore's own state;
- the alarm, the next pass time and the Gmail access token, which live in memory or are armed again;
- the Gmail OAuth grant (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`): Worker secrets the owner puts
  with `deploy/mint-token.mjs`, never in the store. A restore needs them unchanged on the Worker; after a lost Worker,
  put them again with `deploy/mint-token.mjs`;
- code and configuration (git), Access and the bucket (`infra/`), the Access owner identity (GitHub secrets) and Model
  Router's own state and provider consoles.

## Schedule, steps and layout

The object's own Alarm runs the job daily at 11:41 UTC, and at once when the object has no backup state: right after
the release that bound the bucket, or right after a restore. No cron, secret or other service is involved. A store with
none of the owner's records (a new object before its setup or restore) is not backed up.

While a job runs (a minute or so) the pipeline waits, so the copy is one moment of the pipeline; only an owner edit
made during the job may be partly in it. The job works in steps a second apart, each bounded for Workers Free: the
plan, then pages stored as parts (at most 32 parts and 8 MiB of rows per step, a part at most 5,000 rows and about
1 MiB), then the manifest. A cursor moves only after its part is stored; a failed step runs again from the parts
stored, overwriting the same keys. Three failed steps in a row, or a job running over 30 minutes, fail the job; it
starts again 6 hours later, and after three failed jobs in a row at the next daily start.

```text
backups/<job start>/<table>/<n>.ndjson.gz   gzip NDJSON, one JSON array per row in the manifest's column order
backups/<job start>/manifest.json           written after every part: a prefix without it is incomplete
latest.json                                 {"key": "backups/<job start>/"}, written after the manifest
```

`<job start>` is the UTC second the job started, `2026-10-28T114100Z`. The manifest (`mailsort-backup-v1`) records
the object's name, the schema version and every table with its statement, indexes, columns, key, rows and each part's
row count and SHA-256 (also in the part's R2 metadata). A rowid table's rows carry their rowid; a `WITHOUT ROWID`
table's are in key order. A value is JSON: `null`, a number, a string, `{"blob": <base64>}` or `{"real": "Infinity"}`.

## Retention

Retention is in code, never an R2 lifecycle rule, so a stopped job never ages out the last good copies. After each new
complete backup, the newest 30 complete backups are kept; older complete ones and every incomplete prefix older than
the new one are deleted, each prefix with all its objects. A job never rewrites or deletes a kept backup.

Backup size and work are measured from the actual manifest and run state. Account quotas are shared; this is not a billing or restore-time guarantee.

## Ops

Home's mailsort tile reports `backup_age_seconds` and `last_backup_at`, and two app-only signals: `backup_stale`
(critical: no complete backup for 3 days; before the first, 3 days after the first job) and `backup_failed` (warning:
the last job failed).

## Restore

### A recent mistake

Cloudflare keeps 30 days of point-in-time recovery for SQLite Durable Objects, but it can only be triggered by code
inside the object (`getBookmarkForTime` and `onNextSessionRestoreBookmark`). Mailsort has no such call, so it is not a
path today; use a daily backup.

### Into an empty store

A restore loads a backup into an empty store only: no labels, decisions, ledger or other records. A new object fills
`meta`, `pending`, `usage` and `requests` by itself before its setup (history registration and counters); the restore
replaces them. It never loads over a store that holds the owner's records.

`PRIV` is a private directory outside the repository, for example an owner-controlled isolated recovery location.
The files written there hold the owner's mail metadata; delete them afterwards.

1. Choose and check the backup. From `mailsort/`, download the newest one (or `--backup backups/<job start>/`; the R2
   dashboard lists the prefixes). `download` checks every part's SHA-256, row count and width:
   ```sh
   node tools/backup-restore.ts download --out "$PRIV/restore" --remote
   ```
   It prints `backup backups/<job start>/` and a `PASS` line per table. `sqlite --in "$PRIV/restore" --out
   "$PRIV/mailsort.sqlite"` loads the same data into a local SQLite file to read without Cloudflare.
2. Get an empty store. Change `MAILSORT_OBJECT` in `worker/src/env.ts` from `mailsort-v1` to a new name
   (`mailsort-v2`), commit, and release it through the main Actions workflow as usual. The Worker now routes the owner
   API and Ops to the new, empty object. The former object's alarm ends at its next run without a pass, so it never
   writes to Gmail again; its data stays as it was, readable by switching the name back. After losing the Worker or
   its namespace, a fresh deploy already gives an empty `mailsort-v1`. Until the restore starts, the new object only
   registers Gmail history: classification waits for the priority labels the backup holds. Do not run the priority
   setup in the new object: its labels would make the store non-empty.
3. Only when `mailsort-backups` lacks that backup (a new account, a deleted bucket, or a copy older than the newest
   30): put the download back,
   ```sh
   node tools/backup-restore.ts upload --in "$PRIV/restore" --bucket mailsort-backups --remote
   ```
   Do it after step 2: from then on no object runs a backup job, so no retention can delete the copy before the restore
   has read it (the former object's next daily job would delete a copy older than the newest 30).
4. Start the restore. On `https://sort.ziyixi.science/`, signed in through Access, open the browser console and run
   ```js
   await (await fetch('/api/v2/backupRestore:start', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': '1' },
     body: JSON.stringify({ name: 'backupRestore', backup: 'backups/<job start>/', request_id: crypto.randomUUID() }),
   })).json()
   ```
   It answers `state: "running"`, or a refusal: `RESTORE_TARGET_NOT_EMPTY` (the store holds records: nothing was
   changed), `BACKUP_NOT_RESTORABLE` (missing, incomplete, unreadable or newer than this release), `RESTORE_ACTIVE`
   (one runs). It is an ordinary owner mutation: Access, the same-origin check and the CSRF header apply.
5. Watch it with `await (await fetch('/api/v2/backupRestore')).json()`. The object drops the new store's tables,
   creates the backup's schema, then loads the parts in steps a second apart, checking each part's SHA-256 and row
   count before inserting it. It writes at most 50,000 SQLite rows (indexes included) per UTC day, half the account's
   free allowance, which every Durable Object shares: a larger store continues at `resume_time`. A decision or ledger
   row costs about five of them (its indexes), so a store with 30,000 decisions and as many ledger rows takes about six
   days; the manifest's row counts give the estimate before step 4. Until it succeeds
   every other mutation answers `RESTORE_ACTIVE`, and neither the pipeline nor the backup runs.
6. When `state` is `succeeded`, `tables` is the verification: every table's rows counted in the store against the
   manifest. The store is migrated from the backup's schema version, then a new backup of it runs at once and Home
   shows its age. Check the UI's queues and settings.

A failed restore shows `state: "failed"` and an `error_code` (`part_checksum`, `part_missing`, `part_rows`,
`manifest_missing`, `manifest_invalid`, `count_mismatch`, `storage_error`); mutations stay refused. Fix the cause (step
3 puts back a damaged backup) and run step 4 again: it starts over from an empty schema.

### What the restored state does, and does not

- Nothing is sent to Gmail again. A ledger intent in flight in the backup (`intended`) fails with `last_code`
  `restored`, its decision only recorded; an undo in flight (`undo_intended`) leaves its write `applied`. An unfinished
  explicit unread batch ends: the mail it still waited for is skipped; start a new batch if wanted.
- Intake resumes from the mailbox's current state: the Gmail history cursor is dropped, so the next pass starts history
  there, and label changes made since the backup are never read as the owner's feedback. Mail that arrived since is
  picked up by the ordinary bounded catch-up of recent unclassified Inbox mail (48 hours); older mail stays as it is.
- Writes the former object made after the backup are not in the restored ledger, so the app cannot undo them; the
  labels stay in Gmail. Recorded Claude usage, mode, limits and prompts come back as they were backed up.

## Rehearse locally

`worker/test/runtime/backup.test.ts` runs the whole path in workerd: a populated object backs itself up from its alarm
into a local R2 bucket, a second, empty one restores it through the owner API, and every table matches row for row
and value for value (its SQLite type included), with the schema; then the pipeline resumes without a Gmail write. It
also covers a damaged part and a restart, the daily write allowance, in-flight writes, the Ops view and this tool's
download with wrangler. `backup-steps.test.ts` covers failed steps, a failed job, an empty store and retention against
a local R2 bucket, and `cpu.test.ts` measures the heaviest backup and restore steps. `bazel test //mailsort/tools:check`
covers the tool on synthetic backups. The same commands work on a local bucket with `--local --persist-to <dir>` in
place of `--remote`.

The committed synthetic build/test path is `bazel test //mailsort:check`. Runtime backup/restore tests and tool checks are selected as leaves from that facade; remote recovery commands above are separate authorized operator work.
