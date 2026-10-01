# Cloudflare setup (one-time bootstrap)

What the owner sets up once before the first deploy. Everything after that goes through GitHub Actions
([ci-cd.md](ci-cd.md)). This file names settings and how to derive them; it never holds values. The
repository and its Actions logs are public, so no secret, owner email or database content belongs in it.

Plan: Workers Free. Nothing here needs a paid product. Both Workers, D1 and Durable Object requests share
the account's free daily allowances with Mail Hero.

Todofy is two Workers ([gateway-contract.md](gateway-contract.md)):

- `todofy`, the TypeScript gateway: the custom domains, Access and CSRF checks, webhook and newsletter
  credential checks, the UI assets and the cron. It holds the credential digests and the owner emails.
- `todofy-core`, the Python Worker that hosts the Durable Object. It has no public route; it holds D1 and
  the Gemini and Todoist API keys, and does all the work inside the object (30 s CPU per call instead of
  a plain Worker's 10 ms on Workers Free).

## 1. D1 database

```sh
npx wrangler d1 create todofy
```

Put the printed `database_id` into `[[d1_databases]]` of the committed `wrangler.toml` and commit it (a
D1 ID is not a secret). The schema is applied
by every deploy (`wrangler d1 migrations apply DB --remote`); do not apply it by hand.

Backup bucket (weekly D1 backups, §7), before the first deploy that binds it; a deploy whose config
names a missing bucket fails:

```sh
npx wrangler r2 bucket create todofy-backups
```

Keep it private: no public access, no `r2.dev` URL, no custom domain, no lifecycle rule (the core's
own retention deletes old backups). It holds mail content (summaries, todo bodies, payloads of unfinished
events, the imported legacy text). The deploy token (§3) has no R2 permission: wrangler 4.142.0 looks the
bucket up on the first deploy that binds it and, on a 403, skips that check (read from its source); that
Cloudflare's upload then accepts the binding without R2 permission is unverified. If the first deploy
fails on the `BACKUPS` binding, add "Workers R2 Storage: Read" to the token rather than Edit.

Metrics dataset: both Workers bind the Workers Analytics Engine dataset `todofy_metrics` (binding
`METRICS`, docs/dev-notes.md §6). The dataset needs no create command, but check once in the dashboard
(Workers & Pages → Analytics Engine) that Analytics Engine is available on the account before the
first deploy that binds it.

## 2. Cloudflare Access (UI host only)

Zero Trust → Access → Applications → Self-hosted:

- Domain: exactly `TODOFY_PUBLIC_HOST` (e.g. `todofy.ziyixi.science`), whole host, no path. Visible in
  the App Launcher.
- Policies: Allow, by exact email per identity provider, one policy per provider (for example the owner's
  mailbox login and the owner's GitHub login). No Bypass rules.
- Copy the application's AUD tag (64 hex) into the variable `TODOFY_ACCESS_AUDIENCE`, and the team
  domain `https://<team>.cloudflareaccess.com` into `TODOFY_ACCESS_ISSUER`.
- Do not create any Access application for the hooks hosts: Mail Hero and the newsletter authenticate
  with their own credentials, and an Access redirect would break them.

The Worker verifies the Access JWT itself and accepts only `ACCESS_OWNER` or an address in
`ACCESS_OWNER_ALIASES` (up to 8). Put every login the Access policies allow for the owner there, e.g. a
GitHub-login email that differs from the owner email; all of them map to the one owner identity.

## 3. GitHub `production` environment

Repository → Settings → Environments → `production`, deployment branches: `main` only. Branch protection
on `main`: require the `Todofy checks` status check.

Environment secrets:

| Secret | What |
|---|---|
| `CF_API_TOKEN` | Cloudflare API token: Workers Scripts edit (covers both Workers), D1 edit, zone Workers Routes / Custom Domains and DNS edit for the zone, account settings read. No billing permissions. |
| `TODOFY_ACCESS_OWNER` | the owner's primary Access email |
| `TODOFY_ACCESS_OWNER_ALIASES` | comma-separated other logins of the owner (may be empty) |
| `TODOFY_TODOIST_DEFAULT_PROJECT_ID` | Todoist project for new tasks (required). Deployed to the core as the Worker secret `TODOIST_DEFAULT_PROJECT_ID` |
| `TODOFY_TODOIST_OPS_PROJECT_ID` | optional: the Todoist project of the daily `[Todofy System]` reminder (with the ops digest). Unset or empty: the default project, as before. Deployed as the core secret `TODOIST_OPS_PROJECT_ID`, uploaded as one space when unset (read as unset; removing the GitHub secret therefore also unsets it on the Worker at the next deploy); a day's project is frozen with its claim, so changing it affects the next day ([gtd-features.md](gtd-features.md) §3) |
| `TODOFY_TODOIST_REVIEW_PROJECT_ID` | optional: the project of the Sunday review task, the core secret `TODOIST_REVIEW_PROJECT_ID`; unset or empty: the default project (uploaded as one space, like the Ops project) |

These are secrets rather than variables because the repository is public and wrangler prints every plain
var with its value in the deploy log (pywrangler also echoes its command line). The deploy's "Write the
Worker secrets files" step writes each Worker's own owner-only file, and the deploy passes it as Worker
secrets (`--secrets-file`, hidden in the Cloudflare dashboard and API): the owner emails to the gateway
`todofy` only, the Todoist projects to `todofy-core` only.

Environment variables: only the operational switches, stated at every deploy so a release never overwrites
the operational state ([ci-cd.md](ci-cd.md) "Changing a switch"). `deploy/deploy_vars.py` validates them
(a bad or missing one fails the deploy and names only the variable) and adds them with `--var` (plain
vars, as is `BUILD_SHA`):

| Variable | Value |
|---|---|
| `TODOFY_REMINDER_ENABLED` | `true` / `false` (required); core |
| `TODOFY_MAINTENANCE_MODE` | `true` / `false` (required); set on both Workers |
| `TODOFY_PROCESSING_PAUSED` | `true` / `false` (required); core |
| `TODOFY_FORCE_PAUSE_TODOIST` | `true` / `false` (required); core |
| `TODOFY_GTD_REVIEW_ENABLED` | `true` / `false` (required); core. The Sunday review task ([gtd-features.md](gtd-features.md) §7); `false` stops it without a code change. The daily snapshot itself is committed (`GTD_COLLECT_UTC`) |

Every other setting is committed in the two production configs (top level = production; the repository
is public, so nothing personal or secret goes there), and changing one is a commit:

| Setting | Where |
|---|---|
| account ID | `account_id` in both |
| D1 name and ID (step 1) | `wrangler.toml` `[[d1_databases]]` |
| UI host, hooks hosts (at most 4; `daily.ziyixi.science` since cutover) | `gateway/wrangler.toml` `routes` (the UI host first, then each hooks host) and `[vars]` `TODOFY_PUBLIC_HOST`, `TODOFY_HOOKS_HOSTS`; the core's `TODOFY_PUBLIC_HOST` (the reminder links to the UI) must be the same |
| Access issuer and AUD (step 2) | `gateway/wrangler.toml` `ACCESS_ISSUER`, `ACCESS_AUDIENCE` |
| mail source ID | `wrangler.toml` `MAIL_SOURCE_ID` (`mail-hero-personal`; must equal the source ID of the imported ledger) |
| Gemini models, daily token budget | `wrangler.toml` `GEMINI_MODELS` (first is preferred), `GEMINI_DAILY_TOKEN_BUDGET` |
| report top and precompute time | `wrangler.toml` `REPORT_DEFAULT_TOP` (must equal the newsletter's `?top=`, 10, so its report is precomputed), `REPORT_PRECOMPUTE_UTC` |
| lookup delay, legacy text retention | `wrangler.toml` `LOOKUP_DELAY_MS`, `LEGACY_TEXT_RETENTION_DAYS` (`0` keeps imported mail text forever) |
| GTD snapshot time, carryover | `wrangler.toml` `GTD_COLLECT_UTC` (`13:00`, before the 13:30 precompute; `off` stops the snapshot and with it the carryover and the GTD counters), `REPORT_CARRYOVER_DAYS` (`14`, at most 14; `0` turns the carryover off) |

The Gemini and Todoist base URLs are fixed in `wrangler.toml` and pinned by tests. `BUILD_SHA` (the commit)
is added at deploy on both Workers. Each Worker gets only the vars it reads: hosts and `ACCESS_*` go to the
gateway; the mail source, Gemini, Todoist, report, retention and switch settings go to the core;
`BUILD_SHA`, `MAINTENANCE_MODE` and `TODOFY_PUBLIC_HOST` go to both. `deploy/test_wrangler_configs.py`
checks the committed values (formats, bounds, host order, the core/gateway pairing).

## 4. Worker secrets

Set from the owner's machine (`npx wrangler login` first), from `todofy/`, and again only to rotate. Each
command prompts for the value; nothing goes on the command line or into a file. Name the Worker's
committed config (a Worker secret survives every deploy):

```sh
npx wrangler secret put <NAME> --config gateway/wrangler.toml     # the gateway todofy
npx wrangler secret put <NAME> --config wrangler.toml             # todofy-core
```

Gateway `todofy`:

| Secret | How to derive it |
|---|---|
| `MAIL_WEBHOOK_TOKEN_SHA256` | lowercase hex SHA-256 of the Bearer token Mail Hero's target sends: `printf '%s' "$TOKEN" \| shasum -a 256`. The token itself stays in Mail Hero and the password manager. |
| `MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS` | optional, the previous digest while rotating the token |
| `REPORT_BASIC_AUTH_SHA256` | SHA-256 of `user:password` the newsletter sends (`printf '%s' "$USER:$PASSWORD" \| shasum -a 256`); list two digests, comma-separated, while rotating. The password must be random, at least 128 bits (`openssl rand -hex 32`): the failure lockout never blocks a correct credential, so it does not slow guessing. |
| `CSRF_SIGNING_KEY` | 64 hex, `openssl rand -hex 32` |

Core `todofy-core`:

| Secret | How to derive it |
|---|---|
| `GEMINI_API_KEY` | a Gemini API key for Todofy |
| `TODOIST_API_KEY` | a Todoist API token |

Until a gateway secret is set, the endpoint that needs it answers 503 `not_configured` (the webhook, the
newsletter endpoints, or owner writes). A missing core key shows as not configured on the UI's setup
page. `ACCESS_OWNER` and `ACCESS_OWNER_ALIASES` are also gateway secrets, but every deploy sets them from
the GitHub environment secrets; do not `secret put` them.

On a fresh account, put the core keys before the first deploy: `todofy-core` does not exist yet, so
wrangler asks whether to create it; answer yes. It creates an empty placeholder Worker holding only the
two secrets, and the first deploy replaces its code and keeps the secrets (wrangler 4.142.0 behaviour,
read from its source). The gateway secrets can be put after the first deploy.

Also on a fresh account (or after the `todofy` script was deleted): a script without a migration tag
gets every step in `gateway/wrangler.toml`. Today that is only `v1` creating `TodofyCoordinator`, which
the gateway still exports as an empty retired class, so it is harmless. Once the gateway-only
class-delete release has added `v2` ([gateway-contract.md](gateway-contract.md) §6.6), remove the
`[[migrations]]` blocks before such a first deploy. `--dry-run` cannot catch this; it never computes
migrations against the account.

### Moving from the single Python Worker (once)

Before the split, one Python Worker `todofy` held every secret. The first deploy of the split:

1. Before merging it to `main`: put `GEMINI_API_KEY` and `TODOIST_API_KEY` on `todofy-core` as above
   (the same values as on `todofy`). Otherwise the new object would run the report precompute and any
   pending work without keys as soon as the gateway's cron wakes it.
2. The deploy applies D1 migrations, deploys `todofy-core` (creating the object class), then deploys the gateway
   over the Python `todofy` in place: its routes, the webhook, CSRF and report secrets and the owner
   secrets stay. It applies no migration: the old object stays as an empty exported class
   (`gateway/src/retired.ts`) whose counters nothing reads any more (the day's Gemini token and call
   counts, the Todoist block time, report failure counts and tick times start fresh in the new object).
   A gateway-only release of its own deletes that class later ([gateway-contract.md](gateway-contract.md)
   §6.6). Rows the old object left mid-step are recovered by the new one without a blind Todoist resend.
   If the gateway deploy fails, the Python `todofy` keeps serving with its own object and the new object
   stays idle, so nothing runs twice.
3. After the deploy succeeds, remove the keys the gateway no longer needs:
   `npx wrangler secret delete GEMINI_API_KEY --name todofy` and the same for `TODOIST_API_KEY`.
4. The deploy checks `/health` (the gateway) and then sends one wrong newsletter credential, which must
   get 401 or 429 from the object (the gateway → object → D1 path; [ci-cd.md](ci-cd.md)). Open the
   owner UI overview once to prove the Access → owner API path.

### Rolling back to the single Python Worker

The object in `todofy-core` keeps waking itself after a rollback, and two coordinators must never share
the D1 database: each would treat the other's in-flight rows as abandoned. The full steps and the reasons
are in [gateway-contract.md](gateway-contract.md) §6.5; in short:

1. `TODOFY_MAINTENANCE_MODE=true`, redeploy the current `main` (both Workers stop ledger work).
2. Put `GEMINI_API_KEY` and `TODOIST_API_KEY` back on `todofy` if step 3 above removed them.
3. Deploy the last pre-split commit. Before the class-delete release, `todofy` is still at tag `v1` and
   the pre-split config sends no migration. After it, extend that commit's migrations to `v1` new, `v2`
   deleted, `v3` new (all `TodofyCoordinator`), so wrangler sends only `v3`; a plain pre-split config
   would send `v1` again over the published `v2`, and Cloudflare's answer is unverified.
4. `npx wrangler delete --name todofy-core`.
5. Decide about the bucket `todofy-backups`: nothing rotates or deletes its backups any more, and they
   hold mail content. Delete its objects and then the bucket (`npx wrangler r2 bucket delete
   todofy-backups` refuses a non-empty bucket; empty it in the dashboard first), or keep it on purpose.
6. `TODOFY_MAINTENANCE_MODE=false`, redeploy.

Rolling back a later release (after the split) is a revert on `main` that CI deploys, both Workers
together; never `wrangler rollback` one Worker ([ci-cd.md](ci-cd.md)). Two exceptions and caveats, both
in [gateway-contract.md](gateway-contract.md):

- Once the class-delete release is live (`todofy` at migration tag `v2`), a revert of an older release
  keeps the gateway tomls' `[[migrations]]` at `v1` + `v2` and does not bring back `retired.ts` (§6.6).
- Reverting to a release before ops-v1 canary handling: that core processes a canary like real mail
  (Todoist task, lists). Stop the dashboard's canaries first and wait until no canary is pending in
  either app, or set Mail Hero's `FORCE_SEND_PAUSED` and `TODOFY_PROCESSING_PAUSED=true` first and keep
  them until those canaries are finished or cancelled (contracts/ops-v1/IMPLEMENTATION.md §4).

## 5. Hosts and callers

- Both hosts are Custom Domains of the gateway `todofy`, created by the deploy from the `routes` committed
  in `gateway/wrangler.toml`.
  `todofy-core` has no route, `workers.dev` or preview URL; only the gateway's binding reaches it.
- Mail Hero: its webhook host allowlist must include the hooks host, and its target posts to
  `https://<hooks host>/hooks/mail` with the Bearer token above.
- Newsletter: `https://<hooks host>/api/summary` and `/api/recommendation?top=10` with Basic.
- Cutover: `daily.ziyixi.science` (the old service's host, which Mail Hero's existing target and the
  newsletter already use) is added to the committed `TODOFY_HOOKS_HOSTS` and `routes` after the old Tunnel public hostname and its
  DNS record are removed; the Custom Domain cannot be created while another record holds the name
  (inferred from Cloudflare's Custom Domain rules; confirm during the cutover). The digests above must
  then be those of the credentials those callers already send.

- Ops dashboard (contracts/ops-v1, not built yet): a Worker in this account binds the gateway's
  `Ops` entrypoint (`[[services]] binding = "TODOFY" service = "todofy" entrypoint = "Ops"`). There is
  no route or Access policy for it and nothing to configure here; `status().ui_url` is built from
  `TODOFY_PUBLIC_HOST`. A `shed` guard it sets defers only the weekly backup (never past 7.5 days since
  the last complete one, 12 h before `backup_stale` at 8 days), retention and the metrics rollup (never
  past 72 h since their last complete run; once due they run until caught up) and the GTD ledger's daily
  Todoist snapshot (never past 48 h since the last one); mail, canaries, the reminder, the Sunday review and
  report precompute keep running. Guard and latest report live in the
  object's storage, not in D1 or the backups.

- Task intents (contracts/task-intent-v1): Lab binds the same `Ops` entrypoint to propose Todoist tasks.
  Release order: Todofy with migration `0005_task_intents.sql` first, then Lab (a Lab send against an
  older Todofy is refused and retried by Lab as `unavailable`). Nothing to configure: intents use the
  existing `TODOIST_API_KEY` and `TODOIST_DEFAULT_PROJECT_ID`. `MAINTENANCE_MODE`, `PROCESSING_PAUSED`
  and `FORCE_PAUSE_TODOIST` hold intents as they hold mail (new proposals answer `paused`, nothing is
  recorded). To turn the intake off without holding mail, add `TASK_INTENT_SOURCES = ""` to the `[vars]`
  of `wrangler.toml` (and to `CORE_VARS` in `deploy/test_wrangler_configs.py`) and deploy (every proposal then answers `rejected`/`source_not_allowed`; recorded
  intents still finish); unset, it accepts every source the contract lists. After a D1 restore, pending intents
  resume creating their unfinished tasks: keep `FORCE_PAUSE_TODOIST` on until they are reconciled.

## 6. Local checks before the first deploy

The deploy's own dry-run, with local placeholder values (or the real ones exported in your shell; the
wrapper prints names only). `GITHUB_SHA` (40 hex, set by Actions) becomes `BUILD_SHA`, so export it
locally too. Build the UI first (`npm run build --prefix web`).

```sh
export GITHUB_SHA=$(git rev-parse HEAD) TODOFY_MAINTENANCE_MODE=false TODOFY_PROCESSING_PAUSED=false \
  TODOFY_FORCE_PAUSE_TODOIST=false TODOFY_REMINDER_ENABLED=false TODOFY_TODOIST_DEFAULT_PROJECT_ID=placeholder \
  TODOFY_GTD_REVIEW_ENABLED=false TODOFY_ACCESS_OWNER=owner@example.com TODOFY_ACCESS_OWNER_ALIASES=
secrets=$(mktemp -d)
uv run python deploy/deploy_vars.py secrets core "$secrets/core.json"
uv run python deploy/deploy_vars.py secrets gateway "$secrets/gateway.json"
uv run python deploy/deploy_vars.py exec core -- uv run pywrangler deploy --dry-run --config wrangler.toml \
  --secrets-file "$secrets/core.json"
uv run python deploy/deploy_vars.py exec gateway -- npx --no-install wrangler deploy --dry-run \
  --config gateway/wrangler.toml --secrets-file "$secrets/gateway.json"
rm -rf "$secrets"
```

The dry-run's binding table lists the projects and owner emails as `(hidden)` environment variables, as it
lists the `--var` values: wrangler's table does not tell secrets apart; the upload sends them as
`secret_text`. The committed configs are production: never run them without `--dry-run` from a laptop (a
plain deploy deletes the injected vars), and run `wrangler dev` and D1 commands with local bindings only (`--local`).

## 7. Backups and restore

The coordinator backs D1 up to the private bucket `todofy-backups` every Sunday at 10:00 UTC, and once
right after its first deploy or whenever the object lost its state (`worker/todofy/runtime/backup.py`;
the owner UI's health page shows the last one). Each job writes every table, `legacy_mail_text`
included, under its own prefix named after the second it started: `backups/<job start>/<table>/<n>.ndjson.gz`
plus `manifest.json`, written last (tables, columns, row counts, SHA-256 per part, schema version from
`d1_migrations`); a prefix without a manifest is incomplete. A job never deletes or rewrites another
backup, so a job that fails cannot cost a complete one. After each new backup, the newest 6 complete
ones are kept and older complete ones and every older incomplete prefix are deleted. A backup that
finished early on a Sunday is not repeated at 10:00 the same day. While a backup runs (a few minutes,
30 at most) mail processing waits and owner writes answer 503; webhooks are still accepted.

Rows that D1 retention deletes (legacy text by `expires_at` or `TODOFY_LEGACY_TEXT_RETENTION_DAYS`,
summaries and reports after 90 days, owner actions after 180) stay in the backups made before the deletion until those
rotate out: about 6 weeks while backups succeed, longer while they fail. A restore brings such rows back;
the next daily retention tick deletes the ones whose time has passed again.

Cost, estimated rather than measured: a backup reads every row of every table once (about 250k D1 rows
after a year of mail, out of the account's 5M a day shared with Mail Hero, plus one read per legacy text
row), writes a few dozen R2 objects (Class A) and stores a few MB per week plus the compressed legacy
text (the imported text was estimated at about 76 MB before compression) in each of the 6 kept backups,
far below R2's free 10 GB and 1M Class A operations a month. D1 Time Travel (7 days on Free) stays the
first choice for a recent mistake; these backups cover older points and a lost database. They do not
hold the Durable Object's state or any secret. Budgets and schedule times default safely. The metrics
cursor does not simply default: it would point past the ids of a restored database, so the object
checks the row it points at on every daily flush and restarts counting when that row changed or is
gone (dev-notes.md §6). `daily_metrics` itself is in every backup.

Restore into a new, empty database (with `--local --persist-to <dir>` the same commands work on a
local copy). The backup's key is on the health page (e.g. `backups/2026-10-04T100002Z/`):

```sh
npx wrangler d1 create todofy-restore        # prints the new database's id
restore_config=<a path outside the repo>/todofy-restore.toml
python3 tools/backup_restore.py restore-config --database-name todofy-restore \
  --database-id <the new id> --out "$restore_config"
python3 tools/backup_restore.py download --backup backups/<job start> --out restore/ --remote
python3 tools/backup_restore.py sql --in restore/ --out restore/restore.sql
npx wrangler d1 migrations apply DB --remote --config "$restore_config"
npx wrangler d1 execute DB --remote --config "$restore_config" --file restore/restore.sql
python3 tools/backup_restore.py verify --in restore/ --db DB --remote --config "$restore_config"
```

`restore-config` writes a config with only the new database's `DB` binding, the committed account and
this checkout's `migrations/` by absolute path; it has no Worker, so nothing can be deployed with it. It
refuses the production database's id or name, a path inside the repository and an existing file. Never
copy `wrangler.toml` for a restore: it is production, so its `database_id` is the live database (the
restore SQL would go into production), and its relative `migrations_dir` fails outside `todofy/`.

`download` checks every part against the manifest's SHA-256 and row counts, `sql` checks them again,
and `verify` compares the restored row counts with the manifest and checks that the backup's migration
is applied. `migrations apply` applies every migration in the current tree, which may be newer than the
backup; that is fine because migrations are additive and the restore SQL names its columns, and
`verify` then reports `PASS schema_version <backup's> (later migrations applied: ...)`. One caveat: a
later migration that rewrites existing rows (a backfill) does not run on rows restored after it. If one
exists, check out the commit whose newest migration matches the manifest's `schema_version`, apply
migrations and restore there, then apply the remaining migrations from the current tree.
`--no-legacy-text` (on all three commands) leaves the imported mail text out.

The `restore/` files hold mail content: keep them owner-only and delete them afterwards.

To switch production to the restored database (gateway-contract.md §6.5 explains why only one
coordinator may use a database at a time):

1. Set `TODOFY_MAINTENANCE_MODE=true` and run the workflow on `main`: the gateway refuses webhooks (Mail
   Hero retries) and owner writes, and the object stops ledger work. Mail that arrives from here on is
   held by Mail Hero, not lost.
2. Restore and `verify` as above until it prints `PASS`.
3. Commit the restored database's `database_id` (and `database_name` if it has another name) to
   `[[d1_databases]]` in `wrangler.toml` on `main`; that push checks and deploys Todofy. Its
   `migrations apply` finds every migration already applied.
4. Set `TODOFY_MAINTENANCE_MODE=false` and run the workflow on `main`. Mail Hero redelivers what it
   held during maintenance. Events Todofy acknowledged after the backup was taken are not in the
   restored database, and Mail Hero does not send an acknowledged event again: compare with Mail Hero's
   deliveries (or the old database, while it exists) before deciding whether any matter. Check the
   attention page: a row that was mid-step in the backup, if any, is recovered as after a crash
   (`summarizing` → `pending`, `todo_sending` → `todo_unknown` with a footer lookup, never a blind
   resend).
5. Keep the old database until the restored one has run for a while, then delete it
   (`npx wrangler d1 delete <old name>`) on purpose; it holds mail content too.

The object keeps its own state across the switch: budgets and tick times stay; the metrics cursor
notices the other database and restarts, so the switch day and the days back to the last written one
show "未记录" in the trends. The same happens after a D1 Time Travel restore in place.

## 8. GTD ledger and the morning-brief carryover (first rollout)

The release that adds [gtd-features.md](gtd-features.md) needs these owner steps; the rest is automatic.

1. Before merging: set the GitHub environment variable `TODOFY_GTD_REVIEW_ENABLED` to `false` (Settings →
   Environments → `production`). The deploy refuses to run without it, like every switch.
2. Optional, any time: create the Todoist projects "Ops" and "Review" by hand and store their IDs as the
   environment secrets `TODOFY_TODOIST_OPS_PROJECT_ID` and `TODOFY_TODOIST_REVIEW_PROJECT_ID` (the ID is the
   last part of the project's URL). Unset, both tasks go to the default project, as before.
3. Before merging, in the newsletter (separate repository): change its recommendation captions, which
   say "近 24 小时" (`source_label` and `_LIMITATIONS` in `src/newsletter/todofy.py`), to cover older
   still-open tasks, e.g. "近 24 小时 + 仍未完成的旧任务". Carried picks start their reason with
   "（N 天前）". Its `_decode_recommendation` already ignores the new `new_count` and `carryover_count`
   (checked at newsletter commit `28882c2`; the v1 schema itself has `additionalProperties: false`, so a
   strict schema validator would not).
4. Merge. The deploy applies migration `0004_gtd.sql` (additive: the previous release keeps working on it)
   and ships the code. The first snapshot is taken at the next 13:00 UTC; until then the recommendation is
   the plain 24 h report and the ops status has no GTD counters.
5. After a day: the owner UI's GTD page shows the first snapshot; `status()` carries `inbox_open`,
   `inbox_oldest_days`, `overdue`, `carryover_open` and `completed_7d`; the day's recommendation has
   `carryover_count` > 0 when older mail tasks are still open. Then set
   `TODOFY_GTD_REVIEW_ENABLED=true` and run the workflow on `main` (app `todofy`): the next Sunday at 17:00
   UTC creates the first review task.

Rollback: `REPORT_CARRYOVER_DAYS = "0"` (a commit) turns the carryover off; `GTD_COLLECT_UTC = "off"` (a
commit) stops the snapshot, and with it the carryover, the GTD counters, `review_age_days` and
`review_overdue` (a review's completion is only seen by the snapshot); `TODOFY_GTD_REVIEW_ENABLED=false`
(a variable) stops the review. A code
rollback keeps working on the migrated database; the four `gtd_*` tables then stop growing and are removed
by nothing (drop them by hand with `wrangler d1 execute --remote` only if the feature is abandoned).
