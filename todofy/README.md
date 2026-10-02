# Todofy

Todofy turns the owner's mail into Todoist tasks. [Mail Hero](../mail-hero/) (in the same monorepo,
an independent app) receives the mail and POSTs a `mail.received.v1` webhook; Todofy stores it, asks Gemini for a short
summary, and creates exactly one Todoist task per event. It also serves a daily summary and ranked
recommendations to the owner's newsletter, sends at most one attention reminder task a day, and has a
small owner UI for anything that needs a human.

It runs entirely on Cloudflare's Workers Free plan: a thin TypeScript gateway Worker (`todofy`: hosts,
credentials, static assets, cron), a Python Worker (`todofy-core`) hosting one SQLite-backed Durable
Object (`TodofyCore`, instance `inbox-v1`) as the single ledger writer and scheduler, one D1
database, and a private R2 bucket (`todofy-backups`) for weekly D1 backups. All D1, Gemini and Todoist
work runs in the Durable Object, which gets 30 s of CPU per call;
a plain Worker request gets 10 ms on the Free plan, too little for Python. The UI is React/TypeScript,
built into static assets the gateway serves.
[architecture-diagram.md](architecture-diagram.md) has the diagrams.

```
                      Worker todofy (TypeScript gateway)       Worker todofy-core (Python)
Mail Hero --Bearer--> hooks host POST /hooks/mail      --+
newsletter --Basic--> hooks host GET /api/summary, ... --+--> Durable Object inbox-v1 --> D1
owner --Access------> UI host: JWT, CSRF, assets,       |     |--> Gemini (summary, reports)
                      /api/v1/* with the owner  --------+     |--> Todoist (task, lookup, reminder)
                                                              '--> R2 todofy-backups (weekly D1 backups)
cron */10 ----------> scheduled() -------------------------> wake() (RPC)
```

## Hosts

| Host | Serves | Auth |
|---|---|---|
| `TODOFY_PUBLIC_HOST` (`todofy.ziyixi.science`) | owner UI and its API todofy.ui.v1 under `/api/v1/*` ([`proto/todofy/ui/v1`](../proto/todofy/ui/v1), served by the shared transcoder) | Cloudflare Access app on the whole host, and the gateway verifies the Access JWT itself (RS256 signature, issuer, audience, expiry, not-before, subject, owner or alias); writes also need Origin, the CSRF token and a `request_id` |
| each of `TODOFY_HOOKS_HOSTS` (`todofy-hooks.ziyixi.science`; `daily.ziyixi.science` is added at cutover so Mail Hero's and the newsletter's existing URLs keep working) | exactly `POST /hooks/mail`, `GET /api/summary`, `GET /api/recommendation`, `GET /health` | webhook: Bearer (SHA-256 digest compared in constant time); newsletter: Basic; `/health` returns the build SHA with `service`/`status` (the gateway answers it without the Durable Object) |

Any other host or path is a 404. `workers.dev` and preview URLs are off.

## Event states

| State | Meaning |
|---|---|
| `pending` | stored, waiting for a summary (also after a retryable Gemini failure) |
| `summarizing` | Gemini call in flight |
| `summarized` | summary and task request frozen, waiting to create the task (also after a retryable Todoist failure) |
| `todo_sending` | Todoist create in flight |
| `todo_unknown` | the create may or may not have happened; never resent automatically, a read-only footer lookup runs instead |
| `todo_created` | the task exists (found by the lookup or confirmed by the owner); completes on the next step |
| `complete` | done; the mail body is dropped, the summary row feeds the reports |
| `ignored` | dismissed by the owner; the ledger row stays as the dedupe record |
| `failed_summary` | automatic summary attempts stopped (or Mail Hero flagged the mail for review) |

`failed_summary` and `todo_unknown` need the owner at once; any other active row counts as "attention"
once it is older than 6 hours. The UI explains every error code (`web/src/lib/labels.ts`).

## Owner reconcile runbook

Open the event in the UI (Attention page). The buttons shown are exactly the actions the Worker allows:

