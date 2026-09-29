# Cloudflare setup (one-time bootstrap)

What the owner sets up once before the first deploy. Everything after that goes through GitHub Actions
([ci-cd.md](ci-cd.md)). This file names settings and how to derive them; it never holds values. The
repository and its Actions logs are public, so no secret, owner email or database content belongs in it.

Plan: Workers Free. Nothing here needs a paid product. The Worker, D1 and Durable Object requests share
the account's free daily allowances with Mail Hero.

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
| `CF_API_TOKEN` | Cloudflare API token: Workers Scripts edit, D1 edit, zone Workers Routes / Custom Domains and DNS edit for the zone, account settings read. No billing permissions. |
| `TODOFY_ACCESS_OWNER` | the owner's primary Access email |
| `TODOFY_ACCESS_OWNER_ALIASES` | comma-separated other logins of the owner (may be empty) |

The two owner secrets are secrets rather than variables because wrangler prints every plain var with its
value in the deploy log. The deploy passes them to the Worker as Worker secrets (`--secrets-file`).

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
| `TODOFY_MAINTENANCE_MODE` | `true` / `false` (required) |
| `TODOFY_PROCESSING_PAUSED` | `true` / `false` (required) |
| `TODOFY_FORCE_PAUSE_TODOIST` | `true` / `false` (required) |

`BUILD_SHA`, the Gemini and Todoist base URLs and the routes are written by the generator, not set.

## 4. Worker secrets

Set once from the owner's machine after the first deploy has created the Worker (`todofy`), and again
only to rotate. Each command prompts for the value; nothing goes on the command line or into a file.

```sh
npx wrangler secret put <NAME> --name todofy
```

| Secret | How to derive it |
|---|---|
| `MAIL_WEBHOOK_TOKEN_SHA256` | lowercase hex SHA-256 of the Bearer token Mail Hero's target sends: `printf '%s' "$TOKEN" \| shasum -a 256`. The token itself stays in Mail Hero and the password manager. |
| `MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS` | optional, the previous digest while rotating the token |
| `REPORT_BASIC_AUTH_SHA256` | SHA-256 of `user:password` the newsletter sends (`printf '%s' "$USER:$PASSWORD" \| shasum -a 256`); list two digests, comma-separated, while rotating. The password must be random, at least 128 bits (`openssl rand -hex 32`): the failure lockout never blocks a correct credential, so it does not slow guessing. |
| `GEMINI_API_KEY` | a Gemini API key for this Worker |
| `TODOIST_API_KEY` | a Todoist API token |
| `CSRF_SIGNING_KEY` | 64 hex, `openssl rand -hex 32` |

Until a secret is set, the endpoint that needs it answers 503 `not_configured` (the webhook, the
newsletter endpoints, or owner writes). `ACCESS_OWNER` and `ACCESS_OWNER_ALIASES` are also Worker
secrets, but every deploy sets them from the GitHub environment secrets; do not `secret put` them.

## 5. Hosts and callers

- Both hosts are Custom Domains of the Worker, created by the deploy from the generated routes.
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
# becomes BUILD_SHA, so export it locally too.
GITHUB_SHA=$(git rev-parse HEAD) uv run python deploy/generate_ci_config.py
uv run pywrangler deploy --dry-run --config wrangler.production.ci.json \
  --secrets-file wrangler.production.secrets.json
rm -f wrangler.production.ci.json wrangler.production.secrets.json
```

Both generated files are gitignored and created owner-only (0600).
