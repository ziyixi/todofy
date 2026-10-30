# Todofy architecture

Two Cloudflare Workers on the Workers Free plan: a thin TypeScript gateway (`todofy`) and a Python
Worker (`todofy-core`) that hosts one SQLite-backed Durable Object, plus one D1 database and a private R2
bucket for its weekly backups. Mail Hero delivers each received mail as a `mail.received.v1` webhook; Todofy
summarizes it through Model Router and keeps the summary for Tasks' Mail page, where the owner turns it into a task, and
serves a daily summary and recommendation to the newsletter. It writes and reads no task and binds no other app:
Tasks reads the mail and marks it converted through the gateway's private `Mail` entrypoint. The owner UI is a
React app served by the gateway behind Cloudflare Access. The gateway only checks credentials and routes (a plain
Worker request has 10 ms of CPU); everything that touches D1 or model invocation runs in the Durable Object (30 s per call).

```mermaid
flowchart LR
    MH["Mail Hero<br/>(mail.received.v1, Bearer)"]
    NL["newsletter<br/>(Basic, 45 s, no retries)"]
    Owner["Owner browser"]

    subgraph CF["Cloudflare (Workers Free)"]
        Access["Cloudflare Access<br/>(UI host only)"]
        subgraph W["Worker todofy (TypeScript gateway)"]
            Hooks["hooks hosts<br/>POST /hooks/mail (Bearer)<br/>GET /api/summary, /api/recommendation (Basic)<br/>GET /health (no DO call)"]
            OwnerAPI["UI host<br/>React assets + /api/v1/*<br/>(Access JWT, CSRF)"]
            Cron["cron */10 min"]
            Mail["Mail entrypoint<br/>(todofy.mail.v1, private bindings)"]
        end
        subgraph C["Worker todofy-core (Python, no public routes)"]
            DO["Durable Object TodofyCore (inbox-v1)<br/>single ledger writer, alarm loop, owner API,<br/>reports, weekly backup; budgets and schedule in DO SQLite"]
        end
        D1[("D1 todofy<br/>mail_events, event_transitions,<br/>summaries, daily_reports,<br/>owner_actions, legacy_mail_text")]
        R2[("R2 todofy-backups")]
        Tasks["Worker tasks<br/>(MAIL binding)"]
        MCP["Worker personal-mcp<br/>(TODOFY_MAIL, read only)"]
    end

    Router["Model Router<br/>provider-neutral inference"]

    MH -->|webhook| Hooks
    NL --> Hooks
    Owner --> Access --> OwnerAPI
    Hooks -->|ingest, reports,<br/>failed Basic count| DO
    OwnerAPI -->|/api/v1/* with the owner| DO
    Cron -->|wake| DO
    Tasks -->|list, read, mark converted, delete| Mail --> DO
    MCP -->|list, read| Mail
    DO --> D1
    DO -->|weekly backup| R2
    DO -->|summary, reports| Router
```

Event lifecycle (one ledger step per alarm; every step is a compare-and-set on `(state, version)`). A
summary completes the event. The states of the old per-mail task path (`summarized`, `todo_sending`,
`todo_unknown`, `todo_created`) stay in the schema for stored rows; migration `0014_retire_task_writes.sql`
required none to be live when Todofy stopped writing tasks (2026-10-21):

```mermaid
stateDiagram-v2
    [*] --> pending: webhook stored (204)
    pending --> summarizing
    pending --> failed_summary: needs review / unreadable payload
    summarizing --> complete: model succeeded (summary kept for Mail)
    summarizing --> pending: retry with backoff
    summarizing --> failed_summary: gave up (errors or 3 interruptions)
    failed_summary --> pending: owner retry_summary
    failed_summary --> ignored: owner dismiss
    complete --> [*]
    ignored --> [*]
```
