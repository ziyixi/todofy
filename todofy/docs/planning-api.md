# Planning API

`PlusService` (`proto/todofy/ui/v1/plus_service.proto`) is Tasks' planning and Mail API: Plan, Focus and Mail in
Tasks read and write through it. Tasks keeps the tasks. Todofy keeps the planning facts Tasks does not hold (each
task's saved stage and planning flags, the weekly Bets, dependencies, lane orders and next week's choices) and the
mail summaries. FlowDay keeps the day queues, the timer and its time entries. The service keeps the name of the
retired Todoist Plus extension ([history](../../docs/history/todoist-plus.md)), because renaming a published
service is a breaking change; its paths stay `/api/plus/v1/*`.

## Channel and allowlist

Tasks serves `/api/plus/v1/*` and `/api/plus/flowday/*` on its own origin, behind the owner's Access login, Origin
and CSRF. It forwards each request on its `PLANNING` service binding to the gateway's `Planning` entrypoint
(`gateway/src/planning.ts`, props `{source: "tasks"}`; any other source is 403). No public host routes either
prefix: the owner host and the hooks hosts answer 404.

`nativePlanning` (`gateway/src/plus.ts`) allows exactly the methods Tasks calls: ReadPlan, ListPlanningTasks,
SetTaskPlan, SetTaskLead, AppendTaskSteps, CompleteTask, SetWeeklyBet, SetTaskDependency, ResolveDependencies,
ReorderTasks, ListMailItems, ReadMailSummary, ConvertMailItem, DeleteMailSummaries, ReadMailSettings,
UpdateMailCategories and VerifyPlanStore. Any other method answers `ACTION_NOT_ALLOWED` before its body is read.
Each call is one core RPC, `plus_native_ui(method, request)`. It answers `UNAVAILABLE` unless the core's own task
source is Tasks with its `TASKS` binding, and `plus_api.handle` runs it under the coordinator's `plus_lock`.

The FlowDay half forwards only ListTasks (at most 100 a page), GetFlow, UpdateFlow, RolloverFlow, GetTimerSession
and CommandTimer to FlowDay's `NativeFocusEntrypoint` (binding `FLOWDAY_NATIVE_FOCUS`). A SETTLE command comes
only from Todofy: `CompleteTask` with a `flow_date` first completes the task in Tasks, then the gateway freezes one
FlowDay settle command in the completion's receipt (`plus_focus_claim`) and sends it. A repeat sends the same
command and cannot complete a recurring task twice. A stale timer etag (409) is refreshed once, with a new
request ID.

## Planning store

D1 keeps what Tasks does not hold, never task content. `plan_tasks` maps each Tasks task ID (provider `tasks`) to
Todofy's own ID, which is never deleted or reused. `plan_task_state` keeps a task's saved stage, area, start-ahead
days and planning flags with a revision (migrations `0009`, `0011`). `plan_edges` holds the dependencies,
`plan_notes` the Bets, `plan_categories` the mail categories, and `plan_settings` JSON documents (the account
timezone, the week in effect, the Review lanes' order `board`). The vocabularies and limits are in `core/plan.py`;
`runtime/plan_store.py` and `runtime/native_plan.py` own the statements. No retention deletes these rows. The
weekly backup carries every `plan_*` table under its lease, which holds planning writes and the ticks for the
whole job.

## Receipts

The writes that change Tasks (SetTaskPlan, SetTaskLead, CompleteTask, AppendTaskSteps, ReorderTasks,
ConvertMailItem and each task of the Monday reset) record a receipt in TodofyCore's own SQLite (`plus_receipts`,
`runtime/plus_receipts.py`) before they send anything: `started` with the frozen requests, then `done` with IDs
only, never a title. Each request to Tasks is also stored as sent, with its etag, in `native_task_requests`
(`runtime/native_plus.py`), so an uncertain answer is replayed with the same bytes and request ID. Tasks' own D1
receipt is the final authority. A repeated request ID must carry the same input, else `BAD_REQUEST`. A done
receipt answers from its IDs, and a started one resends its frozen requests. Lookups read the last 30 days.
DeleteMailSummaries keeps the indexes of the summaries it kept. D1 `plus_actions`, the receipts of earlier
releases, is read for request IDs of the last 30 days and never written.

SetWeeklyBet, SetTaskDependency, ResolveDependencies and UpdateMailCategories are value writes without a receipt:
sending the saved value again answers it as saved.

## Bets, dependencies and reordering

