# Personal MCP

Private tools, ongoing Work memory and event subscriptions for ChatGPT Dots. One Worker and one SQLite Durable
Object; Cloudflare Access handles OAuth. Business data stays in its existing application.

## Tools

| Area | Tools | Behavior |
| --- | --- | --- |
| Work | `work_context`, `work_list`, `work_get`, `work_create`, `work_checkpoint`, `work_report`, `work_export` | Persistent continuation facts and source refs; checkpoints are silent, reports can notify |
| Watch | `watch_preview`, `watch_create`, `watch_update`, `watch_control`, `watch_list`, `watch_get`, `watch_changes`, `watch_read`, `watch_view` | Native Watch settings, stored page evidence and actual screenshot images; dedicated Work Watches default to `NONE` |
| Tasks | `tasks_list`, `tasks_get`, `tasks_create_inbox`, `tasks_add_steps`, `tasks_update`, `tasks_complete`, `tasks_delete` | Native Tasks fields, receipts and etags; deletion is soft |
| Plan / Focus | `plan_get`, `plan_arrange`, `focus_get` | Native planning facts and daily queues; arranging preserves task dates and deadlines; timer is read-only |
| Mail | `mail_list`, `mail_read`, `mail_collect` | Mail stays in Mail until explicitly collected into Inbox |
| Recall | `recall_search`, `recall_read`, `recall_activity`, `recall_view` | Bounded search, activity and text reads; view returns an actual MCP image when available |
| Home | `cloud_status` | Cached service states, source freshness and current undismissed issues; no refresh or controls |
| Connection | `connection_status`, `send_test_event` | Build, source checks and delivery state; explicit synthetic connection test |

Business tools require owner instructions or an explicitly authorized responsibility. Bets are weekly goals;
Committed is a limited commitment. Steps should usually fit within two hours. Dates, commitments, completion
and deletion remain owner decisions. Retry an uncertain write with the same request ID and identical input.

## Work and follow-up

Work records keep an authorized responsibility resumable across chats, waits and callbacks: goal, scope, completion
condition, continuation summary, next action, waiting facts and refs to the real Tasks, Codex chats, Watches, Recall
records, native schedules and artifacts. A checkpoint is silent; a report can notify. Captured Watch evidence changes
reach linked Works as reports, and the Dot judges their relevance. The Dot-facing rules are the
[skill](plugin/skills/personal-cloud/SKILL.md) and the tool descriptions; [Work memory](docs/work-memory.md) lists what
the server guarantees.

## Events

`events/list`, `events/subscribe` and `events/unsubscribe` expose the existing four business events,
`work.attention` and `personal_cloud.test`. Subscriptions start from current state; existing tasks, mail and Home
issues are not replayed. Read Work context for reports already pending when a subscription begins.

| Event | Payload | Source |
| --- | --- | --- |
| `task.changed` | Bounded task IDs, etags and deleted flags | Tasks change feed; confirmed MCP writes of the same revision are omitted |
| `task.must_start` | Task IDs newly entering the window | Tasks' native Must start calculation, including date-only changes |
| `mail.ready` | Mail event ID and ready time | Successfully summarized, pending Mail; excludes canaries and imports |
| `service.attention` | Home occurrence sequence, source and code | Current undismissed issue episodes; excludes this MCP's own failures |
| `work.attention` | Work ID, report sequence, kind, source and timestamp | Explicit reports from linked sources, including Watch evidence changes; checkpoint writes stay silent |

`work.attention` accepts `{work_id}` to select one Work; omitting it subscribes to all open Works. Watch evidence
changes become linked Work reports, so there is no separate public `watch.changed` subscription. Read `work_get` and the
relevant source before acting, then silently checkpoint the handled report sequence.

The existing DO Alarm checks subscribed sources at most once per minute. Cursor/state progress and frozen delivery
bodies commit together. It sends at most five deliveries per Alarm and uses the existing bounded retry schedule.
No active business subscriptions means no source polling. `accepted` means the callback accepted the event;
it does not mean a Dot finished its work. The assistant reads current facts through tools when needed.

## Runtime and source boundaries

Private generated service bindings connect `TasksApi`, Todofy's read-only `Mail` entry, `RecallApi`, `HomeApi` and
`WatchApi`.
`mail_collect` and the category shortcuts are Tasks' (`ConvertMailItem`, `GetMailCategories`); Todofy keeps the mail.
The DO retains subscriptions, cursor/state, delivery metadata, Step request identities, confirmed task revisions
and Work records/logs. Work records keep bounded continuation facts and references; task bodies, mail and browsing
documents remain in their source applications. Callback paths and signing secrets never appear in status or logs.
Home reads this Worker's standard private Ops binding.

The protocol uses the official MCP SDK's native `createMcpHandler` and Standard Webhooks signatures. It requires
MCP 2.0 (`2026-07-28`). There is no Agents framework, server-side model call, D1, Queue or Workflow.

## Backup and restore

The DO backs its whole store up daily (05:23 UTC) into the private bucket `personal-mcp-backups`, keeping the newest
30. The owner's `POST /owner/restore` loads a backup into a new, empty store from inside the object and verifies it;
`tools/backup-restore.ts` downloads, verifies and uploads copies. See [backup and restore](docs/backup.md).

## Development and release

From the repository root, use Node 26:

```sh
pnpm install --frozen-lockfile
cd personal-mcp/worker
npm run lint
npm run typecheck
npm test
npm run test:runtime
```

Runtime tests use real workerd/SQLite and local signed callback receivers. The existing business tests cover
discovery, baseline cursors, restart persistence, deduplication, unsubscribe and observable callback failure. See
the verification record for checks actually completed for the expanded catalog; deployment, image viewing and
actual Dots continuation need separate evidence.

The endpoint is `https://mcp.ziyixi.science/mcp`. Reuse the existing private Personal Cloud plugin and owner OAuth
connection. After deploying an expanded catalog, use its **Refresh tools** control. Local plugin instructions live
in `plugin/`; account updates preserve the existing App identity and sharing.

Pass the complete branch CI, then publish the same SHA through main Actions. Deploy private source entrypoints
before the MCP release binds them. See
[connection and setup](docs/connection.md) and the separate [live verification](docs/verification.md).
