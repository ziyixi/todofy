# Mail Hero, Todofy, the home dashboard and the personal website

Four independent Cloudflare apps in one repository, the contracts between them, and the shared code
compiled into each.

| Directory | What it is | Start here |
| --- | --- | --- |
| [`mail-hero/`](mail-hero/) | Personal inbox on Workers Free + D1 + R2 + a SQLite Durable Object: receives mail through Email Routing and POSTs a `mail.received.v1` webhook | [`mail-hero/README.md`](mail-hero/README.md), [`mail-hero/AGENTS.md`](mail-hero/AGENTS.md) |
| [`todofy/`](todofy/) | The webhook consumer: TypeScript gateway + Python core Workers that turn mail into Todoist tasks, summaries and reminders | [`todofy/README.md`](todofy/README.md), [`todofy/docs/dev-notes.md`](todofy/docs/dev-notes.md) |
| [`dashboard/`](dashboard/) | The owner's ops view `home` (TypeScript Worker + SQLite Durable Object + React UI) on `home.ziyixi.science`: both apps' health through their `Ops` entrypoints, account-wide Workers Free usage with quota guardrails, a daily end-to-end canary and the unified ops digest | [`dashboard/README.md`](dashboard/README.md), [`dashboard/docs/`](dashboard/docs/) |
| [`website/`](website/) | The personal website `www.ziyixi.science`: Next.js static export on the assets-only Worker `ziyixi-website`, Notion as the content source, and the Notion relay Worker `ziyixi-notion-publish` (buttons plus a 15-minute change detector that publishes automatically). Uses no contract and no package | [`website/README.md`](website/README.md), [`website/docs/`](website/docs/) |
| [`contracts/`](contracts/) | `mail.received.v1`: schema, semantics and golden payloads built by Mail Hero's real builder; `ops-v1`: both apps' `Ops` entrypoints, which the dashboard calls | [`contracts/README.md`](contracts/README.md) |
| [`packages/edge-auth/`](packages/edge-auth/) | Shared auth code compiled into every Worker (Todofy gateway, Mail Hero, dashboard): Cloudflare Access JWT verification, signed double-submit CSRF, private response headers. TypeScript, Web Crypto only, no runtime dependencies; not a Worker of its own | [`packages/edge-auth/README.md`](packages/edge-auth/README.md), [`SPEC.md`](packages/edge-auth/SPEC.md) |

Rules ([`AGENTS.md`](AGENTS.md)): the apps never import each other; shared code lives only in `contracts/`
and `packages/`; each app deploys on its own. An app uses a package through a
`"file:../../packages/<name>"` dependency and its bundler compiles it in, so a change to a package's code
checks and deploys every app that uses it (its Markdown documents only check them). `contracts/` holds documents, schemas and fixtures, plus two
dependency-free files the TypeScript Workers import by relative path (`ops-v1/ops-v1.ts` types,
`ops-v1/validate.mjs` for tests). Work inside an app's directory: `cd mail-hero`, `cd todofy`,
`cd dashboard` or `cd website`, then follow that app's README. Mail Hero and Todofy were separate
repositories until 2026-09-29, the website (`ziyixi/ziyixi.science`) until 2026-09-30; their histories are
kept (`git log --follow todofy/<file>`, `git log -- mail-hero/<file>`, `git log --follow website/<file>`;
old commit IDs are mapped in [`mail-hero/docs/history-map.md`](mail-hero/docs/history-map.md) and
[`website/docs/history-map.md`](website/docs/history-map.md)).

## Ops surface (`contracts/ops-v1`)

Each app's TypeScript Worker also exports a named `WorkerEntrypoint` `Ops` for the dashboard Worker `home`
in the same account ([`dashboard/`](dashboard/)): `[[services]] binding = "MAIL_HERO", service =
"mail-hero", entrypoint = "Ops"` and `binding = "TODOFY", service = "todofy", entrypoint = "Ops"`. There is no new public route and
no Access check; only a Worker deployed in this account can bind it.

