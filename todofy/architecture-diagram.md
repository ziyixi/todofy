# Todofy architecture

Two Cloudflare Workers on the Workers Free plan: a thin TypeScript gateway (`todofy`) and a Python
Worker (`todofy-core`) that hosts one SQLite-backed Durable Object, plus one D1 database. Mail Hero
delivers each received mail as a `mail.received.v1` webhook; Todofy summarizes it with Gemini and keeps
the summary for Tasks' Mail page, where the owner turns it into a task, and serves a daily summary and
recommendation to the newsletter. It writes its own tasks (reminders, weekly reviews, task intents) to Tasks
through the read-write `TASKS` binding and keeps Tasks' planning facts. The owner UI is a React app served by
the gateway behind Cloudflare Access. The gateway only checks credentials and routes (a plain Worker request
has 10 ms of CPU); everything that touches D1, Gemini or Tasks runs in the Durable Object (30 s per call).

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
            Planning["Planning entrypoint<br/>(Tasks' private binding)"]
        end
        subgraph C["Worker todofy-core (Python, no public routes)"]
            DO["Durable Object TodofyCore (inbox-v1)<br/>single ledger writer, alarm loop, owner API,<br/>reports; budgets and schedule in DO SQLite"]
        end
        D1[("D1 todofy<br/>mail_events, event_transitions,<br/>summaries, daily_reports,<br/>mail_reminders, owner_actions,<br/>legacy_mail_text")]
        Tasks["Worker tasks<br/>(TasksApi, read-write binding)"]
    end

    Gemini["Gemini API"]

    MH -->|webhook| Hooks
    NL --> Hooks
    Owner --> Access --> OwnerAPI
    Hooks -->|ingest, reports,<br/>failed Basic count| DO
    OwnerAPI -->|/api/v1/* with the owner| DO
    Cron -->|wake| DO
    Tasks -->|Plan, Focus and Mail calls| Planning --> DO
    DO --> D1
    DO -->|summary, reports| Gemini
    DO -->|daily reminder, review, intents,<br/>GTD snapshot, planning, Mail conversion| Tasks
```

Event lifecycle (one ledger step per alarm; every step is a compare-and-set on `(state, version)`). A
summary completes the event; the `summarized` → `todo_*` path only finishes task requests frozen before the
2026-10-17 cutover to Tasks:

```mermaid
stateDiagram-v2
    [*] --> pending: webhook stored (204)
    pending --> summarizing
    pending --> failed_summary: needs review / unreadable payload
    summarizing --> complete: Gemini ok (summary kept for Mail)
    summarizing --> pending: retry with backoff
    summarizing --> failed_summary: gave up (errors or 3 interruptions)
    summarized --> todo_sending
    todo_sending --> complete: task created
    todo_sending --> summarized: retry later (never after a possible create)
    todo_sending --> todo_unknown: result unknown
    todo_unknown --> todo_created: footer lookup finds 1 task
    todo_created --> complete
    todo_unknown --> summarized: owner task_not_created, then lookup finds none
    todo_unknown --> todo_created: owner task_created
    failed_summary --> pending: owner retry_summary
    todo_unknown --> ignored: owner dismiss
    failed_summary --> ignored: owner dismiss
    summarized --> ignored: owner dismiss (todoist_rejected only)
    complete --> [*]
    ignored --> [*]
```
