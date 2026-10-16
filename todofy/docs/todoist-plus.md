# Todoist Plus backend

The Chrome extension lives in `todoist-plus/`; it calls the separate `PlusService` in
`proto/todofy/ui/v1/plus_service.proto`. Todofy owns every Todoist write. FlowDay owns
its local queue, estimates, timer and time entries. Neither service imports the other's code.

## Setup

1. Publish FlowDay's `FocusEntrypoint` service entrypoint, then Todofy with its `FLOWDAY_FOCUS` binding.
   `FLOWDAY_PUBLIC_URL` is the configured owner link used for FlowDay-only tasks.
2. Open Todofy's `/plus` page under the existing Access login. Check the exact labels and account
   timezone. Missing or ambiguous labels prevent confirmation; labels are never created automatically.
3. Confirm the mapping once to enable planning writes and Monday rollover. This initially reads all
   active tasks, at most ten 200-task pages, before saving setup. A partial read does not enable it.
4. Issue a named connection token, copy it into the extension settings, and keep the existing Todoist
   credentials on `todofy-core`. Only the token's SHA-256 digest is stored. Repeating token creation
   returns metadata without disclosing the token again; revoke it on this page when no longer needed.

The owner API retains Access, same-origin and CSRF checks. The hooks host requires the separate
`todofy_plus_` token on `/api/plus/v1/*` and `/api/plus/flowday/*`. It does not grant the extension
owner setup, generic service proxying, FlowDay task creation, or arbitrary FlowDay task edits.
The extension background calls these routes using host permission; page CORS is not enabled.

## Planning and completion