| App | Methods | Where |
| --- | --- | --- |
| Mail Hero | `status()`, `setGuard()`, `startCanary({run_id})`, `canaryDelivery(event_id)` | [`mail-hero/docs/cloudflare-setup.md`](mail-hero/docs/cloudflare-setup.md) §2.3, [`mail-hero/cloudflare/README.md`](mail-hero/cloudflare/README.md) |
| Todofy | `status()`, `setGuard()`, `canaryResult(event_id)`, `reportOps(report)` | [`todofy/docs/gateway-contract.md`](todofy/docs/gateway-contract.md) §3.7, [`todofy/docs/dev-notes.md`](todofy/docs/dev-notes.md) |

- `status()` uses a small, documented number of indexed D1 reads and returns codes, numbers, booleans,
  times and the UI URL only; never mail content.
- A `shed` guard expires by itself (at most 36 h ahead) and defers only cleanup and safety-net jobs, each
  within a bound; it never stops intake, parsing, delivery, retries or real-mail processing.
- The canary is a synthetic `mail.received.v1` event with a top-level `canary` marker
  ([`fixtures/canary_event.json`](contracts/mail-received-v1/fixtures/canary_event.json)); consumers must
  not cause external side effects for it. Todofy runs it through Gemini and records the result, never
  Todoist, summaries, reports or reminders. The dashboard runs it once a day (plus up to 3 manual runs).
- Todofy's daily attention reminder (still at most one Todoist task per UTC day) carries the warning and
  critical items of the latest `reportOps` report, which only the dashboard sends. Mail Hero's own
  `ALERT_WEBHOOK_URL` stays optional and unconfigured; the dashboard's report replaces it.
- The dashboard sets `shed` on both apps when an account-wide daily allowance (or a monthly R2
  operation class) reaches 80 %, and clears it below 70 % or on a new UTC day
  ([`dashboard/docs/limits.md`](dashboard/docs/limits.md)).

Release order: Todofy (canary consumer) before Mail Hero, then the dashboard; in one CI run
`Dashboard deploy` waits for both app deploys. The contract and the per-app plan are
[`contracts/ops-v1/README.md`](contracts/ops-v1/README.md) and
[`IMPLEMENTATION.md`](contracts/ops-v1/IMPLEMENTATION.md).

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) ("CI and deploy") runs on a push to any branch and on
a manual run. Actions are pinned by commit SHA.

