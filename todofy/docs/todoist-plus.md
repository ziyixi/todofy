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
the previous ISO week (`gtd_reviews`, open or not) and at most 100 tasks already recorded for next week,
and the [weekly Bets](#weekly-bets) of the previous, this and the next account week (`weekly_bets`, at most
six), besides every [dependency](#dependencies). They cost one D1 batch per Plan answer (five statements: the
dependencies' one scan and the Bets by primary key among them), never one per task page or write; the BASIC
view of a native page reads none of them.
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

SetTaskPlan no longer takes `bet`: the weekly Bets are text now, so a request that sets it (an extension
build from before) is refused with `BAD_REQUEST` and writes nothing.

Append-steps creates at most 20 explicitly entered children. Each write freezes its command bytes
and stable Todoist Sync UUID before sending ([receipts](#receipts)). A repeated request ID must carry the
same input. Successful receipts are replayed; a lost upstream response resends the same commands.
`item_close` completes a normal task or advances one recurrence. Parents are never auto-completed.

When completion names a Focus date, Todofy confirms the actual Todoist close first, then freezes a
FlowDay timer-settlement command. Repeating a failed settlement retains the close identity and cannot
advance the recurring task again. A stale timer etag is refreshed once with a new settlement UUID.
The extension cannot call settlement itself. Its other FlowDay writes are queue order, estimates
and normal timer actions. Local/pseudo tasks retain their FlowDay identity and owner link.

## Weekly Bets

The week's Work and Personal Bets are one line of the owner's own text each, per account week, in the
planning store (`plan_notes`, kind `bets`, period = the account-local Monday, area `work` or `personal`),
tied to no task and never written to Todoist (owner decision of 2026-10-16). `SetWeeklyBet`
(`POST /api/plus/v1/weeklyBets:setWeeklyBet`, `{week_start, area, text, etag}`) is the one write:

- `core/plan.py` `bet_text` stores one line: each run of whitespace or control characters becomes one space,
  trimmed; empty means no Bet. Above 160 UTF-16 code units (the extension's `maxlength` counts the same
  units, so an emoji outside the BMP takes two) or with a lone surrogate it is `BAD_REQUEST`, as are an
  area other than `work`/`personal` and a `week_start` that is not a `YYYY-MM-DD` date.
- One D1 batch reads `plus_settings` (a confirmed setup, else `ACTION_NOT_ALLOWED`) and the row. The text
  already saved answers the saved Bet, whatever the etag and the day, so a resend after a lost answer, even
  across Sunday midnight, is safe without a request ID or a receipt; clearing a week that has none writes
  nothing either.
- Otherwise only this account week and the next one take a write (`core/plan.py` `bet_writable`, from the
  confirmed timezone, so a Bet needs no finished Monday reset: it is no label), else `ACTION_NOT_ALLOWED`;
  and only from the etag shown (the row's `rev`, empty while it has none), else `ETAG_MISMATCH`.
- The write is one upsert whose update applies only at that rev (`SAVE_BET`, `RETURNING`), so a writer that
  slips in between is refused too. Clearing keeps the row with an empty body and the next rev: a deleted
  row coming back at rev 1 would let an old tab's etag overwrite it unseen.

It makes no Todoist call (not even a metadata Sync), keeps no receipt and logs nothing of the text;
`MAINTENANCE_MODE` and the backup lease hold it like every Plus write. The rows are never deleted
(about 104 a year) and travel in the weekly backup with the rest of `plan_notes`.

The weekly Bets replaced the Bets label. A setup confirmed before keeps its `bets` binding exactly as saved
(`core/plus.py` `LEGACY_ROLES`): it is never checked against Todoist, so renaming or deleting `@bets` changes
no etag and never disables Plus, and `UpdatePlanLabels` keeps it. A new setup neither needs nor binds a
`bets` label. Old `@bets` tasks are not converted: while the binding remains, page scans and writes still
remember a task carrying the label, and the Monday reset still removes it, as before; the date-driven
Candidate If fallback still leaves such a task out. `@bets` stays in `REPLACED_FILTER_QUERIES`, now hidden
without checking any binding. `PlanningTask.bet` and `SetTaskPlanRequest.bet` are deprecated, not removed.

## Mailbox

The extension's Mailbox lists the mail Todofy turned into tasks that is still to clarify (owner design of
2026-10-16). A mail item is a completed Mail Hero event's `summaries` row: its ID is the event ID, its task
`summaries.task_id`, read through the partial index `summaries_task` (`task_id <> '' AND imported = 0`, which
every Mailbox query repeats), so the imported archive is never listed. Since 2026-10 the daily retention
deletes no summary (owner decision; it used to delete the delivered ones after 90 days): a summary is the
Mailbox's mail, and only the owner deletes mail. Delete all is the owner's way to: the mail it deletes loses
its `summaries` row (subject, summary and brief), and `mail_events`, the ledger of IDs and states, keeps its
row. A mail task deleted in Todoist itself keeps its summary. The six RPCs (`runtime/plus_mail.py`, under
`plus_lock` like every Plus call):

- `LookupMailItems` (`POST /api/plus/v1/mailItems:lookup`, at most 200 task IDs; none answers the categories
  alone): one D1 batch, no Todoist call. A read sent as POST for its body, it goes on in maintenance like the
  GET reads (the gateway's `POST_READS`, the core's `READ_METHODS`). It answers the IDs Todofy knows as mail with each one's brief and
  receive time (the ledger row's `created_at`), whether its summary is there, and the categories with their
  etag and the destination. Other tasks of the mail project are left out; the extension counts them.
- `ReadMailSummary` (`GET /api/plus/v1/mailItems:readMailSummary?id=`): one primary-key read of the full
  summary, plain text the extension never interprets; empty when there is none.
- `ReadMailSettings` (`GET /api/plus/v1/mailSettings:read`): the categories, their etag, the destination and
  the projects to choose it from (one `GET /api/v1/projects` page: the Inbox first, then the active projects,
  never the mail project; names are passed on, never stored).
- `UpdateMailSettings` (`POST /api/plus/v1/mailSettings:updateMailSettings`): at most four categories, each
  one current label (any but a planning stage's, the retired Bets', a lead window's or `active`; the two area
  labels may) and a priority P1-P4, no pair twice, and one destination (required; no default). The saved
  settings sent again answer as saved, whatever the etag (no request ID, no receipt); otherwise a stale etag
  is `ETAG_MISMATCH` and a label or project gone is `ACTION_NOT_ALLOWED`. One D1 batch replaces the set:
  `plan_categories` rows of scheme `mail` (a pair kept keeps its ID; a removed one is archived, never
  deleted, so an ID is never reused) and the Todoist adapter's document `plan_settings` `todoist.mail`
  (each category's label ID and name, and the destination's project ID). The name is generated from the
  label and the priority (`office · P2`); the extension shows the area labels by their domain names.
- `FileMailItem` (`POST /api/plus/v1/mailItems:fileMailItem`, `{task_id, etag, category_id, categories_etag,
  request_id}`): one Todoist write under a [receipt](#receipts). It syncs the labels first, checks the
  categories etag, that the destination is still an active project (one `GET /api/v1/projects` page; one
  archived or deleted since it was chosen is `ACTION_NOT_ALLOWED`, and the extension opens the categories),
  the task's etag and that the task is still a top-level task of the mail project, then freezes two commands
  in one Sync: `item_update` (every label the task has plus the category's; an area label replaces the other
  area label; priority `5 - P`) and `item_move` to the destination. A label gone is `ACTION_NOT_ALLOWED`:
  Plus never creates a label. It answers the task read again. A repeat of a started receipt reads the task
  first: once it has left the mail project the filing is done (the receipt finishes, nothing is sent);
  otherwise the frozen commands go again only if the task, the category's label and the destination as they
  are now build the same commands. A label renamed since (the plan etag covers only the role labels) or one
  the owner added is `ETAG_MISMATCH`, so a retry never writes a name Todoist no longer has, which Todoist
  would create, nor drops the owner's label; the extension's next choice is a new request.
- `DeleteMailItems` (`POST /api/plus/v1/mailItems:deleteMailItems`, 1-200 task IDs and a request ID): a
  permanent deletion of exactly the tasks the owner saw listed and left untouched. Todofy reads the mail
  project again (at most five pages, else `ACTION_NOT_ALLOWED`) and keeps every task that is not an active
  top-level mail task of the project with no label, priority P4, no due date, deadline or duration, no
  sub-task, a comment count of 0 (an absent count keeps it), no dependency edge in the planning store and no
  unfinished Plus write: a started receipt of the last 30 days whose commands name it (`plus_receipts.writing`,
  a `json_each` over the started rows by the partial index `plus_receipts_started`; a started deletion does
  not count), since its label, step or move may not be in Todoist yet. The deletable ones become
  `item_delete` commands frozen in the receipt before any is sent, at most 100 a Sync; a deletion's
  `ITEM_NOT_FOUND` counts as done (a dedicated `gone_ok` path, deletions only). A repeat of a started
  receipt reads the frozen tasks again with the same checks and resends only the commands of those still
  deletable, with their frozen UUIDs: a mail the owner labelled, commented on, dated, re-prioritised, moved
  or gave a step to since the first try stays (Todoist would delete a new step with its parent). No ID is
  ever added, so the batch first chosen bounds every deletion, and none is deleted twice. One confirming
  read (`GET /api/v1/tasks?ids=`, the tasks sent and those the project read did not find) must find none of
  those sent, else `UNAVAILABLE` and the same request finishes the rest. A listed task found nowhere is gone
  already (deleted in Todoist, or by an earlier request whose answer was lost and whose confirmation the
  owner then closed) and counts as deleted, as `ITEM_NOT_FOUND` does; one moved to another project is kept.
  Then one D1 statement (`FORGET`) deletes the `summaries` rows of the deleted mail, before the receipt
  finishes, so a repeat after a failure deletes them too. The receipt keeps only the indexes of the kept
  tasks. The extension checks again, just before it sends and before each Try again, what Todofy cannot
  see: a FlowDay estimate or day queue, the running timer and a write on its way.

The receipts keep IDs only; logs carry method, counts and codes, never a subject, brief or summary.

### Briefs

Each row's second line is a one-sentence brief. `SUMMARY_EMAIL` has one deliberate line since 2026-10 (the
rest is still the Go service's bytes, pinned by `tests/unit/golden/prompt_summary_email.txt`): the summary
starts with one plain sentence of at most 40 Chinese characters on its own line. `core/mailbox.brief_of`, a
pure function, reads it from the first 600 characters of any summary: the first line that is not blank, the
truncation notice, an old description header or rule, or a heading-like line, without markdown, cut at its
first sentence, at most 60 characters. It is the same call to the same models, with no JSON mode. Migration
`0008_mail_briefs.sql` adds `summaries.brief`: a completed summary stores its brief there (`COMPLETE_SUMMARY`,
empty when none is found); NULL means never derived, and a lookup then derives it from the summary at read
time.

The mail summarised before that line existed gets a model-written brief once (`runtime/mail_briefs.py`): the
alarm, only when the ledger had no work, reads the mail project once Plus is set up, queues each mail in the
Mailbox whose brief is NULL (the object's SQLite `mail_brief_queue`), and then asks the model for one mail
per alarm (`prompts.BRIEF_EMAIL`, the stored subject and the summary's first 4,000 characters, fenced as
untrusted like every model input). The answer goes through `brief_of` and is stored only over a NULL. Each
call reserves its tokens against `GEMINI_DAILY_TOKEN_BUDGET`, and the backfill stops for the UTC day once it
would take the day past half the budget, leaving the rest to new mail. Its calls are 30 seconds apart
(`mail_briefs.PACE`; `MAIL_BRIEFS_PACE_MS` shortens it in tests), two a minute, so a large backlog stays
under Gemini's per-minute limit, which new mail shares. Each attempt is counted before its call, so one that
throws (the model's transport, or the D1 save after it) counts like one that fails: a mail tried three times
keeps its read-time brief. Once the queue is empty the job is done and never runs again; a step that throws
is tried again ten minutes later. `PROCESSING_PAUSED`, `MAINTENANCE_MODE` and the backup lease hold it like
the ledger. Losing the object's SQLite only collects again, which finds what is still NULL.

## Weekly rollover and controls

Rollover is disabled until mapping confirmation. The existing ten-minute cron observes planning marks;
after Monday 00:00 in the confirmed Todoist timezone, it processes up to five remembered old-week tasks
per invocation. Unfinished old commitments become weekly candidates; while a setup still binds the retired
Bets label, it is removed from old tasks without changing their candidate stage. Unrelated labels, task content, dates and history remain intact. A
remembered task with no mark left to reset gets no Todoist write, and one deleted in Todoist is
forgotten, including while its reset waits to be retried.
New-week extension decisions wait for the old batch to finish and replace the remembered membership,
so an old reset cannot clear those decisions. Repeating setup also settles an ended week first.

A commitment chosen on Sunday is a choice for the next week. On the last day of the week in the
account timezone, a SetTaskPlan that sets `stage = committed` records the task under the next week's
Monday, so the coming reset leaves its marks in place; the reset a week later treats it like any other
commitment. A task has one membership row, so all of its marks stay: a task still labelled Bets that is
committed on Sunday keeps the label for that week too. Next week's Bets are text, written in Sunday's
weekly review with `SetWeeklyBet` ([weekly Bets](#weekly-bets)). Only Plus writes choose; a mark added in native Todoist on Sunday resets as usual, and so does an unfinished commitment made
earlier in the week. The membership is recorded from the labels just written, right after the Sync write,
so a failed confirming read cannot leave the choice to a page scan. If the Sync answer itself is lost,
the extension's weekly review still lists the task as not kept, with "Keep for next week".

While the task keeps a mark, its row never moves back to an older week (`REMEMBER_WEEK`), so neither the
ten-minute page scan nor an unrelated write that day can undo the choice, although both update its marks.
A Plus write that leaves a task with neither mark forgets its row: Monday has nothing to reset, a choice
kept earlier that Sunday is undone, and a mark added again that day resets on Monday as usual. Choosing the stage a task already shows changes no label, so "Keep for next week" in the
extension's weekly review, which sends the commitment again, never drops another horizon label.
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
metadata read is a full Sync and every extension token is checked in D1, as before them; `cache` (bootstrap's
value; a deploy refuses the variable unset, as for every switch) turns them on. A label write on a Monday syncs once in either mode: the
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
categories; `summaries` gains `category_id` and `triaged_at` (unused so far: a filing's result is in Todoist).
[Dependencies](#dependencies) (`plan_tasks` and `plan_edges`), the weekly Bets (`plan_notes` kind `bets`,
[weekly Bets](#weekly-bets)) and the [Mailbox](#mailbox)'s categories (`plan_categories`, `plan_settings`
`todoist.mail`) are its writers so far; `plan_marks` is not read or written yet. The
migration is additive, so a code rollback leaves them idle (the release before ignores the Bets' rows). Never run its down DDL in production (dropping
the columns rewrites every summaries row). The vocabularies and limits the CHECKs leave open are in
`core/plan.py`; only `runtime/plan_store.py` touches the tables. No retention deletes their rows.

The Mailbox's index `summaries_task` is partial on `task_id <> '' AND imported = 0`: building it writes an
entry only for mail Mail Hero delivered, not for the imported archive (whose size was not counted before
the release), and the Mailbox's queries repeat both terms, so the Mailbox never lists imported mail.
Migration `0008_mail_briefs.sql` adds `summaries.brief` ([Briefs](#briefs)); a backup from before it
restores its mail with a NULL brief, which the read derives.

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

## Dependencies

One task can wait for others: `SetTaskDependency` (`POST /api/plus/v1/tasks:setTaskDependency`) adds or removes
that `task_id` waits for `prerequisite_id`. The dependency lives only in the planning store, as a `plan_edges` row
of kind `waits_for` between two `plan_tasks` IDs (each task's Todofy ID, created the first time it takes part);
nothing is written to Todoist, so no title, description, comment, label or `updated_at` changes, and the
dependency is invisible to Todoist's own apps. The wire keeps Todoist task IDs; `runtime/plan_store.py`
translates at the boundary, and `core/sql/plan.py` takes the provider as a bound value. Adding reads Todoist
once (`GET /api/v1/tasks?ids=`, never a Sync, at most 200 IDs): both tasks, to confirm they are active and to
take the prerequisite's `completed_count` as `baseline_count`, with what the task already waits for and every
task the prerequisite waits for, directly or not, to tell which dependencies still hold (both tasks active and,
for a recurring prerequisite, no completion since: `core/plus.py holds`). Removing reads nothing. Both are
value writes under `plus_lock` without a receipt: adding a dependency that holds answers it unchanged (its
first baseline stays), adding one that is done starts it over from the current count in its own row, and
removing a missing one answers the same list. Only dependencies that hold count (`core/plan.py
check_dependency`): a cycle through them (the prerequisite already waits for the task, directly or not, or the
task itself) and a task already waiting for 5 are refused with `ACTION_NOT_ALLOWED` (the extension greys a cycle
out first and stops at 5). A done dependency closes no cycle and gives way: when the task has 5 rows, or the
store 300, its oldest done one is removed in the same batch, so a task never fills up with what is done. A task
that is not active is `NOT_FOUND`. They need only Plus enabled in D1: no metadata sync, no week check.
Maintenance and the backup lease hold them like every other write.

Recurring prerequisites follow Todoist's documented counter: the v1 Task object (ItemSyncView, which
`GET /api/v1/tasks` and the Sync API return) has a required `completed_count`, which the official API reference
(checked on 2026-10-16) describes as going up with every completion, recurring occurrences and re-completions
included, and down when a recurring completion is undone. A recurring task never leaves the active list, so the next completion after the
dependency was added satisfies it: `completed_count > baseline_count` (an undone completion makes it wait
again). `PlanningTask` carries `recurring` (`due.is_recurring`) and `completed_count` (absent when Todoist
leaves it out); a recurring task without the counter cannot be chosen, and the server refuses it with
`ACTION_NOT_ALLOWED`. Nothing is rescheduled or relabelled when a dependency is satisfied: the extension only
shows the waiting task as ready.

Every FULL Plan answer (ReadPlan without `view: BASIC`, ConfirmPlanMapping, UpdatePlanLabels) carries every
dependency, IDs only, as one more statement in the review batch (`plan_store.EDGES`: one scan of at most 300
`plan_edges` rows and two rowid lookups each); `done` says Todofy confirmed the prerequisite completed, not
deleted (`plan_tasks.closed_as`). The extension trusts the active list first: a prerequisite missing from a
complete read is satisfied at once, whichever way it closed, and a listed one (reopened) waits again.

`CompleteTask` in Plus records the task `closed_as = 'completed'` after Todoist confirms the close, one D1
statement, so its waiters are settled without an activity read. Todoist has closed the task by then, so the
record is best effort: a failed one is logged (`{"plus": "completion_unrecorded"}`, the error type only) and the
call still answers the completion; the next check reads the activity log instead. It does not drop what the task
itself waited for: a recurring task stays active and keeps its dependencies; a closed one's go at the next check.
A done dependency stays, as the extension's line that the task can start, until its task leaves the active list,
a new dependency takes its place, or the owner removes it (one value write each).

`ResolveDependencies` (`POST /api/plus/v1/tasks:resolveDependencies`) is that check. Once per complete read
that Plan's Review board shows (the one view that tells its notices), the extension names at most 20 tasks:
those that dependencies mention but the read did not list, the tasks that waited first, and a prerequisite
recorded completed that the read lists again; each once in a visit, so the rest have their turn at the next
read. Focus, Week and native pages never call it. The server keeps those with a dependency, confirms in one
`GET /api/v1/tasks?ids=` which are active (a stale or partial read changes nothing; an incomplete answer fails
the call), opens again a task recorded closed that Todoist lists (reopened, so that a later deletion is settled
too), removes what a gone task waited for, and settles each gone prerequisite whose closing is not recorded from
its activity log (`GET /api/v1/activities?object_type=item&object_id=…&object_event_types=["item:completed",
"item:uncompleted","item:deleted"]`, the documented JSON form; the answer is also filtered by task and event).
The newest event decides: a completion records `completed`; a deletion records `deleted` and removes every
dependency on it, and its waiters come back in `dropped_task_ids` for a one-time notice. When the log does not
say (no closing event, as for a task in an archived project or past the plan's log retention, or a reopening
last), nothing is recorded, the dependencies on it are removed and the waiters come back in `released_task_ids`,
for a notice that claims neither. At most 10 activity reads per call (with the ID read, 11 external subrequests
of Workers Free's 50); a failed one leaves that prerequisite and the rest for the next check. The activity log
depends on the Todoist plan: its 403 does not start the six-hour Todoist block that a 403 elsewhere does
(`plus_todoist.call(forbidden_blocks=False)`), and since without the log nothing tells a completion from a
deletion, that prerequisite and the rest of the call's are released, so none stays unknown. D1: the settings
read, one roles read and one batch of at most nine statements, eleven in all, under the 50 per invocation. There
is no receipt: settling twice gives the same rows.

## Local verification

`tests/unit/test_plus.py` covers classification and filter semantics, the Sunday rule and the
never-backwards membership in SQLite, the literal `active` label and the replaced-filter consistency gate.
`tests/runtime/test_plus.py` also checks that `active` is refused without the label (no Sync write) and
written and removed with it, keeping a Sunday choice's week. Gateway tests cover credential,
CSRF, bounded proxy and frozen settlement behavior. `tests/runtime/test_plus.py` exercises the real
gateway, Python Durable Object and D1 against synthetic Todoist Sync/REST responses, including lost
responses, recurring completion, week rollover (Sunday choices kept, earlier commitments reset, scans
unable to move a choice back) and shared pause/auth controls. The gateway CPU suite
includes full 200-task Plus and FlowDay-proxy pages, a FULL Plan with 500 labels, 300 dependencies and six Bets,
which the gateway reads and writes again (first runs 0.5-0.9 ms, warm medians 0.7 ms on 2026-10-16), and the
Mailbox's two largest answers. Production and browser acceptance are recorded
separately in the extension's verification document; a local test result is not production evidence.

Dependencies: `tests/unit/test_plus_dependencies.py` runs the cycle and limit rules (a done dependency closing no
cycle and giving way) and both RPCs on host CPython (the activity log through the real `plus_todoist.call`, so its
403 is seen not to block Todoist, D1 statement counts per call, a reopened prerequisite deleted later, a released
one, a failed completion record), `test_plan_store.py` the dependency statements and the edge read's query plan,
and `tests/runtime/test_plus_dependencies.py` the same paths through the gateway with the extension token in
workerd: no Sync command, `plan_edges` by Todofy IDs, a recurring prerequisite's counter and its restart, a done
dependency giving way, settling from the activity log, a 403 (released) or 503 log. The PlusFake answers `ids`
lookups and the activity log.

The weekly Bets have their own: `tests/unit/test_plus_bets.py` runs `bet_text` (whitespace, control characters,
an emoji ZWJ sequence, 160 UTF-16 code units, a lone surrogate), the writable weeks across the Sunday
midnight, and SetWeeklyBet and `weekly_bets` through `plus_api.handle` on host CPython (create, change,
clear at the next rev, a stale etag refused, the saved text as a replay without a write, an ended week, a
setup that is missing, bad areas and dates, maintenance and the backup lease, no Todoist call and no receipt);
`test_plus.py` and `test_plus_rollover.py` the retired Bets label (refused, kept as saved through a rename,
still reset on Monday while bound, neither written nor reset for a new setup); `tests/runtime/test_plus.py`
the same write in workerd through the gateway with the extension token (D1 rows, no upstream call). The
runtime Plus suite binds the retired label in its saved setup, as the owner's production setup does.

The Mailbox has its own, synthetic mail only: `tests/unit/test_mailbox.py` (`brief_of` on new and old
summaries, notices, headers, heading-like lines, English mail, length and empty answers; the generated names,
kept IDs and etag of the categories; the membership, filing and untouched rules), `test_plus_mailbox.py` (the
six RPCs through `plus_api.handle` on host CPython: D1-only reads, settings replayed by value and refused when
a label or project is gone, one Sync for a filing under a receipt, a lost answer finished by the same request,
a partial filing finished, a retry refused after a label rename or a label added, no move into a project
archived since; Delete all's every keep rule, a repeat that reads the frozen tasks again and keeps one the
owner labelled, commented on, re-prioritised, dated, moved or gave a step to since the first try, a mail an
unfinished Plus write is changing, a mail already gone counted as deleted, the deleted mail's summaries
gone with their ledger rows kept, the bounds, maintenance, and no mail text in the logs or receipts),
`test_plus_receipts.py` (`writing`: the commands it names, the window, a started deletion and its index),
`test_mail_briefs.py` (the backfill's collection, one mail per step, the budget share, the pace between calls,
failures, a step that keeps throwing given up after three attempts, a postponed step, logs with counts only)
and `tests/runtime/test_plus_mailbox.py` (the same in workerd through the gateway, with the backfill run once
from the alarm, a Todoist 429 before a retry, and the unfinished-write guard over the object's own SQLite);
`test_prompts.py` pins the prompt's one deliberate line and `test_reports_retention.py` and
`test_scenarios_retention.py` keep every summary the owner did not delete. The gateway's `test/plus.test.ts`
answers the POST lookup in maintenance and refuses a deletion, and its CPU suite measures the 200-item lookup
and the 64 KiB summary read, both passed through unread.

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
