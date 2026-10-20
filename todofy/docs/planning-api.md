# Planning API: Mail and the weekly review

`PlusService` (`proto/todofy/ui/v1/plus_service.proto`) is Tasks' Mail API and the weekly review's two Todofy facts.
Tasks keeps the tasks and, since `tasks/migrations/0006_planning.sql`, their planning facts, dependencies, the weekly
Bets and the Review lanes' order; Focus's day queues, timer and time records are Tasks' too
(`proto/tasks/ui/v1/focus.proto`). Todofy keeps the mail summaries and the Mail categories. The service keeps the name
of the retired Todoist Plus extension ([history](../../docs/history/todoist-plus.md)), because renaming a published
service is a breaking change; its paths stay `/api/plus/v1/*`. Its planning methods and `CompleteTask` were retired
on 2026-10-20 (`proto/retired.json`), with the gateway's FlowDay proxy.

## Channel and allowlist

Tasks serves `/api/plus/v1/*` on its own origin, behind the owner's Access login, Origin and CSRF. It forwards each
request on its `PLANNING` service binding to the gateway's `Planning` entrypoint (`gateway/src/planning.ts`, props
`{source: "tasks"}`; any other source is 403). No public host routes the prefix: the owner host and the hooks hosts
answer 404.

`nativePlanning` (`gateway/src/plus.ts`) allows the methods Tasks calls: ListMailItems, ReadMailSummary,
ConvertMailItem, DeleteMailSummaries, ReadMailSettings, UpdateMailCategories and ReadWeeklyReview. Any other method
answers `ACTION_NOT_ALLOWED`, and a retired path `NOT_FOUND`, before its body is read. Each call is one core RPC,
`plus_native_ui(method, request)`. It answers `UNAVAILABLE` while the core has no `TASKS` binding, and
`plus_api.handle` runs it under the coordinator's `plus_lock`.

## Weekly review

`ReadWeeklyReview` answers the two facts of Plan's weekly review that Todofy keeps: the newest review task it created
for the account week Tasks names or the week before, and the pending Mail count. It is one D1 batch of two
statements and makes no Tasks call. The weekly review task Todofy creates on Sunday links Plan's checklist
(`/?review=1#/plan` on `TASKS_PUBLIC_URL`).

## Mail

A mail item is a completed Mail Hero event's `summaries` row still awaiting a decision (`summaries_pending`,
migration `0010`); the imported archive is never listed. `ListMailItems` pages them newest first with each
subject, one-sentence brief and receive time, and the categories with their etag. `ReadMailSummary` reads one full
summary, plain text Tasks never interprets. `ConvertMailItem` turns one mail into an Inbox task in Tasks: its
linked task when that is still open, else a new task from the subject and summary, whose ID derives from the event
ID so that a repeat never creates a second one. A chosen category adds its tag and priority; the mail is then
marked triaged, and the answer names the task's ID, title and project. `DeleteMailSummaries` deletes up to 200
pending summaries; `mail_events`, the ledger of IDs and states, keeps its rows, and a mail no longer pending is kept.
`ReadMailSettings` and `UpdateMailCategories` read and replace the categories: at most four pairs of an existing
tag and a priority, by etag; a removed category is archived, never deleted, so its ID is never reused. Only the
owner deletes a summary; no retention does. Receipts and logs carry IDs, counts and codes, never a subject, brief
or summary.

The categories are `plan_categories` rows of scheme `mail`, with their Tasks label IDs in the `plan_settings`
document `todoist.mail` (a frozen key name; `runtime/plan_store.py`). These are the only rows of the planning store
(migration `0007`) that still change. Its other tables (`plan_tasks`, `plan_task_state`, `plan_edges`, `plan_notes`,
`plan_marks`, the other `plan_settings` documents, `plus_settings`, `plus_weeks`) hold what Tasks' one-time import
reads ([tasks/docs/backup.md](../../tasks/docs/backup.md#one-time-planning-import)); nothing writes them, the weekly
backup still carries them, and a later Todofy migration drops them once the import is verified.

## Receipts

`ConvertMailItem` records a receipt in TodofyCore's own SQLite (`plus_receipts`, `runtime/plus_receipts.py`) before
it sends anything: `started` with the frozen Tasks request, then `done` with IDs only, never a title. The request's
ID derives from the receipt's (`core/mailbox.command_id`), and Tasks keeps its first answer under that ID, so a
started receipt resends the same request and an uncertain answer is replayed by Tasks, never written twice.
`DeleteMailSummaries` keeps the indexes of the summaries it kept. A repeated request ID must carry the same input,
else `BAD_REQUEST`. A done receipt answers from its IDs. Lookups read the last 30 days, and nothing deletes a
receipt. `UpdateMailCategories` is a value write without a receipt: sending the saved categories again answers them
as saved. The receipts of the retired planning writes and their operation journal (`native_task_requests`) stay in
the object, unread. Migration `0012` dropped the older D1 `plus_actions` receipts.

## Controls

`MAINTENANCE_MODE` refuses every Mail write in the gateway and the core; reads go on, `ReadWeeklyReview` included.
The backup lease holds Mail writes for the length of a backup job, and each call shares the coordinator's
`plus_lock` with the backup start.