| Row | Action | Effect |
|---|---|---|
| `todo_unknown` | **task_created** (paste the Todoist task ID) | the event completes with that task |
| `todo_unknown` | **task_not_created** (type the short event ID) | a footer lookup runs first; if it finds nothing, the frozen request is sent again, which can duplicate a task |
| `failed_summary` (not `mail_needs_review`) | **retry_summary** | Gemini is called again (counts against the day's token budget) |
| `todo_unknown`, `failed_summary`, or `summarized` with `todoist_rejected` | **dismiss** | the event becomes `ignored`; Todoist is not checked |

Every action is a compare-and-set on the version you saw; if the event moved on you get a conflict and a
refresh button. Resending the same request replays the stored outcome.

## Switches

Set as GitHub variables on the `production` environment and applied by a deploy (see
[docs/ci-cd.md](docs/ci-cd.md)); every deploy states each one.

| Variable | `true` means |
|---|---|
| `TODOFY_MAINTENANCE_MODE` | webhook gets 503 with `Retry-After` (Mail Hero retries), owner writes are refused, the alarm loop stops |
| `TODOFY_PROCESSING_PAUSED` | mail is accepted and stored but no summary, task or daily reminder is made; report precompute and the newsletter endpoints keep working |
| `TODOFY_FORCE_PAUSE_TODOIST` | summaries continue; rows wait in `summarized`; no reminder |
| `TODOFY_REMINDER_ENABLED` | the daily attention reminder task is on |
| `TODOFY_GTD_REVIEW_ENABLED` | the Sunday review task is on (one Todoist task per ISO week, [docs/gtd-features.md](docs/gtd-features.md)) |

Optional environment secrets `TODOFY_TODOIST_OPS_PROJECT_ID` and `TODOFY_TODOIST_REVIEW_PROJECT_ID` send the
`[Todofy System]` reminder and the Sunday review to their own Todoist projects; unset, both go to the
default project. Like `TODOFY_TODOIST_DEFAULT_PROJECT_ID`, they reach `todofy-core` as Worker secrets
(`--secrets-file`), never as plain vars.

## GTD ledger and the morning brief

Once a day (13:00 UTC) the Durable Object reads Todoist's active tasks and the last 7 days of completions,
read-only, and keeps metadata and counts only, never a task title or description: open, age buckets,
overdue, undated, created and completed, per inbox and for all projects. The 13:30 recommendation then
also sees mail tasks of the last 14 days that are still open (up to 30, marked `[N 天前]`); without a
usable snapshot it is exactly the 24 h report. Every Sunday from 17:00 UTC one review task per ISO week
carries the week's counts, trends and links. The owner UI's GTD page shows the trends; ops-v1 status
carries the counters and the dashboard shows them as the "GTD 循环" flow
([docs/gtd-features.md](docs/gtd-features.md)).

## Backups

Every Sunday at 10:00 UTC (and once right after the first deploy) the Durable Object copies every D1
table into its own prefix in the private bucket `todofy-backups` (`backups/<job start>/`) and keeps the
newest 6 complete backups; the UI's health page shows the last one. While a backup runs (a few minutes)
processing and owner writes wait; webhooks are still accepted. `tools/backup_restore.py` restores one into
a new, empty D1 database ([docs/cloudflare-setup.md](docs/cloudflare-setup.md) §7). The bucket holds mail
content: keep it private.

## Metrics

The budget page shows the last 30 finished UTC days (mail received, completed and failed, arrival-to-
completion time, Gemini tokens by model, Gemini and Todoist calls) from the D1 table `daily_metrics`,
which the Durable Object writes a few minutes after each UTC midnight. Both Workers also write one
Workers Analytics Engine point per request or upstream step to the dataset `todofy_metrics`, for ad-hoc
SQL queries from the owner's machine ([docs/dev-notes.md](docs/dev-notes.md) §6). Metrics are best
effort: a failed write never fails the request or step it describes. After a database restore the
trends restart counting; the days in between show as not recorded.

## Ops surface and canaries

The gateway exports a named entrypoint `Ops` ([contracts/ops-v1](../contracts/ops-v1/README.md)) for a
future dashboard Worker in the same account: `status()` (health, switches, signals and counters; codes and
numbers only), `setGuard()` (a `shed` guard defers only the weekly backup, retention and the metrics
rollup, each within a bound), `canaryResult()` and `reportOps()`, whose warning and critical items join
the next daily reminder (still one task per UTC day). A `mail.received.v1` event with `canary` is
summarised by Gemini like mail and then ends: it never creates a Todoist task and never appears in
reports, lists, counts or the reminder; its event page is marked 金丝雀.

The same entrypoint takes task intents ([contracts/task-intent-v1](../contracts/task-intent-v1/README.md)):
another app in the account (Lab, for "send today's liked papers to Todoist") proposes a parent task with
subtasks, or separate tasks, under its own idempotency key. Todofy records it once in D1, creates the
tasks in its alarm with the same Todoist client, gate and frozen request IDs as mail, looks a task up by
its footer instead of resending it after an unknown result, and answers with codes and counts only. A
repeated proposal never creates a task twice; pauses, the Todoist auth block and backups hold intents
like mail. No Gemini call, no public route.

## Local development

Prerequisites: Node 26 (`.nvmrc`), uv 0.12.10; Python 3.14 is fetched by uv. No Cloudflare account or
credentials are needed. Run every command from this `todofy/` directory of the monorepo; the only file read
from outside it is the shared `mail.received.v1` contract in `../contracts/mail-received-v1`.

```sh
npm ci --no-audit --no-fund
uv sync --locked
uv run ruff check worker tests tools deploy && uv run ruff format --check worker tests tools deploy
uv run pytest tests/unit tests/fakes tools deploy        # host tests
(cd gateway && npm ci --no-audit --no-fund && npm run lint && npm run typecheck && npm test)
(cd gateway && npm run test:runtime)                     # the gateway in workerd: owner API CPU per request
(cd web && npm ci --no-audit --no-fund && npm run typecheck && npm test && npm run build)
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
worker/todofy/core/     pure Python rules (vocabulary, contract, prompts, classification, SQL)
worker/todofy/runtime/  todofy-core: Durable Object, D1 ledger, Gemini/Todoist clients, owner API
gateway/                the gateway Worker todofy (TypeScript): routing, Access, CSRF, webhook, assets,
                        the owner API's transcoder (todofy.ui.v1 from ../proto/todofy/ui/v1)
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