| Job | Runs when | Does |
| --- | --- | --- |
| `Changes` | always | Tests and runs [`.github/scripts/ci_changes.py`](.github/scripts/ci_changes.py): `git diff --name-only` from a cumulative base to the pushed commit. On `main` the base is the commit of the last successful push run of this workflow on `main` (read with the job's `actions: read` token), so changes from a failed or cancelled run, including one cancelled while pending, are checked and deployed by the next run. On other branches the base is `git merge-base origin/main HEAD`, so the head commit's gate covers the whole branch. No usable base (first run, API error, base not an ancestor) runs everything. A manual run's `app` input selects the apps: `both` (the default: Todofy and Mail Hero), `all`, `todofy`, `mail-hero`, `dashboard` or `website` (the site and its relay) |
| `Shared packages` | `packages/<name>/` or `.github/` changed, or a manual run | For every `packages/*/`, from its own directory: `npm ci`, `npm run typecheck`, `npm test` |
| `Todofy checks` | `todofy/`, `packages/edge-auth/`, `contracts/` or `.github/` changed | Everything Todofy's CI ran, from `todofy/`: ruff, host tests, gateway lint/typecheck/tests, UI API check/typecheck/tests/build and the no-Mail-Hero guard, workerd runtime tests, placeholder config dry-run of both Workers |
| `Mail Hero checks` | `mail-hero/`, `packages/edge-auth/`, `contracts/` or `.github/` changed | Everything Mail Hero's CI ran, from `mail-hero/`: config and backup tool tests, Worker typecheck and tests (workerd bindings, contract fixtures), UI typecheck/tests/build, plus a placeholder config dry-run |
| `Dashboard checks` | `dashboard/`, `packages/edge-auth/`, `contracts/` or `.github/` changed | From `dashboard/`: config generator tests, Worker lint/typecheck/unit tests, workerd runtime tests (the real `HomeState` with stub `mail-hero`/`todofy` Workers serving the ops-v1 fixtures over `Ops` RPC, a fake GraphQL endpoint and a test Access JWKS), UI lint/typecheck/tests/build, a guard against imports from `mail-hero/` or `todofy/`, and a placeholder production config dry-run |
| `Website checks` | `website/`, `contracts/`, `.github/` changed (or an unregistered package) | From `website/`, no secrets: format, lint, typecheck, unit tests (release steps, relay buttons and change detector included); for the empty source and the synthetic fixture the static export and Playwright against it under `wrangler dev` with the production `wrangler.toml`, `_headers` and `_redirects`; the release route contract on the fixture; `wrangler deploy --dry-run` of both Workers; an import guard |
| `Contracts` | any app except the website, a package an app uses, `contracts/` or `.github/` changed | `mail.received.v1`: Mail Hero rebuilds every golden fixture byte for byte (the canary one included); Todofy validates and parses every fixture; neither side allows two fixtures to share an event ID. `ops-v1`: both sides validate every fixture against the schema (Mail Hero with `validate.mjs`, Todofy with `jsonschema`), and each app's own `Ops` code is checked against it on the host (Mail Hero `native-ops.test.mjs`, Todofy `test_ops_core.py` and the gateway's `ops.test.ts`), and the caller: the dashboard calls only the methods `ops-v1.ts` declares, handles every declared error code, and every input it sends passes the schema (`dashboard/worker` `ops-client`, `guard`, `canary`, `digest` tests). Nothing here needs workerd; each app's check job runs the real-binding `Ops` tests |
| `CI gate` | always | Fails if any job above failed or was cancelled; skipped as unchanged is fine. **The one check to require on `main`** |
| `Todofy deploy` | `main` only, `todofy/`, `packages/edge-auth/` or `contracts/ops-v1/ops-v1.ts` changed (or dispatched), after `CI gate` | Generate configs, dry-run, D1 migrations, deploy `todofy-core` then the gateway, `/health` and core probes. `production` environment, group `todofy-production` |
| `Mail Hero deploy` | `main` only, `mail-hero/`, `packages/edge-auth/` or `contracts/ops-v1/ops-v1.ts` changed (or dispatched), after `CI gate` | `generate-ci-config.mjs`, dry-run, D1 migrations, deploy. `production` environment, group `mail-hero-production` |
| `Website deploy` | `main` only, `website/` outside `website/relay/` changed (or dispatched with `website`/`all`), after `CI gate` | Calls [`.github/workflows/website-release.yml`](.github/workflows/website-release.yml), the same workflow the Notion buttons and the relay's detector dispatch: Notion sync, static export, verification under `wrangler dev`, `wrangler versions upload`, `versions deploy` only if production still serves the recorded version, `triggers deploy` for the hostnames in `website/wrangler.toml`, live verification, rollback on failure, Notion feedback. An unchanged identity (newest `website/` commit, content, config) skips the deploy. The called job holds the group `website-production` and the `production` environment ([`website/docs/release.md`](website/docs/release.md)) |
| `Website relay deploy` | `main` only, `website/relay/` changed (or dispatched with `website`/`all`), after `CI gate` | `wrangler deploy` of the relay Worker `ziyixi-notion-publish` (keeps its Worker secrets, applies its cron), then a `/health` probe. `production` environment, group `website-relay-production` |
| `Dashboard deploy` | `main` only, `dashboard/`, `packages/edge-auth/`, `contracts/ops-v1/ops-v1.ts`, `ops-v1.schema.json` or `validate.mjs` changed (or dispatched), after `CI gate` and after `Todofy deploy` and `Mail Hero deploy` (each success or skipped: the service bindings need their `Ops` entrypoints live) | Build the UI, `generate-ci-config.mjs`, dry-run, deploy (no D1), then a probe that an unauthenticated `GET /` and `/api/v1/overview` are answered by Access with a 302 to its login page for this host (`<issuer>/cdn-cgi/access/login/<host>`), never by the app or another redirect. `production` environment, group `dashboard-production` |

