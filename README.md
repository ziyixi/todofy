# Mail Hero and Todofy

Two independent Cloudflare apps in one repository, and the one contract between them.

| Directory | What it is | Start here |
| --- | --- | --- |
| [`mail-hero/`](mail-hero/) | Personal inbox on Workers Free + D1 + R2 + a SQLite Durable Object: receives mail through Email Routing and POSTs a `mail.received.v1` webhook | [`mail-hero/README.md`](mail-hero/README.md), [`mail-hero/AGENTS.md`](mail-hero/AGENTS.md) |
| [`todofy/`](todofy/) | The webhook consumer: TypeScript gateway + Python core Workers that turn mail into Todoist tasks, summaries and reminders | [`todofy/README.md`](todofy/README.md), [`todofy/docs/dev-notes.md`](todofy/docs/dev-notes.md) |
| [`contracts/`](contracts/) | `mail.received.v1`: schema, semantics and golden payloads built by Mail Hero's real builder | [`contracts/README.md`](contracts/README.md) |

Rules ([`AGENTS.md`](AGENTS.md)): the apps never import each other; only `contracts/` is shared; each app
deploys on its own. Work inside an app's directory: `cd mail-hero` or `cd todofy`, then follow that app's
README. Both apps were separate repositories until 2026-09-29; their histories are kept
(`git log --follow todofy/<file>`, `git log -- mail-hero/<file>`; Mail Hero's old commit IDs are mapped in
[`mail-hero/docs/history-map.md`](mail-hero/docs/history-map.md)).

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) ("CI and deploy") runs on a push to any branch and on
a manual run. Actions are pinned by commit SHA.

| Job | Runs when | Does |
| --- | --- | --- |
| `Changes` | always | Tests and runs [`.github/scripts/ci_changes.py`](.github/scripts/ci_changes.py): `git diff --name-only` between `github.event.before` and the pushed commit. A new branch, force push or unknown `before` runs everything. A manual run's `app` input (`both`, `todofy`, `mail-hero`) selects the apps |
| `Todofy checks` | `todofy/`, `contracts/` or `.github/` changed | Everything Todofy's CI ran, from `todofy/`: ruff, host tests, gateway lint/typecheck/tests, UI API check/typecheck/tests/build and the no-Mail-Hero guard, workerd runtime tests, placeholder config dry-run of both Workers |
| `Mail Hero checks` | `mail-hero/`, `contracts/` or `.github/` changed | Everything Mail Hero's CI ran, from `mail-hero/`: config and backup tool tests, Worker typecheck and tests (workerd bindings, contract fixtures), UI typecheck/tests/build, plus a placeholder config dry-run |
| `Contracts` | any app, `contracts/` or `.github/` changed | Mail Hero rebuilds every golden fixture byte for byte; Todofy validates and parses every fixture |
| `CI gate` | always | Fails if any job above failed or was cancelled; skipped as unchanged is fine. **The one check to require on `main`** |
| `Todofy deploy` | `main` only, `todofy/` changed (or dispatched), after `CI gate` | Generate configs, dry-run, D1 migrations, deploy `todofy-core` then the gateway, `/health` and core probes. `production` environment, group `todofy-production` |
| `Mail Hero deploy` | `main` only, `mail-hero/` changed (or dispatched), after `CI gate` | `generate-ci-config.mjs`, dry-run, D1 migrations, deploy. `production` environment, group `mail-hero-production` |

A change to only `contracts/` or `.github/` re-checks both apps but deploys neither; dispatch on `main` to
redeploy an app. Root-only files (`README.md`, `AGENTS.md`) run only `Changes` and `CI gate`.

[`.github/workflows/mail-hero-backup-image.yml`](.github/workflows/mail-hero-backup-image.yml) builds Mail
Hero's backup collector when `mail-hero/deploy/backup/**` or `mail-hero/cloudflare/migrations/**` change: other
branches build only; `main` publishes `ghcr.io/ziyixi/mail-hero-backup-collector`. That is a new package
name: the old `ghcr.io/ziyixi/mail-hero-backup` stays linked to the old repository, and the server keeps its
pinned digest of it until the next collector upgrade switches the Compose image to the new package's digest.

### Production environment

Both deploy jobs use the one `production` environment (deployment branch `main`).

| Job | Variables | Secrets |
| --- | --- | --- |
| `Todofy deploy` | `CLOUDFLARE_ACCOUNT_ID`, `TODOFY_PUBLIC_HOST`, `TODOFY_D1_DATABASE_ID`, `TODOFY_D1_DATABASE_NAME`, `TODOFY_HOOKS_HOSTS`, `TODOFY_MAIL_SOURCE_ID`, `TODOFY_ACCESS_ISSUER`, `TODOFY_ACCESS_AUDIENCE`, `TODOFY_GEMINI_MODELS`, `TODOFY_GEMINI_DAILY_TOKEN_BUDGET`, `TODOFY_TODOIST_DEFAULT_PROJECT_ID`, `TODOFY_LOOKUP_DELAY_MS`, `TODOFY_REPORT_DEFAULT_TOP`, `TODOFY_REPORT_PRECOMPUTE_UTC`, `TODOFY_LEGACY_TEXT_RETENTION_DAYS`, `TODOFY_REMINDER_ENABLED`, `TODOFY_MAINTENANCE_MODE`, `TODOFY_PROCESSING_PAUSED`, `TODOFY_FORCE_PAUSE_TODOIST` | `CF_API_TOKEN`, `TODOFY_ACCESS_OWNER`, `TODOFY_ACCESS_OWNER_ALIASES` |
| `Mail Hero deploy` | `CLOUDFLARE_ACCOUNT_ID`, `MAIL_HERO_PUBLIC_HOST`, `MAIL_HERO_D1_DATABASE_ID`, `MAIL_HERO_D1_DATABASE_NAME`, `MAIL_HERO_R2_BUCKET_NAME`, `MAIL_HERO_BACKUP_BUCKET_NAME`, `MAIL_HERO_RECEIVE_ADDRESS`, `MAIL_HERO_ACCESS_ISSUER`, `MAIL_HERO_ACCESS_AUDIENCE`, `MAIL_HERO_ACCESS_OWNER`, `MAIL_HERO_WEBHOOK_ALLOWED_HOSTS`, `MAIL_HERO_ALERT_WEBHOOK_URL`, `MAIL_HERO_ALERT_WEBHOOK_ALLOWED_HOSTS`, `MAIL_HERO_FORCE_SEND_PAUSED`, `MAIL_HERO_MAINTENANCE_MODE`, `MAIL_HERO_INGEST_DAILY_MESSAGE_LIMIT`, `MAIL_HERO_INGEST_DAILY_BYTE_LIMIT` | `MAIL_HERO_CF_API_TOKEN` (named `CF_API_TOKEN` in the old Mail Hero repository), `MAIL_HERO_ACCESS_OWNER_ALIASES` |

`CLOUDFLARE_ACCOUNT_ID` is shared by both jobs (one Cloudflare account). The backup image workflow uses only
the job's own `GITHUB_TOKEN`.
