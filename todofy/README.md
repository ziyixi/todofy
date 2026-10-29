# Todofy

Todofy summarises the owner's mail for [Tasks](../tasks/README.md). [Mail Hero](../mail-hero/) (in the same
monorepo, an independent app) receives the mail and POSTs a `mail.received.v1` webhook; Todofy stores it, calls the shared Model Router
for a short summary, and keeps the summary for the Mail page in Tasks, where the owner turns it into a task or
deletes it. It also serves a daily summary and ranked recommendations to the owner's newsletter and has a small owner
UI for anything that needs a human. It writes no task since 2026-10-21: Tasks makes a mail's task itself, Home sends
the daily reminder, and Tasks keeps GTD.

It runs entirely on Cloudflare's Workers Free plan: a thin TypeScript gateway Worker (`todofy`: hosts,
credentials, static assets, cron), a Python Worker (`todofy-core`) hosting one SQLite-backed Durable
Object (`TodofyCore`, instance `inbox-v1`) as the single ledger writer and scheduler, one D1
database, and a private R2 bucket (`todofy-backups`) for weekly D1 backups. All D1 work and model invocation coordination run in the
Durable Object, which gets 30 s of CPU per call;
a plain Worker request gets 10 ms on the Free plan, too little for Python. The UI is React/TypeScript,
built into static assets the gateway serves.
[architecture-diagram.md](architecture-diagram.md) has the diagrams.

```
                      Worker todofy (TypeScript gateway)       Worker todofy-core (Python)
Mail Hero --Bearer--> hooks host POST /hooks/mail      --+
newsletter --Basic--> hooks host GET /api/summary, ... --+--> Durable Object inbox-v1 --> D1
owner --Access------> UI host: JWT, CSRF, assets,       |     |--> Model Router (summary, reports)
                      /api/v1/* with the owner  --------+     '--> R2 todofy-backups (weekly D1 backups)
Tasks, MCP --RPC----> entrypoint Mail (todofy.mail.v1) -+
cron */10 ----------> scheduled() -------------------------> wake() (RPC)
```

## Hosts

| Host | Serves | Auth |
|---|---|---|
| `TODOFY_PUBLIC_HOST` (`todofy.ziyixi.science`) | owner UI and its API todofy.ui.v1 under `/api/v1/*` ([`proto/todofy/ui/v1`](../proto/todofy/ui/v1), served by the shared transcoder) | Cloudflare Access app on the whole host, and the gateway verifies the Access JWT itself (RS256 signature, issuer, audience, expiry, not-before, subject, owner or alias); writes also need Origin, the CSRF token and a `request_id` |
| each of `TODOFY_HOOKS_HOSTS` (`todofy-hooks.ziyixi.science`; `daily.ziyixi.science` is added at cutover so Mail Hero's and the newsletter's existing URLs keep working) | `POST /hooks/mail`, newsletter reports and `/health` | webhook: Bearer; newsletter: Basic; `/health` returns the build SHA without the Durable Object |