A change to only `contracts/` or `.github/` re-checks every app but deploys none, except the contract
files the Workers bundle: all three TypeScript Workers bundle the constants of
`contracts/ops-v1/ops-v1.ts` (`OPS_LIMITS`), so a change to it deploys all three, and the dashboard
bundles `ops-v1.schema.json` and `validate.mjs` (it validates every `Ops` answer), so a change to
those also deploys the dashboard (`BUNDLED_BY` in `.github/scripts/ci_changes.py` maps each bundled
contract file to its apps; its test compares the map with the Workers' imports). Dispatch on `main` to
redeploy an app. A change to `packages/edge-auth/` runs `Shared packages` and checks **and deploys** all
three apps, because every Worker compiles it in; a change to only its Markdown documents
(`packages/<name>/**/*.md`, e.g. `README.md`, `SPEC.md`) runs `Shared packages` and checks the three apps
but deploys none (nothing of it is compiled in). `ci_changes.py` maps each package
to the apps that use it (`PACKAGE_USERS`); `test_ci_changes.py` fails unless that map matches every
`"file:../../packages/<name>"` dependency and lists every `packages/*/` directory, and a package missing
from it counts as used by every app. A dashboard-only change checks and deploys only the dashboard (and
runs `Contracts`); it never redeploys the apps it calls. Root-only files (`README.md`, `AGENTS.md`,
`packages/README.md`) run only `Changes` and `CI gate`.

The deploy jobs' `if:` must stay explicit: `!cancelled()` plus `needs.<job>.result == 'success'` for every
job they need (for `Dashboard deploy`, `success` or `skipped` for the two app deploys). `CI gate` needs
every app's check job and some are skipped whenever only another app changed; a condition without a
status function gets an implicit `success()` that also sees that skipped ancestor and would skip the
deploy ([actions/runner#2205](https://github.com/actions/runner/issues/2205)). `test_ci_changes.py` (run
by `Changes`) fails if a job after the gate loses this shape, if a production job lacks its own
concurrency group, or if the dispatch options and `DISPATCH` differ. It also fails if the `Contracts`
job stops naming both sides' contract tests and the dashboard's caller test, or names a test file that
does not exist.

The first push run of this workflow on `main` has no earlier successful run of it and therefore checks and
deploys every app. (The Go-era `ci.yml` of the old Todofy repository shares the file name; its last green
`main` commit is either an ancestor, whose diff covers both apps, or not, which also runs everything.)

[`.github/workflows/mail-hero-backup-image.yml`](.github/workflows/mail-hero-backup-image.yml) builds Mail
Hero's backup collector when `mail-hero/deploy/backup/**` or `mail-hero/cloudflare/migrations/**` change: other
branches build only; `main` publishes `ghcr.io/ziyixi/mail-hero-backup-collector`. That is a new package
name: the old `ghcr.io/ziyixi/mail-hero-backup` stays linked to the old repository, and the server keeps its
pinned digest of it until the next collector upgrade switches the Compose image to the new package's digest.

### Production environment

All deploy jobs use the one `production` environment (deployment branch `main`).

| Job | Variables | Secrets |
| --- | --- | --- |
| `Todofy deploy` | `CLOUDFLARE_ACCOUNT_ID`, `TODOFY_PUBLIC_HOST`, `TODOFY_D1_DATABASE_ID`, `TODOFY_D1_DATABASE_NAME`, `TODOFY_HOOKS_HOSTS`, `TODOFY_MAIL_SOURCE_ID`, `TODOFY_ACCESS_ISSUER`, `TODOFY_ACCESS_AUDIENCE`, `TODOFY_GEMINI_MODELS`, `TODOFY_GEMINI_DAILY_TOKEN_BUDGET`, `TODOFY_LOOKUP_DELAY_MS`, `TODOFY_REPORT_DEFAULT_TOP`, `TODOFY_REPORT_PRECOMPUTE_UTC`, `TODOFY_LEGACY_TEXT_RETENTION_DAYS`, `TODOFY_REMINDER_ENABLED`, `TODOFY_MAINTENANCE_MODE`, `TODOFY_PROCESSING_PAUSED`, `TODOFY_FORCE_PAUSE_TODOIST` | `CF_API_TOKEN`, `TODOFY_ACCESS_OWNER`, `TODOFY_ACCESS_OWNER_ALIASES`, `TODOFY_TODOIST_DEFAULT_PROJECT_ID` |
| `Mail Hero deploy` | `CLOUDFLARE_ACCOUNT_ID`, `MAIL_HERO_PUBLIC_HOST`, `MAIL_HERO_D1_DATABASE_ID`, `MAIL_HERO_D1_DATABASE_NAME`, `MAIL_HERO_R2_BUCKET_NAME`, `MAIL_HERO_BACKUP_BUCKET_NAME`, `MAIL_HERO_ACCESS_ISSUER`, `MAIL_HERO_ACCESS_AUDIENCE`, `MAIL_HERO_WEBHOOK_ALLOWED_HOSTS`, `MAIL_HERO_ALERT_WEBHOOK_URL`, `MAIL_HERO_ALERT_WEBHOOK_ALLOWED_HOSTS`, `MAIL_HERO_FORCE_SEND_PAUSED`, `MAIL_HERO_MAINTENANCE_MODE`, `MAIL_HERO_INGEST_DAILY_MESSAGE_LIMIT`, `MAIL_HERO_INGEST_DAILY_BYTE_LIMIT` | `MAIL_HERO_CF_API_TOKEN` (named `CF_API_TOKEN` in the old Mail Hero repository), `MAIL_HERO_RECEIVE_ADDRESS`, `MAIL_HERO_ACCESS_OWNER`, `MAIL_HERO_ACCESS_OWNER_ALIASES` |
| `Website deploy` (the release workflow) | none: `SITE_URL`, `NOTION_API_VERSION` and the legacy repository are committed in the workflow, the account and hostnames in `website/wrangler.toml`; optional `WEBSITE_BOOTSTRAP_APPROVAL` (only an empty-registry bootstrap) | `CF_API_TOKEN`, `WEBSITE_NOTION_TOKEN`, `WEBSITE_NOTION_DATA_SOURCE_ID` |
| `Website relay deploy` | none (its settings are committed in `website/relay/wrangler.toml`; its four secrets are Worker secrets) | `CF_API_TOKEN` |
| `Dashboard deploy` | `CLOUDFLARE_ACCOUNT_ID`, `DASHBOARD_PUBLIC_HOST`, `DASHBOARD_ACCESS_ISSUER`, `DASHBOARD_ACCESS_AUDIENCE`, `MAIL_HERO_PUBLIC_HOST`, `TODOFY_PUBLIC_HOST` (links), optional `DASHBOARD_CANARY_UTC_HOUR`, optional `DASHBOARD_CANARY_ENABLED` (`true`/`false`, default `true`) | `CF_API_TOKEN` (deploy only), `DASHBOARD_ACCESS_OWNER`, `DASHBOARD_ACCESS_OWNER_ALIASES`, `DASHBOARD_CSRF_SIGNING_KEY`, `DASHBOARD_CF_ANALYTICS_TOKEN` (GraphQL Analytics only; to be replaced by an "Account Analytics: Read" token, [`dashboard/docs/setup.md`](dashboard/docs/setup.md) §4) |

The repository is public, and Actions prints a step's variables in its log, so personal values (the receive
address, owner emails, the Todoist project id) are secrets even though they are not credentials.
`CLOUDFLARE_ACCOUNT_ID` is shared by all three jobs (one Cloudflare account). The backup image workflow uses only
the job's own `GITHUB_TOKEN`.
