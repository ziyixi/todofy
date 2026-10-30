# Todofy

Todofy receives Mail Hero events, summarizes mail through Model Router, and supplies Tasks' Mail page, daily reports
and recommendations. It keeps the mail ledger and summaries; Tasks alone converts a mail into a task.

```sh
bazel test //todofy:check
bazel build //todofy
```

The TypeScript gateway owns host routing, Access/CSRF, machine credentials, static UI and cron. The private Python
Worker hosts `TodofyCore`, the single D1 writer and scheduler. Weekly backups go to its private R2 bucket. See the
[architecture diagram](architecture-diagram.md) and [gateway contract](docs/gateway-contract.md).

## Use

- Owner UI: the configured `TODOFY_PUBLIC_HOST`, protected by Access.
- Mail Hero: `POST /hooks/mail` on a configured hooks host, with its existing Bearer credential.
- Newsletter: summary/recommendation endpoints on the hooks host, with Basic authentication.
- Tasks and Personal MCP: the private [Mail entrypoint](docs/mail-api.md), with their declared read/write access.

The owner selects mail and report models separately in settings. Changes apply to future calls; completed mail stays
frozen. Provider keys belong only to Model Router. The existing daily token budget keeps its physical legacy name,
`GEMINI_DAILY_TOKEN_BUDGET`; changing models does not reset usage.

Mail progresses from pending to summarizing to complete. Failed summaries expose retry/dismiss actions in the owner
UI. Completed summaries remain until the owner deletes them; the event ledger remains for deduplication. Task
conversion, categories, Plan, Focus and GTD belong to Tasks.

## Operations

`TODOFY_PROCESSING_PAUSED` accepts mail while deferring summaries. `TODOFY_MAINTENANCE_MODE` refuses ingestion and owner
writes and stops ledger work. Both are explicit production variables applied through the existing deploy wrapper.
Do not bypass it with a bare Wrangler deploy.

A weekly backup copies D1 and keeps six completed snapshots. Restore into a new empty database, verify it, then change
bindings under maintenance. See [setup and recovery](docs/cloudflare-setup.md). Tasks has its own backups.

CI selects actual dependencies and publishes the tested core/gateway/UI archive. The core deploys before the gateway;
Tasks deploys afterwards. Require matching main publication and Personal cloud reconcile. See
[CI/CD](docs/ci-cd.md), [developer notes](docs/dev-notes.md) and [verification](docs/verification.md).

`worker/todofy/core/` contains pure rules; `worker/todofy/runtime/` contains the DO, SQL, scheduling and model bridge.
`gateway/` and `web/` own transport and UI; `migrations/`, `tools/`, `deploy/` and `docs/` hold schema, operations and
runbooks. The retired Go/Todoist-write implementations remain in Git history, not as alternate runtime paths.