Any other host or path is a 404. `workers.dev` and preview URLs are off. Tasks and the Personal MCP reach the Mail
API only through the private `Mail` entrypoint ([Mail in Tasks](#mail-in-tasks)).

## Model selection

Todofy calls `modelrouter.inference.v1` through the private `MODEL_ROUTER` service binding.
Provider credentials and fallback policy belong to the Router. The core has no provider API key or
configurable HTTP model endpoint.

The owner UI saves separate mail and daily-report choices in D1 `model_settings`, using the Router's
configured catalog. Before an owner choice is saved, mail uses `gemini-3.5-flash-lite` and reports use
`gemini-3.8-flash`. Only these two fall back to each other. The dashboard labels `gpt-6.1-sol` as Codex subscription
and `openai/gpt-6.1-sol` as OpenAI API; choosing either preserves that route on failure without switching to Gemini.
OpenAI, Claude and Gemini are billed per API call against the Router's
workspace limits that every app shares. Changes apply to future model calls; completed mail keeps its frozen
summary and model. Results retain the provider-reported model when available, otherwise the selected model ID.

The physical budget setting remains `GEMINI_DAILY_TOKEN_BUDGET` (3,000,000 tokens/day); this legacy name
also remains in existing metric fields. Model selection does not reset its usage or change business retries.

Since 2026-10 the email summary starts with a one-sentence brief on its own line (one deliberate prompt line,
read back by a pure function, no new call); Tasks' Mail shows it. Mail summarised before that line
gets a model-written brief once, in the background, within half of the day's token budget.

## Event states

| State | Meaning |
|---|---|
| `pending` | stored, waiting for a summary (also after a retryable model failure) |
| `summarizing` | model call in flight |
| `complete` | done; the mail body is dropped, the summary row feeds the reports and the Mail page in Tasks (no time-based deletion) |
| `ignored` | dismissed by the owner; the ledger row stays as the dedupe record |
| `failed_summary` | automatic summary attempts stopped (or Mail Hero flagged the mail for review) |

Mail goes `pending` → `summarizing` → `complete`. `failed_summary` needs the owner at once; any other active row
counts as "attention" once it is older than 6 hours. The UI explains every error code (`web/src/lib/labels.ts`).

The states `summarized`, `todo_sending`, `todo_unknown` and `todo_created` belonged to the task writes that ended on
2026-10-21. Migration `0014_retire_task_writes.sql` stops the deploy while a row is in one of them, so none is left
after it; older events show them only in their transitions, labelled as legacy.

## Owner reconcile runbook

Open the event in the UI (Attention page). The buttons shown are exactly the actions the Worker allows:

| Row | Action | Effect |
|---|---|---|
| `failed_summary` (not `mail_needs_review`) | **retry_summary** | the selected model is called again (counts against the day's token budget) |
| `failed_summary` | **dismiss** | the event becomes `ignored`; the ledger row stays as the dedupe record |

Every action is a compare-and-set on the version you saw; if the event moved on you get a conflict and a
refresh button. Resending the same request replays the stored outcome.

## Switches

Set as GitHub variables on the `production` environment and applied by a deploy (see
[docs/ci-cd.md](docs/ci-cd.md)); every deploy states each one.

| Variable | `true` means |
|---|---|
| `TODOFY_MAINTENANCE_MODE` | webhook gets 503 with `Retry-After` (Mail Hero retries), owner writes are refused, the alarm loop stops |
| `TODOFY_PROCESSING_PAUSED` | mail is accepted and stored but no summary is made; report precompute, the newsletter endpoints and the Mail entry keep working |

The switches `TODOFY_FORCE_PAUSE_TODOIST`, `TODOFY_REMINDER_ENABLED` and `TODOFY_GTD_REVIEW_ENABLED` and the Tasks
project secrets `TODOFY_TODOIST_*_PROJECT_ID` left with the task writes on 2026-10-21; nothing reads them.

## The morning brief's carryover

The 13:30 UTC recommendation also sees the mail that arrived 1 to `REPORT_CARRYOVER_DAYS` (14) days ago and still
awaits a decision in Mail: at most 30, newest first, each marked `[N 天前]` (`core/carryover.py`). With none, or
with `REPORT_CARRYOVER_DAYS = 0`, it is exactly the 24 h report. Until 2026-10-21 the carryover was the open mail
tasks of a daily Tasks snapshot; that snapshot, the Sunday review and the GTD page moved to Tasks, and their design
is at `b9d18aba` (`todofy/docs/gtd-features.md`).

## Mail in Tasks

[Tasks](../tasks/README.md) owns Plan, Focus, GTD and the Mail categories in its own D1. Its Mail page reads and
changes the mail through Todofy's private `Mail` entrypoint (`todofy.mail.v1`); the Personal MCP binds the same
entrypoint read-only. Todofy keeps the mail summaries and the ledger.

Mail lists the summarised mail still awaiting a decision, each with its one-sentence brief. Converting one makes
an Inbox task in Tasks, with its category's tag and priority when one is chosen; Tasks makes the task itself and
then marks the mail converted. Deleting one deletes its summary and keeps the ledger row. Nothing else deletes a
summary.

The [Mail API](docs/mail-api.md) covers the binding and its access, the writes and their retries, and where the
Mail categories Todofy kept went; the retired Todoist Plus extension is in
[its history](../docs/history/todoist-plus.md).

## Backups

Every Sunday at 10:00 UTC (and once right after the first deploy) the Durable Object copies every D1
table into its own prefix in the private bucket `todofy-backups` (`backups/<job start>/`) and keeps the
newest 6 complete backups; the UI's health page shows the last one. While a backup runs (a few minutes)
processing and owner writes wait; webhooks are still accepted. `tools/backup_restore.py` restores one into
a new, empty D1 database ([docs/cloudflare-setup.md](docs/cloudflare-setup.md) §7). Tasks backs itself up into
its own bucket ([tasks/docs/backup.md](../tasks/docs/backup.md)); the older backups here that still hold a copy of
Tasks (`backups/<job start>/tasks/`) rotate out within six weeks. The bucket holds mail content: keep it private.

## Metrics

The budget page shows the last 30 finished UTC days (mail received, completed and failed, arrival-to-
completion time, model tokens by model, model calls and Tasks writes) from the D1 table `daily_metrics`,
which the Durable Object writes a few minutes after each UTC midnight (Tasks writes count only days before
2026-10-21). Both Workers also write one
Workers Analytics Engine point per request or upstream step to the dataset `todofy_metrics`, for ad-hoc
SQL queries from the owner's machine ([docs/dev-notes.md](docs/dev-notes.md) §6). Metrics are best
effort: a failed write never fails the request or step it describes. After a database restore the
trends restart counting; the days in between show as not recorded.

## Ops surface and canaries

The gateway exports a named entrypoint `Ops` ([contracts/ops-v1](../contracts/ops-v1/README.md)) for a
dashboard Worker in the same account: `status()` (health, switches, signals and counters; codes and
numbers only), `setGuard()` (a `shed` guard defers only the weekly backup, retention and the metrics
rollup, each within a bound) and `canaryResult()`. It has no `reportOps()` since 2026-10-21: Home creates the
daily reminder in Tasks itself. A `mail.received.v1` event with `canary` is summarised through the selected mail route and
then ends: it never appears in reports, lists or counts; its event page is marked 金丝雀.

Task intents (task-intent-v1, retired with its contract) left Todofy on 2026-10-21: the watch app creates its tasks
through Tasks' `TaskInbox`. The gateway exports only `Ops` and `Mail`; the refusals it kept for one release in place
of `Intents`, `Planning` and `MailApi` are gone.

## Local development

Prerequisites: Node 26 (root `package.json`), uv 0.12.10; Python 3.14 is fetched by uv. No Cloudflare account or
credentials are needed. From the repository root, install the shared workspaces once, then run the app checks
from `todofy/`.

```sh
pnpm install --frozen-lockfile
uv sync --locked --package todofy
cd todofy
uv run ruff check worker tests tools deploy && uv run ruff format --check worker tests tools deploy
uv run pytest tests/unit tests/fakes tools deploy        # host tests
(cd gateway && npm run lint && npm run typecheck && npm test)
(cd gateway && npm run test:runtime)                     # the gateway in workerd: owner API CPU per request
(cd web && npm run typecheck && npm test && npm run build)
uv run pytest tests/runtime                               # real workerd, gateway + core, D1, DO, alarms, cron (~9 min)
```

`wrangler.toml` (todofy-core) and `gateway/wrangler.toml` (the gateway) are the committed production
configs (top level = production); what is never committed is added at deploy by `deploy/deploy_vars.py`.
`uv run pywrangler dev -c gateway/wrangler.toml -c wrangler.toml --local-upstream todofy.localhost:8787
--port 8787 --var TODOFY_PUBLIC_HOST:todofy.localhost --var TODOFY_HOOKS_HOSTS:todofy-hooks.localhost
--var BUILD_SHA:dev` runs both Workers locally with local bindings only; `--local-upstream` keeps the
production route out of the local request URL (docs/dev-notes.md §1).
[docs/dev-notes.md](docs/dev-notes.md) covers the layout, the Python Workers idioms and the module
contracts.

## Deploy

The monorepo's `.github/workflows/ci.yml` runs Todofy's checks (`Todofy static checks`, the `Todofy runtime`
shards and `Todofy checks`, see [docs/ci-cd.md](docs/ci-cd.md)) for every push that touches
`todofy/`, `contracts/` or `.github/`; a push to `main` that changes `todofy/` (or a manual run on `main` for
`both` or `todofy`) then deploys once `CI gate` passes:
dry-run the committed production configs with the values `deploy/deploy_vars.py` adds, apply D1 migrations, deploy
`todofy-core` and then the gateway, wait for `/health` to report the commit, then check that a wrong
newsletter credential gets 401/429 from the Durable Object (proving gateway → object → D1). There are no pull requests; `main` is fast-forwarded. One-time setup
(D1, R2 bucket, Access, GitHub environment, Worker secrets) is in [docs/cloudflare-setup.md](docs/cloudflare-setup.md).
A Durable Object class change ships in a release of its own; the gateway-only release that deleted the
retired class `TodofyCoordinator` is recorded in [docs/gateway-contract.md](docs/gateway-contract.md) §6.6.

## Repository

```
worker/todofy/core/     pure Python rules (vocabulary, contract, prompts, retry rules, SQL)
worker/todofy/runtime/  todofy-core: Durable Object, D1 ledger, Model Router client, Mail entry, owner API
gateway/                the gateway Worker todofy (TypeScript): routing, Access, CSRF, webhook, assets,
                        the transcoders of the owner API (todofy.ui.v1) and the Mail entry (todofy.mail.v1)
                        (Access, CSRF and private headers from ../packages/edge-auth, compiled in)
migrations/             D1 schema
api/                    the machine routes' OpenAPI document (webhook, newsletter, health), newsletter
                        report schemas (generated from ../proto/todofy/report/v1; the Mail Hero event
                        schema is ../contracts/mail-received-v1, shared with Mail Hero); the owner API
                        is ../proto/todofy/ui/v1
web/                    owner UI (React + Vite), built into uiassets/dist
tests/                  unit, fakes and runtime (workerd) tests
tools/                  legacy SQLite snapshot/export/verify, the webhook smoke test, backup restore
deploy/                 production config generator (both Workers)
docs/                   setup, CI/CD, verification, dev notes, migration plan
```

The retired Go service (gRPC microservices, CloudMailin, DAG dependencies) is in the git history at
`6c46ed4`.
