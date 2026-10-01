# Home dashboard (`home`)

The owner's personal console (个人控制台) on `home.ziyixi.science`, behind the Cloudflare Access
application "Home". Four hash-routed views ([`docs/design-v2.md`](docs/design-v2.md)):

- **首页 `#/`**: launcher tiles for every registered app, site and background service (Mail Hero,
  Todofy, the website, Notion 发布, the newsletter), each a real link plus an honest
  health word (link-only entries show only their host; unmonitored ones say 未接入), an attention strip,
  one line per business flow and four mini quota bars (Workers AI neurons among them, with the neurons
  left today).
- **业务流程 `#/flows`**: each flow as a chain of stages bound to app signals, counters, Worker analytics
  and, for 邮件 → 任务, the canary.
- **Cloudflare 监控 `#/cloudflare`**: the account quotas, an auto-discovered per-Worker table (requests,
  errors, CPU p50/p99 against the 10 ms Free limit, subrequests, DO requests) and D1/DO/R2 resources
  named from the registry.
- **操作与记录 `#/ops`**: guard and canary actions, the digest and each app's full ops-v1 details.

What exists and how it maps to Workers, resources and flows is a typed registry compiled into the
Worker (`worker/src/registry.ts`) and served by `GET /api/v2/registry`, so no hostname is in the UI
bundle. It reads Mail Hero and Todofy only through their `Ops` entrypoints
([`contracts/ops-v1`](../contracts/ops-v1/README.md)) and never imports `mail-hero/` or `todofy/` code.
Besides the page it runs four jobs:

- **Canary and digest.** A daily delivery-and-processing canary (one synthetic `mail.received.v1`
  event that Mail Hero creates directly and delivers to Todofy, no Todoist side effects) and one
  unified ops digest that Todofy's daily reminder carries. The canary covers Mail Hero delivery →
  Todofy intake, Gemini summary and verification; it does not cover source forwarding, Email Routing,
  raw storage or MIME parsing, so a green run says nothing about whether mail is being received.
  The GitHub variable `DASHBOARD_CANARY_ENABLED=false` stops new runs (for example before a Todofy
  rollback, [`docs/setup.md`](docs/setup.md) §7); a run already queued is still polled to its end.
- **Quota guardrails.** Account-wide Workers Free usage from the GraphQL Analytics API; at ≥ 80 % of a
  daily allowance (or a monthly R2 operation class) both apps defer their non-critical jobs (`shed`).
- **Configuration drift (配置漂移).** Once per UTC day, read-only, the live Workers (scripts, Custom
  Domains, zone routes, crons, binding and secret names with their types, workers.dev flags, and whether
  every personal value is a secret) are compared with the desired state generated from every committed
  `wrangler.toml` and deploy wrapper (`worker/src/drift-desired.json`, by
  [`.github/scripts/drift_desired.py`](../.github/scripts/drift_desired.py)). Names only; shown on the
  Cloudflare view and counted in the digest, never published on GitHub ([`docs/design-v2.md`](docs/design-v2.md) §10).
- **Cross-app contract tests.** The caller side of ops-v1: only declared methods, every declared error
  code, schema-valid inputs, and the real `HomeState` against stub apps that answer with the contract
  fixtures.

Workers Free only: the fetch and cron handlers authenticate, route and make one RPC; all work runs in
the SQLite Durable Object `HomeState`, every read, call and table is bounded (one GraphQL query and one
website probe per tick, rate-limited owner refreshes; design-v2 §5), and nothing holds mail content.

| Path | What |
| --- | --- |
| `wrangler.toml` | the production config of the Worker `home` (committed, top level = production; run wrangler from `worker/` with `--config ../wrangler.toml`; local values in `.dev.vars`, see `.dev.vars.example`) |
| `worker/` | TypeScript Worker `home` + Durable Object `HomeState`; `src/registry.ts` is the registry, `src/api-v2-types.ts` the API types the UI imports |
| `web/` | React + Vite UI (Chinese, mobile-first, light/dark, browser time zone), built to `web/dist` and served by the Worker |
| `deploy/` | `deploy-vars.mjs` (what the deploy adds: `--var` values and the secrets file) and the tests of it and of `wrangler.toml` |
| [`docs/design.md`](docs/design.md) | storage, the tick (status, usage, guard, canary, digest), Access/CSRF, the usage query, tests, CI (its v1 API and one-page UI sections are superseded by design-v2) |
| [`docs/design-v2.md`](docs/design-v2.md) | v2: four views, the registry (entries, workers, resources, flows), levels, API v2 and its budgets |
| [`docs/setup.md`](docs/setup.md) | resources, Access, GitHub variables and secrets, the analytics token, local dev, rollback |
| [`docs/limits.md`](docs/limits.md) | every Free allowance and platform limit used, with Cloudflare sources |
| [`docs/verification.md`](docs/verification.md) | what was checked locally and what is still open in production |

## Checks (as CI's `Dashboard checks` runs them)

```sh
cd dashboard
npm ci --prefix worker && npm ci --prefix web
node --test deploy/test/*.test.mjs                      # needs worker/node_modules (reads wrangler.toml with wrangler)
(cd worker && npm run lint && npm run typecheck && npm test && npm run test:runtime)
(cd web && npm run lint && npm run typecheck && npm test && npm run build)
```

The job also refuses any import from `mail-hero/` or `todofy/` and dry-runs the committed production
config through `deploy/deploy-vars.mjs` with placeholder values for what the deploy adds. `Contracts` runs the host-side ops-v1 caller tests
(`worker/test/ops-client.test.ts`, `guard`, `canary`, `digest`). `Dashboard deploy` runs on `main`
only, after `CI gate` and after both app deploys, and finishes with a probe that an unauthenticated
request is answered by Access, never by the app. See the root [`README.md`](../README.md) "CI".

To see the built UI against the real Worker locally without any account, see
[`docs/setup.md`](docs/setup.md) §5.

Status: v2 implemented and tested locally with synthetic data, including a browser pass over the four
views on desktop and a 390 px phone; the production checks still open are listed in
[`docs/verification.md`](docs/verification.md) §2.
