# Todofy

Todofy turns the owner's mail into Todoist tasks. [Mail Hero](https://github.com/ziyixi/mail-hero)
receives the mail and POSTs a `mail.received.v1` webhook; Todofy stores it, asks Gemini for a short
summary, and creates exactly one Todoist task per event. It also serves a daily summary and ranked
recommendations to the owner's newsletter, sends at most one attention reminder task a day, and has a
small owner UI for anything that needs a human.

It runs entirely on Cloudflare's Workers Free plan: a thin TypeScript gateway Worker (`todofy`: hosts,
credentials, static assets, cron), a Python Worker (`todofy-core`) hosting one SQLite-backed Durable
Object (`TodofyCoordinator`, instance `inbox-v1`) as the single ledger writer and scheduler, and one D1
database. All D1, Gemini and Todoist work runs in the Durable Object, which gets 30 s of CPU per call;
a plain Worker request gets 10 ms on the Free plan, too little for Python. The UI is React/TypeScript,
built into static assets the gateway serves.
[architecture-diagram.md](architecture-diagram.md) has the diagrams.

```
                      Worker todofy (TypeScript gateway)       Worker todofy-core (Python)
Mail Hero --Bearer--> hooks host POST /hooks/mail      --+
newsletter --Basic--> hooks host GET /api/summary, ... --+--> Durable Object inbox-v1 --> D1
owner --Access------> UI host: JWT, CSRF, assets,       |     |--> Gemini (summary, reports)
                      /api/v1/* with the owner  --------+     '--> Todoist (task, lookup, reminder)
cron */10 ----------> scheduled() -------------------------> /wake
```

## Hosts

| Host | Serves | Auth |
|---|---|---|
| `TODOFY_PUBLIC_HOST` (`todofy.ziyixi.science`) | owner UI and `/api/v1/*` | Cloudflare Access app on the whole host, and the gateway verifies the Access JWT itself (RS256 signature, issuer, audience, expiry, not-before, subject, owner or alias); writes also need CSRF and an `action_request_id` |
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

## Local development

Prerequisites: Node 26 (`.nvmrc`), uv 0.12.10; Python 3.14 is fetched by uv. No Cloudflare account or
credentials are needed.

```sh
npm ci --no-audit --no-fund
uv sync --locked
uv run ruff check worker tests tools deploy && uv run ruff format --check worker tests tools deploy
uv run pytest tests/unit tests/fakes tools deploy        # host tests
(cd gateway && npm ci --no-audit --no-fund && npm run lint && npm run typecheck && npm test)
(cd web && npm ci --no-audit --no-fund && npm run check:api && npm run typecheck && npm test && npm run build)
uv run pytest tests/runtime                               # real workerd, gateway + core, D1, DO, alarms, cron (~9 min)
```

`uv run pywrangler dev -c gateway/wrangler.toml -c wrangler.toml` runs both Workers locally
(`todofy.localhost` / `todofy-hooks.localhost`).
[docs/dev-notes.md](docs/dev-notes.md) covers the layout, the Python Workers idioms and the module
contracts.

## Deploy

Every push runs the `Todofy checks` job; a push to `main` (or a manual run on `main`) then deploys:
generate both production configs from GitHub variables, dry-run, apply D1 migrations, deploy
`todofy-core` and then the gateway, wait for `/health` to report the commit, then check that a wrong
newsletter credential gets 401/429 from the Durable Object (proving gateway → object → D1). There are no pull requests; `main` is fast-forwarded. One-time setup
(D1, Access, GitHub environment, Worker secrets) is in [docs/cloudflare-setup.md](docs/cloudflare-setup.md).

## Repository

```
worker/todofy/core/     pure Python rules (vocabulary, contract, prompts, classification, SQL)
worker/todofy/runtime/  todofy-core: Durable Object, D1 ledger, Gemini/Todoist clients, owner API
gateway/                the gateway Worker todofy (TypeScript): routing, Access, CSRF, webhook, assets
migrations/             D1 schema
api/                    owner OpenAPI contract, newsletter report schemas, Mail Hero event schema
web/                    owner UI (React + Vite), built into uiassets/dist
tests/                  unit, fakes and runtime (workerd) tests
tools/                  legacy SQLite snapshot/export/verify and the webhook smoke test
deploy/                 production config generator (both Workers)
docs/                   setup, CI/CD, verification, dev notes, migration plan
```

The retired Go service (gRPC microservices, CloudMailin, DAG dependencies) is in the git history at
`6c46ed4`.