**Bets.** `SetWeeklyBet` saves one line of the owner's text per account week and area (`work`, `personal`) in
`plan_notes` kind `bets`: whitespace collapsed, at most 160 UTF-16 code units (`core/plan.py bet_text`). Only this
account week and the next take a write (else `ACTION_NOT_ALLOWED`), from the etag shown (else `ETAG_MISMATCH`),
by one compare-and-set upsert. Clearing keeps the row at the next revision. ReadPlan carries the previous, this
and the next week's Bets.

**Dependencies.** `SetTaskDependency` adds or removes that `task_id` waits for `prerequisite_id`, as a `plan_edges`
row between `plan_tasks` IDs; no task in Tasks changes. Adding reads both tasks to confirm they are active and
takes the prerequisite's `completed_count` as the baseline, so a recurring prerequisite is satisfied by its next
completion. A cycle through dependencies that still hold, or a sixth open dependency of one task, is
`ACTION_NOT_ALLOWED`; at five on the task or 300 in all, the oldest done one gives way. `CompleteTask` records the
task completed (best effort). `ResolveDependencies` settles at most 20 tasks that a complete read no longer lists,
after Tasks confirms they are not active: what a gone task waited for is removed; a prerequisite Tasks reports
completed is recorded done; one that is deleted, or whose closing Tasks does not report, has the dependencies on
it removed, and its waiters come back in `dropped_task_ids` or `released_task_ids` for a one-time notice. A task
recorded closed that Tasks lists again is open again.

**Reordering.** `ReorderTasks` takes 1-100 distinct task IDs in their new order, the one the owner moved, and a
Review lane (`core/plan.py LANES`) or none (Week's Next steps). In Tasks, only the moved task's siblings among them
(same project, section and parent) change: their existing positions are permuted into the given order in one
atomic write, under a receipt, and nothing is sent when nothing changes. Waiting and Parked (`UNTOUCHED_LANES`)
never change Tasks. With a lane, the order is saved in `plan_settings` `board`; every full ReadPlan carries the
arranged lanes (`lane_orders`).

## Mail

A mail item is a completed Mail Hero event's `summaries` row still awaiting a decision (`summaries_pending`,
migration `0010`); the imported archive is never listed. `ListMailItems` pages them newest first with each
subject, one-sentence brief and receive time, and the categories with their etag. `ReadMailSummary` reads one full
summary, plain text Tasks never interprets. `ConvertMailItem` turns one mail into an Inbox task in Tasks: its
linked task when that is still open, else a new task from the subject and summary, whose ID derives from the event
ID so that a repeat never creates a second one. A chosen category adds its tag and priority; the mail is then
marked triaged. `DeleteMailSummaries` deletes up to 200 pending
summaries; `mail_events`, the ledger of IDs and states, keeps its rows, and a mail no longer pending is kept.
`ReadMailSettings` and `UpdateMailCategories` read and replace the categories: at most four pairs of an existing
tag and a priority, by etag; a removed category is archived, never deleted, so its ID is never reused. Only the
owner deletes a summary; no retention does. Receipts and logs carry IDs, counts and codes, never a subject, brief
or summary.

## Weekly rollover and controls

Rollover runs once the plan is confirmed and the native planning state is initialized. The coordinator's alarm
ticks it at most once every ten minutes; each tick observes one page of active tasks and records the commitments
of the account week. After Monday 00:00 in the account timezone it resets up to five recorded old-week tasks per
tick: a task still committed becomes a weekly candidate (one planning-state write at its revision, under a
receipt), and a task no longer committed, or deleted, is forgotten. Then the week in effect advances. Task
content, dates and ordinary tags never change.

A commitment chosen on the week's last day is a choice for the next week: SetTaskPlan with `stage = committed`
on Sunday records the task under the next Monday, so the coming reset leaves it in place, and no later scan or
write moves that record back to an older week. Next week's Bets are written in Sunday's weekly review.

`MAINTENANCE_MODE` refuses every planning write in the gateway and the core, and stops the alarm and with it the
rollover; reads go on. The backup lease holds planning writes and the rollover for the length of a backup job.
Each planning call and the rollover share the coordinator's `plus_lock` with the backup start.

## VerifyPlanStore

`VerifyPlanStore` answers counts, never content: rows per planning table, to compare with a backup manifest, and
the rows that break a rule (state, marks or edges whose task identity is missing; setting keys, providers, kinds or
schemes this build does not know; limits exceeded). An absent count is zero. After a restore every `*_row_count`
equals its table's rows in the manifest and no other count is present. It is a read, so maintenance lets it
through; the restore runbook ([cloudflare-setup.md](cloudflare-setup.md)) opens it at
`https://tasks.ziyixi.science/api/plus/v1/plan:verifyPlanStore`.