`ReadPlan` returns mapping, account-local dates and IDs of exactly matching replaced filter queries
(`REPLACED_FILTER_QUERIES`, normalized without spaces and with `%` as `@`; generic label semantics only).
Besides the planning, must-start and missing-lead views, they include waiting with a deadline
(`!nodeadline&(@blocked)&!@parked`, also without the parentheses), all waiting (`@blocked`) and in progress
with a deadline (`@active&!nodeadline&!@blocked&!@parked`). The extension's Review board shows a waiting or
must-start task in its Waiting or Start now lane, or in its own stage lane saying so; an in-progress task was
acknowledged and needs no lane, and a deadline without a lead is the weekly review's start-ahead line. The
quick-task and parked views are not replaced. A query joins the set only with the consistency case in
`tests/unit/test_plus.py`, which rebuilds each deadline or waiting query's task set over synthetic tasks and
requires every task to be shown by the extension's rule, stated in API fields.
Every Plan answer (ReadPlan, ConfirmPlanMapping, UpdatePlanLabels) also carries the weekly review's IDs:
the mail project (`TODOIST_DEFAULT_PROJECT_ID`), the newest review task the GTD ledger created for this or
the previous ISO week (`gtd_reviews`, open or not) and at most 100 tasks already recorded for next week.
They cost one D1 batch per Plan answer, never one per task page or write.
`ListPlanningTasks` returns bounded active pages with the canonical Todoist task ID, labels, parent,
scheduled date, true deadline, optional estimate, Todoist's last change (`update_time`, whole seconds,
from the same page's `updated_at`) and derived planning state. Counts require every page.
Task content is read from Todoist when requested; it is not kept as a second task database.
The extension builds native links as `https://app.todoist.com/app/task/<v2_id>` from that ID;
API v1 no longer returns a task URL. See the official [Task URLs contract](https://developer.todoist.com/api/v1/).

Set-plan and lead changes check the displayed etag and retain unrelated labels and the scheduled date.
SetTaskPlan's optional `active` adds or removes only the literal `active` label (the extension's "Mark in
progress"). It is never created: adding it while the account has no label of that exact name is refused
with `ACTION_NOT_ALLOWED` before any Sync write, because Todoist would create a label for an unknown
name. It is no planning mark, so it never moves a Sunday choice (`REMEMBER_WEEK` keeps the later week).
The `must_start` and `missing_lead` rules are unchanged; an `active` task is neither.
The date-driven candidate view uses scheduled date, or deadline when no scheduled date exists.
Lead windows retain the existing filter's exclusive upper boundary; `lead_1m` remains 30 days.
One Todoist duration day is 480 estimated work minutes, matching FlowDay. Unknown estimates are absent.

Append-steps creates at most 20 explicitly entered children. Each write freezes its command bytes
and stable Todoist Sync UUID before sending ([receipts](#receipts)). A repeated request ID must carry the
same input. Successful receipts are replayed; a lost upstream response resends the same commands.
`item_close` completes a normal task or advances one recurrence. Parents are never auto-completed.

When completion names a Focus date, Todofy confirms the actual Todoist close first, then freezes a
FlowDay timer-settlement command. Repeating a failed settlement retains the close identity and cannot
advance the recurring task again. A stale timer etag is refreshed once with a new settlement UUID.
The extension cannot call settlement itself. Its other FlowDay writes are queue order, estimates
and normal timer actions. Local/pseudo tasks retain their FlowDay identity and owner link.

## Weekly rollover and controls

Rollover is disabled until mapping confirmation. The existing ten-minute cron observes planning marks;
after Monday 00:00 in the confirmed Todoist timezone, it processes up to five remembered old-week tasks
per invocation. Unfinished old commitments become weekly candidates; old Bets are removed without
changing their candidate stage. Unrelated labels, task content, dates and history remain intact. A
remembered task with no mark left to reset gets no Todoist write, and one deleted in Todoist is
forgotten, including while its reset waits to be retried.
New-week extension decisions wait for the old batch to finish and replace the remembered membership,
so an old reset cannot clear those decisions. Repeating setup also settles an ended week first.

A commitment or Bet chosen on Sunday is a choice for the next week. On the last day of the week in the
account timezone, a SetTaskPlan that sets `stage = committed` or `bet = true` records the task under the
next week's Monday, so the coming reset leaves its marks in place; the reset a week later treats it like
any other commitment. A task has one membership row, so both of its marks stay: an unfinished commitment
made next week's Bet on Sunday stays committed, and a Bet committed on Sunday stays a Bet. Only Plus writes
choose; a mark added in native Todoist on Sunday resets as usual, and so does an unfinished commitment made
earlier in the week. The membership is recorded from the labels just written, right after the Sync write,
so a failed confirming read cannot leave the choice to a page scan. If the Sync answer itself is lost,
the extension's weekly review still lists the task as not kept, with "Keep for next week".

While the task keeps a mark, its row never moves back to an older week (`REMEMBER_WEEK`), so neither the
ten-minute page scan nor an unrelated write that day can undo the choice, although both update its marks.
A Plus write that leaves a task with neither mark forgets its row: Monday has nothing to reset, a choice
kept earlier that Sunday is undone, and a mark added again that day resets on Monday as usual. Choosing the stage a task already shows changes no label, so "Keep for next week" in the
extension's weekly review, which sends the commitment or Bet again, never drops another horizon label.
The extension sends only the fields the owner changed, so editing a committed task's area on Sunday does
not keep it by accident. Extension builds before this rule always send the stage from task details: reload
the extension before the first Sunday after the backend is released.

Native Todoist remains editable. Marks made there are observed by the next page scan; a native decision
made at the week boundary before that scan has no separate week identity. The extension's planning
actions record that identity immediately. There is no title matching or guess about work/personal area.

`MAINTENANCE_MODE` and the existing backup lease hold Plus writes. Reads remain available during backup,
but do not update weekly membership. The backup includes all four Plus D1 tables (token digests, and in
`plus_actions` the command receipts of the releases before [receipts](#receipts) moved into the object) and
the six planning-store tables below; the object's caches and receipts are not backed up. Backup start and
Plus mutations share the coordinator lock.
Every Plus Todoist call shares `FORCE_PAUSE_TODOIST`, auth blocking and the existing request budget.
`PROCESSING_PAUSED` retains its mail-pipeline meaning; it does not disable the confirmed weekly planner.

## Caches

TodofyCore keeps two rebuildable values for Plus in its own SQLite (`plus_cache`, `runtime/plus_cache.py`);
losing them only costs one read of where they came from.

- **Todoist metadata.** The timezone, labels and the replaced filters, with Todoist's incremental Sync token
  (`plus_todoist.metadata`). A read (`ReadPlan`, `ListPlanningTasks`, `CompleteTask`, `AppendTaskSteps`) uses
  what the object synced in the last five minutes, else makes one incremental Sync. A method that writes or
  binds labels (`SetTaskPlan`, `SetTaskLead`, `UpdatePlanLabels`, `ConfirmPlanMapping`, and the Monday reset)
  always syncs first, so a label renamed in Todoist is never written back under its old name: the write
  refuses instead (`ACTION_NOT_ALLOWED` for a renamed bound label, `ETAG_MISMATCH` for an outdated task
  etag), and the next read shows the change. An incremental answer is merged by ID (`core/plus.py`
  `merge_metadata`; `is_deleted` items leave); only the user's timezone and filters whose query is one of the
  public `REPLACED_FILTER_QUERIES` are kept, so no credential or private filter text is stored. A full Sync
  happens only with no cached token (a new or wiped object), when Todoist answers a token in full, or after
  Todoist refuses a token (a 4xx other than 401/403/429); the object starts at most 20 per 15-minute window
  (Todoist allows 100), and beyond that a call is `UNAVAILABLE`. The runtime tests' config sets
  `PLUS_METADATA_MAX_AGE_MS = 0`, so every test call syncs incrementally; production never sets it.
- **Extension connections.** The non-revoked token digests of `plus_connections`, read again from D1 after
  ten minutes; Issue and Revoke drop the copy, so a revocation holds from the next call. A token check runs
  outside the Plus lock, so Issue or Revoke can commit while its D1 read is in flight: that check answers its
  own call from what it read but keeps no copy (an in-memory count of the changes), and the copy is dropped
  before the write as well as after it, so a write whose answer is lost leaves none. A failed D1 read is
  refused (`UNAVAILABLE`), never answered from an older copy. A change made in D1 directly (a restore, a
  manual revocation) takes up to ten minutes.

The extension's call is one core RPC: the gateway checks the token's form, then passes its SHA-256 with the
rpc to `plus_ui(method, request, owner, digest)`, and the core answers `UNAUTHORIZED` for a digest that is
not a non-revoked connection's. The FlowDay proxy still asks `plus_auth(digest)` first. The gateway of the
previous release called `plus_ui` with three arguments and no digest; the core answers such a call
`UNAVAILABLE` (it is never served). The release deploys the core first, then the gateway, so this happens
between the two uploads of the release that brought this, and for as long as its gateway step stays failed
after the core step succeeded: every extension Plus call is then `UNAVAILABLE` until someone acts (the FlowDay
proxy keeps working, through `plus_auth`). Rerun the release workflow on the same SHA, or release the previous
SHA, which deploys the old core first. Neither half alone serves an unchecked call: the new gateway's
four-argument call to the old core fails too. A request the transcoder refuses (an unknown path, an invalid
body) is now answered before the token is checked.

`ReadPlanRequest.view` (`basic`, `full`; unset is `full`) lets a native Todoist page ask for the mapping
without the weekly review's IDs, which skips their D1 batch. The extension does not send it yet (an older
core refuses the unknown field), so until a later extension release every native page's `ReadPlan` costs the
FULL answer.

The core's GitHub variable `TODOFY_PLUS_METADATA` is the rollback: `full` turns both caches off, so every
metadata read is a full Sync and every extension token is checked in D1, as before them; `cache` (the value
deployed while the variable is unset) turns them on. A label write on a Monday syncs once in either mode: the
Sync it starts with also serves the week reset that runs first. Under `full` two costs differ from the release
before: a repeated `ConfirmPlanMapping` syncs once instead of twice, and a replayed planning write costs a full
Sync and a task read (see [receipts](#receipts)). Change it like the other switches
([ci-cd.md](ci-cd.md#changing-a-switch)): set it and run the release workflow on `main`. After a switch to
a restored database, `full` for at least ten minutes makes every token check follow it from the start.

## Receipts

The writes that change Todoist (`SetTaskPlan`, `SetTaskLead`, `CompleteTask`, `AppendTaskSteps` and each
label update of the Monday reset) keep their replay receipt in TodofyCore's own SQLite (`plus_receipts`,
`runtime/plus_receipts.py`), never in D1. A receipt is written `started` with the frozen Sync commands; the
object waits until its storage holds it (`storage.sync()`: Cloudflare documents the output gate that holds
back a fetch for `put()` and `delete()` only) and only then sends them. `done` drops the commands and keeps
the answer's IDs, never a title; a planning write's replay reads its task again for the answer: one Todoist
task read, plus an incremental Sync when the object's metadata is older than five minutes (a full Sync under
`PLUS_METADATA=full`), where the D1 receipt of the release before answered without Todoist. Only a lost
answer is replayed, so this costs little. A replay of a started receipt resends the same commands, and
Todoist runs a command UUID (uuid5 of the request ID) once, so a lost receipt (a wiped object) only turns a
replay into a re-run that Todoist deduplicates; a planning write whose task changed meanwhile answers
`ETAG_MISMATCH`, and the extension reads the task again. A started `SetTaskPlan` or `SetTaskLead` also keeps
the plan etag its labels were chosen under: once `UpdatePlanLabels` has bound a role to another label, its
retry answers `ETAG_MISMATCH` rather than attach a label by a name that may have lost its role. No backup
holds receipts, and nothing deletes them (the owner's rule: no automatic time-based deletion). A lookup
reads only the last 30 days, so an older request ID starts over, and a receipt that never finished keeps its
frozen commands, step titles included, in the object's SQLite only; at about 65 receipts a day that is
under 10 MB a year. The FlowDay settlement frozen after a completion is part of its receipt (`$.focus`) and
changes by compare-and-set: the first one frozen wins, and only the one whose timer etag FlowDay refused
(409) is replaced.

`UpdatePlanLabels` changes only the binding in D1 and, like `ConfirmPlanMapping`, keeps no receipt (a week
reset either settles first keeps its own). A request whose etag is outdated but whose binding is the saved
one is a replay and answers the saved plan; any other outdated request is `ETAG_MISMATCH`, so an older
binding is never written back.

Nothing writes D1 `plus_actions` any more. Its rows, the receipts of the releases before this one, are read
and never written: a request ID of the last 30 days that the object has no receipt for finds its D1
receipt. A done one answers what it stored, a started one resends its commands and finishes in the object,
and a completion's settlement (its `focus:` row) is copied into the object with it. The table and its rows
stay until a later, separately approved step (M8), which also removes this fallback: it reads D1 once for
every new write and every reset record, a primary-key miss once the 30 days after the release are over.
Receipts have no switch: rolling the code back is safe, because the release before reads only D1, so a
request the object finished runs again under the same command UUIDs, which Todoist deduplicates, and
FlowDay's timer etag guards the settlement.

## Planning store

Migration `0007_plan_store.sql` adds the store the planning features move onto, one step at a time: D1
keeps only what cannot be found again (the owner's planning facts and Todofy's own task IDs), never task
content; Todoist stays the task store. `plan_settings` holds three JSON documents (the account's timezone,
the week in effect, the Todoist binding), `plan_tasks` Todofy's task IDs with their `(provider,
external_id)` reference (never deleted, IDs never reused), `plan_marks` week marks, `plan_edges`
dependencies, `plan_notes` the owner's text per period and `plan_categories` the Mailbox triage
categories; `summaries` gains `category_id` and `triaged_at`. Nothing reads or writes them yet: the
migration is additive, so a code rollback leaves them idle. Never run its down DDL in production (dropping
the columns rewrites every summaries row). The vocabularies and limits the CHECKs leave open are in
`core/plan.py`; only `runtime/plan_store.py` touches the tables. No retention deletes their rows.

The Mailbox's index `summaries_task` is partial on `task_id <> '' AND imported = 0`: building it writes an
entry only for mail Mail Hero delivered, not for the imported archive (whose size was not counted before
the release), and the Mailbox's queries will repeat both terms, so the Mailbox (a later step) never lists
imported mail.

The weekly backup carries all six tables, `plan_tasks` last. What keeps the task IDs of a backup's marks and
edges in its `plan_tasks` is the backup's lease, which holds Plus writes and the ticks for the whole job; the
order alone would not, because `plan_marks` and `plan_edges` have no INTEGER PRIMARY KEY and a row added
during a job can reuse a deleted row's rowid inside the snapshot. If the lease is ever relaxed, take
`plan_tasks`' max rowid when its own export starts, and check `VerifyPlanStore`'s orphan counts after a
restore. A job keeps the columns it was planned with, so a release during the Sunday backup (0007 adds two
`summaries` columns) cannot mix two row widths: a job the release before saved starts over under a new
prefix. Restore inserts by column name, so a backup from before 0007 loads into the new schema with empty
plan tables and NULL triage columns. `tools/backup_restore.py` leaves out `RETIRED_TABLES` (`plus_settings`,
`plus_weeks`, `plus_actions`) only once a migration of the checkout drops them; until then they restore like
every other table.

`VerifyPlanStore` (owner only: `GET /api/plus/v1/plan:verifyPlanStore` on the owner host, under Access)
answers counts and never content: rows per table, to compare with a backup manifest, and the rows that
break a rule (marks or edges whose task ID is missing, setting keys, providers, kinds or schemes this
build does not know, and limits exceeded). An absent count is zero: right after the release the answer is
`{}`, and after a restore every `*_row_count` equals its table's rows in the manifest while every other
count is absent. It is one D1 statement over the six small tables.

## Local verification

`tests/unit/test_plus.py` covers classification and filter semantics, the Sunday rule and the
never-backwards membership in SQLite, the literal `active` label and the replaced-filter consistency gate.
`tests/runtime/test_plus.py` also checks that `active` is refused without the label (no Sync write) and
written and removed with it, keeping a Sunday choice's week. Gateway tests cover credential,
CSRF, bounded proxy and frozen settlement behavior. `tests/runtime/test_plus.py` exercises the real
gateway, Python Durable Object and D1 against synthetic Todoist Sync/REST responses, including lost
responses, recurring completion, week rollover (Sunday choices kept, earlier commitments reset, scans
unable to move a choice back) and shared pause/auth controls. The gateway CPU suite
includes full 200-task Plus and FlowDay-proxy pages. Production and browser acceptance are recorded
separately in the extension's verification document; a local test result is not production evidence.

The planning store and the object's caches and receipts have their own tests, synthetic data only:
`tests/unit/test_plan_store.py` (0007's CHECKs, the partial Mailbox index's plan, `VerifyPlanStore`'s counts)
and `tools/test_backup_restore.py` (the six tables' restore round trip, a pre-0007 backup, `RETIRED_TABLES`);
`tests/unit/test_plus_cache.py` and `test_plus_receipts.py` run the runtime modules on host CPython with a
controlled clock (the five-minute and ten-minute ages, a token check that Issue or Revoke overlaps, the
full-Sync window, the 30-day receipt window, a started label write after a rebinding, `storage.sync()` before
the Sync call, the settlement compare-and-set, the D1 fallback); `test_plus_rollover.py` counts a Monday
write's Syncs and `test_backup_job.py` a backup job across a release that adds columns;
`tests/runtime/test_plus_cache.py` and `test_plus_receipts.py` run the same paths in workerd through the
gateway (incremental Syncs, the token check in `plus_ui`, the BASIC view, `PLUS_METADATA=full`, receipts
in the object's SQLite with IDs only, the D1 fallback with a frozen settlement, a lost object storage).

Local evidence on 2026-10-13: all 549 real-workerd runtime cases passed, including eight Plus cases.
Gateway type/lint/unit checks and the owner UI's 93 tests passed. The gateway dry-run was 81.9 KiB gzip
(existing budget 86 KiB); Python core was 187.36 KiB gzip and included the generated Plus messages;
owner UI JavaScript was 175.7 KiB gzip (budget 208 KiB).

The calibrated CPU suite measured a 200-task Plus page at 1.13 ms cold / 0.56 ms warm, and a 200-task
FlowDay proxy page with 2,000-character title and description per row at 6.85 ms / 4.70 ms.
The new proxy uses its own 9.5 ms cold / 6 ms warm regression bounds; existing route bounds and the
Workers Free 10 ms limit remain unchanged. These are local reference-machine measurements, not
Cloudflare production timings or a guarantee for arbitrarily large remote descriptions.
