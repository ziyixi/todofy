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

Put the printed `database_id` into the GitHub variable `TODOFY_D1_DATABASE_ID`. The schema is applied
by every deploy (`wrangler d1 migrations apply DB --remote`); do not apply it by hand.

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

The two owner secrets are secrets rather than variables because wrangler prints every plain var with its
value in the deploy log. The deploy passes them to the gateway `todofy` as Worker secrets
(`--secrets-file`); the core never sees them.

Environment variables (validated by `deploy/generate_ci_config.py`; a bad or missing one fails the
deploy and names only the variable):

| Variable | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | 32 hex |
| `TODOFY_D1_DATABASE_ID` | from step 1 |
| `TODOFY_D1_DATABASE_NAME` | optional, default `todofy` |
| `TODOFY_PUBLIC_HOST` | UI host, e.g. `todofy.ziyixi.science` |
| `TODOFY_HOOKS_HOSTS` | comma-separated machine hosts (at most 4), e.g. `todofy-hooks.ziyixi.science`; at cutover add `daily.ziyixi.science` |
| `TODOFY_MAIL_SOURCE_ID` | optional, default `mail-hero-personal`; must equal the source ID of the imported ledger |
| `TODOFY_ACCESS_ISSUER` | `https://<team>.cloudflareaccess.com` |
| `TODOFY_ACCESS_AUDIENCE` | AUD tag from step 2 |
| `TODOFY_TODOIST_DEFAULT_PROJECT_ID` | Todoist project for new tasks |
| `TODOFY_GEMINI_MODELS` | optional, comma-separated, first is preferred |
| `TODOFY_GEMINI_DAILY_TOKEN_BUDGET` | optional, default `3000000` |
| `TODOFY_REPORT_DEFAULT_TOP` | optional, default `10`; must equal the newsletter's `?top=` (10) so its report is precomputed |
| `TODOFY_REPORT_PRECOMPUTE_UTC` | optional, default `13:30` |
| `TODOFY_LOOKUP_DELAY_MS` | optional, default `120000` |
| `TODOFY_LEGACY_TEXT_RETENTION_DAYS` | optional, default `0` (keep imported mail text forever) |
| `TODOFY_REMINDER_ENABLED` | `true` / `false` (required) |
| `TODOFY_MAINTENANCE_MODE` | `true` / `false` (required); set on both Workers |
| `TODOFY_PROCESSING_PAUSED` | `true` / `false` (required) |
| `TODOFY_FORCE_PAUSE_TODOIST` | `true` / `false` (required) |

`BUILD_SHA`, the Gemini and Todoist base URLs and the routes are written by the generator, not set. The
generator gives each Worker only the vars it reads: hosts and `ACCESS_*` go to the gateway; the mail source,
Gemini, Todoist, report, retention and switch settings go to the core; `BUILD_SHA`, `MAINTENANCE_MODE`
and `TODOFY_PUBLIC_HOST` (the reminder links to the UI) go to both.

## 4. Worker secrets

Set from the owner's machine (`npx wrangler login` first), and again only to rotate. Each command
prompts for the value; nothing goes on the command line or into a file.

```sh
npx wrangler secret put <NAME> --name <WORKER>
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

Also on a fresh account (or after the `todofy` script was deleted), while `gateway/wrangler.toml` still
carries the cutover history (`v1` creating `TodofyCoordinator`, `v2` deleting it): remove both
`[[migrations]]` blocks before the first deploy. A script without a migration tag gets every step, and
the TypeScript gateway does not export that class. `--dry-run` cannot catch this; it never computes
migrations against the account. The blocks are meant to go once the production cutover has applied `v2`
([gateway-contract.md](gateway-contract.md) §6.4).

### Moving from the single Python Worker (once)

Before the split, one Python Worker `todofy` held every secret. The first deploy of the split:

1. Before merging it to `main`: put `GEMINI_API_KEY` and `TODOIST_API_KEY` on `todofy-core` as above
   (the same values as on `todofy`). Otherwise the new object would run the report precompute and any
   pending work without keys as soon as the gateway's cron wakes it.
2. The deploy applies D1 migrations, deploys `todofy-core` (creating the object class), then deploys the gateway
   over the Python `todofy` in place: its routes, the webhook, CSRF and report secrets and the owner
   secrets stay. Its migration `v2` deletes the old object and its counters (the day's Gemini token and
   call counts, the Todoist block time, report failure counts and tick times); rows the old object left
   mid-step are recovered by the new one without a blind Todoist resend. If the gateway deploy fails, the
   Python `todofy` keeps serving with its own object and the new object stays idle, so nothing runs twice.
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
3. Deploy the last pre-split commit with its migrations extended to `v1` new, `v2` deleted, `v3` new
   (`TodofyCore`), so wrangler sends only `v3`. Do not deploy a plain revert: wrangler does not
   refuse it, but sends `v1` again over the published `v2`, and Cloudflare's answer is unverified.
4. `npx wrangler delete --name todofy-core`.
5. `TODOFY_MAINTENANCE_MODE=false`, redeploy.

## 5. Hosts and callers

- Both hosts are Custom Domains of the gateway `todofy`, created by the deploy from the generated routes.
  `todofy-core` has no route, `workers.dev` or preview URL; only the gateway's binding reaches it.
- Mail Hero: its webhook host allowlist must include the hooks host, and its target posts to
  `https://<hooks host>/hooks/mail` with the Bearer token above.
- Newsletter: `https://<hooks host>/api/summary` and `/api/recommendation?top=10` with Basic.
- Cutover: `daily.ziyixi.science` (the old service's host, which Mail Hero's existing target and the
  newsletter already use) is added to `TODOFY_HOOKS_HOSTS` after the old Tunnel public hostname and its
  DNS record are removed; the Custom Domain cannot be created while another record holds the name
  (inferred from Cloudflare's Custom Domain rules; confirm during the cutover). The digests above must
  then be those of the credentials those callers already send.

## 6. Local checks before the first deploy

```sh
# with the variables and secrets exported; prints names only. GITHUB_SHA (40 hex, set by Actions)
# becomes BUILD_SHA, so export it locally too. Build the UI first (npm run build --prefix web).
GITHUB_SHA=$(git rev-parse HEAD) uv run python deploy/generate_ci_config.py
uv run pywrangler deploy --dry-run --config wrangler.production.ci.json
npx --no-install wrangler deploy --dry-run --config gateway/wrangler.production.ci.json \
  --secrets-file gateway/wrangler.production.secrets.json
rm -f wrangler.production.ci.json gateway/wrangler.production.ci.json gateway/wrangler.production.secrets.json
```

The generator writes the core config next to the root `wrangler.toml` (pywrangler needs it beside
`python_modules/`) and the gateway config and secrets file into `gateway/`. All three are gitignored and
created owner-only (0600).
