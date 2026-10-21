# Mail API: Todofy's Mail entry

`MailService` (`proto/todofy/mail/v1/mail_service.proto`, package `todofy.mail.v1`) is the mail Todofy summarised
and keeps, for the Workers that bind it: Tasks (its Mail page, mail conversion and weekly review) and the Personal
MCP. Todofy creates, reads and changes no task here. Tasks turns a mail into a task itself and then marks the mail
converted; it owns the Mail categories a conversion files with. Todofy keeps the summaries, the ledger and the Gemini
work. Until 2026-10-21 the same mail was served as `PlusService` (`/api/plus/v1/*`, named after the retired Todoist
Plus extension, [history](../../docs/history/todoist-plus.md)), with Todofy writing the converted task itself.

## Binding and access

The gateway exports the entrypoint `Mail` (`gateway/src/mail.ts`). No public host routes `/api/mail/v1/*`: the owner
host and the hooks hosts answer 404. A Worker in this account binds it with the access it needs, the generic model of
Tasks' `TasksApi`:

```toml
[[services]]
binding = "MAIL"
service = "todofy"
entrypoint = "Mail"
props = { access = "read-write" }   # or "read": the GET methods only
```

Any other binding, or a write on a `read` binding, is `PERMISSION_DENIED` (`FORBIDDEN`) before its body is read.
Requests and answers are the wire JSON profile through the shared transcoder; each request is one core RPC,
`mail(method, request)` (`worker/todofy/runtime/mail.py`), whose answer the gateway sends as the core wrote it.

## Methods

| rpc | HTTP | What it does |
| --- | --- | --- |
| `ListMailItems` | `GET /api/mail/v1/mailItems` | Pending mail, newest first, 25 by default and at most 50, by an opaque keyset `page_token`: ID, subject, one-sentence brief, receive time, etag and the task an older release linked. No summary. |
| `GetMailItem` | `GET /api/mail/v1/mailItems/{id}` | One mail, pending or not, with its full summary (at most 64 KiB; plain text a reader never interprets) and `pending`. |
| `MarkMailConverted` | `POST /api/mail/v1/mailItems/{id}:markConverted` | `{etag, task_id}`: records the task Tasks made from a pending mail. |
| `DeleteMailSummaries` | `POST /api/mail/v1/mailItems:deleteSummaries` | `{event_ids}` (1 to 200): deletes pending summaries; a mail no longer pending is kept. |
| `GetMailInbox` | `GET /api/mail/v1/mailInbox` | The pending count, and of it the mail that arrived 1 to 14 days ago (the morning brief's carryover). |
| `PollMailReady` | `GET /api/mail/v1/mailItems:pollReady` | At most 50 ledger transitions after a cursor and the pending mail among them, IDs and times only. |

A mail is a completed Mail Hero event's `summaries` row; it is pending while it awaits a decision (`imported = 0 AND
triaged_at IS NULL`, the index `summaries_pending` of migration `0010`): neither converted, deleted, nor decided on the
event page. The imported archive is never pending.

## Writes without receipts

Both writes are compare-and-sets in D1 alone and carry no request ID:

- `MarkMailConverted` checks the etag the task was made from (the mail's identity and its task link), then sets
  `summaries.task_id` and `triaged_at` where the mail is still pending and still links what it linked. The mail
  category the task took stays in Tasks; `summaries.category_id` keeps only what the retired Plan once wrote.
  The same task again answers the mail as it is, so a lost answer is repeated safely; another task is `NOT_PENDING`. A
  mail changed since its etag is `ETAG_MISMATCH`.
- `DeleteMailSummaries` deletes the pending rows among the IDs and answers the rest as kept; an ID already gone counts
  as deleted, so a repeat answers the same. `mail_events`, the ledger of IDs and states, keeps its rows, so a deleted
  mail is never summarised again. Only the owner deletes a summary; no retention does.

Tasks makes a mail's task with an ID derived from the event ID, so any retry of a conversion, with any request ID,
finishes it without a second task ([tasks/docs/design.md](../../tasks/docs/design.md)).

## Errors and controls

Besides the common reasons, `todofy.mail.v1.ErrorReason`: `ETAG_MISMATCH` (409), `NOT_PENDING` (400),
`MAINTENANCE` (503, `Retry-After: 300`) and `CURSOR_RESET_REQUIRED` (400: a restored database is behind the reader's
cursor; it starts again with `baseline=true`). `MAINTENANCE_MODE` refuses both writes in the gateway and the core;
reads go on. While the weekly backup holds the ledger, the writes answer `UNAVAILABLE` with `Retry-After: 30`. Logs
carry IDs, counts and codes, never a subject, brief or summary.

## The categories Todofy kept

The Mail categories were `plan_categories` rows of scheme `mail`, with their Tasks label IDs in the `plan_settings`
document `todoist.mail`, the last of the planning store (migration `0007`). Tasks owns the categories now: its
one-time Todofy import copied these rows ([tasks/docs/backup.md](../../tasks/docs/backup.md#one-time-todofy-import)),
and migration `0015_drop_copied_stores.sql` dropped them, as `0013_drop_plan_store.sql` dropped the rest after Tasks'
planning import of 2026-10-20. `summaries.category_id` keeps the category ID Tasks reports. The receipts of PlusService's writes
(`plus_receipts`) and the planning writes' journal (`native_task_requests`) are dropped from TodofyCore's own SQLite.
