# Personal MCP

Private tools and event subscriptions for ChatGPT Dots. One Worker and one SQLite Durable Object;
Cloudflare Access handles OAuth. Business data stays in its existing application.

## Tools

| Area | Tools | Behavior |
| --- | --- | --- |
| Tasks | `tasks_list`, `tasks_get`, `tasks_create_inbox`, `tasks_add_steps`, `tasks_update`, `tasks_complete`, `tasks_delete` | Native Tasks fields, receipts and etags; deletion is soft |
| Plan / Focus | `plan_get`, `plan_arrange`, `focus_get` | Native planning facts and daily queues; arranging preserves task dates and deadlines; timer is read-only |
| Mail | `mail_list`, `mail_read`, `mail_collect` | Mail stays in Mail until explicitly collected into Inbox |
| Recall | `recall_search`, `recall_read` | Bounded search and text snapshots, including verified Dropbox cold reads; no image bytes |
| Home | `cloud_status` | Cached service states, source freshness and current undismissed issues; no refresh or controls |
| Connection | `connection_status`, `send_test_event` | Build, source checks and delivery state; explicit synthetic connection test |

Business tools require owner instructions or an explicitly authorized responsibility. Bets are weekly goals;
Committed is a limited commitment. Steps should usually fit within two hours. Dates, commitments, completion
and deletion remain owner decisions. Retry an uncertain write with the same request ID and identical input.

## Events

`events/list`, `events/subscribe` and `events/unsubscribe` expose four business events and `personal_cloud.test`.
Subscriptions start from current state; existing tasks, mail and Home issues are not replayed.

| Event | Payload | Source |
| --- | --- | --- |
| `task.changed` | Bounded task IDs, etags and deleted flags | Tasks change feed; confirmed MCP writes of the same revision are omitted |
| `task.must_start` | Task IDs newly entering the window | Tasks' native Must start calculation, including date-only changes |
| `mail.ready` | Mail event ID and ready time | Successfully summarized, pending Mail; excludes canaries and imports |
| `service.attention` | Home occurrence sequence, source and code | Current undismissed issue episodes; excludes this MCP's own failures |

The existing DO Alarm checks only subscribed sources, once per minute. Cursor/state progress and frozen delivery
bodies commit together. It sends at most five deliveries per Alarm and uses the existing bounded retry schedule.
No active business subscriptions means no source polling. `accepted` means the callback accepted the event;
it does not mean a Dot finished its work. The assistant reads current facts through tools when needed.

## Runtime and source boundaries

Private generated service bindings connect `TasksApi`, Todofy's read-only `Mail` entry, `RecallApi` and `HomeApi`.
`mail_collect` and the category shortcuts are Tasks' (`ConvertMailItem`, `GetMailCategories`); Todofy keeps the mail. The DO retains
subscriptions, cursor/state, delivery metadata, Step request identities and confirmed task revisions. It does
not copy task bodies, mail or browsing documents into its database. Callback paths and signing secrets never
appear in status or logs. Home reads this Worker's standard private Ops binding.

The protocol uses the official MCP SDK's native `createMcpHandler` and Standard Webhooks signatures. It requires
MCP 2.0 (`2026-07-28`). There is no Agents framework, server-side model call, D1, Queue or Workflow.

## Development and release

From `worker/`, use Node 26:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run test:runtime
```

Runtime tests use real workerd/SQLite and local signed callback receivers. They cover discovery, baseline cursors,
restart persistence, four event types, deduplication, unsubscribe and observable callback failure.

The endpoint is `https://mcp.ziyixi.science/mcp`. Reuse the existing private Personal Cloud plugin and owner OAuth
connection. After deploying an expanded catalog, use its **Refresh tools** control. Local plugin instructions live
in `plugin/`; account updates preserve the existing App identity and sharing.

Pass the complete branch CI, then publish the same SHA through main Actions. The initial source-bridge release
must precede the four-binding release so HomeApi and the other private entrypoints already exist. See
[connection and setup](docs/connection.md) and the separate [live verification](../docs/personal-mcp-verification.md).
