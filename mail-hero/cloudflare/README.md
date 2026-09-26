# Mail Hero on Cloudflare

The application is `src/native/index.ts`, configured by **`wrangler.native.toml`**. It runs entirely on Workers Free with D1, a private R2 Standard bucket, one SQLite-backed Durable Object coordinator, Static Assets, and Access. A separate consumer such as Todofy may use its own server and Tunnel; its deployment is independent of this Worker.

## Runtime boundary

1. Email Routing invokes `email()` for the configured recipient. The handler validates the envelope and raw length, durably registers work, and awaits a streaming R2 write before returning. It must not parse MIME or buffer the full raw message in the ordinary Worker.
2. `MailCoordinator` uses SQLite-backed Durable Object storage to persist work and `alarm()` to perform bounded processing. The singleton name is `inbox-v1`. Alarms may run more than once; business state and idempotency remain explicit.
3. D1 contains metadata, settings, immutable endpoint revisions, delivery identities, attempts and UI action records. R2 contains original MIME, parsed content, decoded attachments and frozen webhook payloads. R2 and D1 do not share an atomic transaction; incomplete transitions must be repairable.
4. React Static Assets and the management API share one hostname. API authentication verifies owner Access JWTs; browser writes require CSRF protection. Raw files and attachments are streamed from private R2 only after authentication.
5. A webhook 2xx acknowledges the consumer's durable intake, not successful downstream business execution. Network retries preserve the event ID and bytes; the consumer must deduplicate.

The Cloudflare Email Routing limit is 25 MiB. This is an accepted raw-size ceiling, **not a claim that every 25 MiB MIME structure has passed real Free-plan parsing**. A failed parser must preserve the original and expose an actionable failure state. Ordinary Workers Free handlers have 10ms CPU; Durable Object invocations, including alarms, have a documented default 30-second CPU allowance. Both share the 128MB isolate memory limit, so attachment decoding and concurrent buffering need explicit bounds and real runtime validation. [Email limits](https://developers.cloudflare.com/email-service/platform/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

## Configuration

| Name | Type | Purpose |
| --- | --- | --- |
| `DB` | D1 binding | Business metadata and status database. Native migrations are in `cloudflare/migrations/`. |
| `MAIL_STORE` | private R2 binding | Raw and derived sensitive content. Standard storage; no public bucket URLs. |
| `COORDINATOR` | SQLite Durable Object binding | `MailCoordinator`, singleton `inbox-v1`; persistent scheduling and alarms. |
| `ASSETS` | Static Assets binding | Built React files in `../uiassets/dist`. |
| `RECEIVE_ADDRESS` | variable | One exact full recipient; no catch-all. |
| `ACCESS_ISSUER` | variable | `https://YOUR-TEAM.cloudflareaccess.com`. |
| `ACCESS_AUDIENCE` | variable | The UI Access application's audience. |
| `ACCESS_OWNER` | variable | Canonical owner email identity; used for CSRF and UI action ownership. |
| `ACCESS_OWNER_ALIASES` | optional variable | Comma-separated exact verified email aliases of the same owner. Each also needs a narrowly scoped Access policy; aliases do not bypass JWT verification. |
| `CREDENTIAL_KEY` | secret | 32 random bytes encoded as 64 hex characters; encrypts endpoint credentials and signs management tokens. Back it up independently. |
| `WEBHOOK_ALLOWED_HOSTS` | variable | Comma-separated exact public HTTPS destination hostnames. No arbitrary internal HTTP targets. |
| `FORCE_SEND_PAUSED` | variable | Start with `true`; overrides UI delivery controls. |
| `MAINTENANCE_MODE` | variable | Stop intake, management writes and background processing for a coordinated backup or restore. |
| `INGEST_DAILY_MESSAGE_LIMIT` | variable | Default `300` accepted intake reservations per UTC day. |
| `INGEST_DAILY_BYTE_LIMIT` | variable | Default `268435456` (256 MiB) raw bytes reserved per UTC day. |
| `DEV_AUTH_BYPASS` | local-only variable | Optional local development bypass; rejected on public requests. Never deploy it. |
| `ACCESS_SERVICE_ORIGIN` | optional variable | Exact HTTPS consumer origin whose Access application uses a service token. |
| `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET` | optional paired secrets | That consumer's Access service token, separate from webhook authentication. |

Do not add `[limits] cpu_ms = 30000` to the ordinary Free Worker to imitate Paid capacity. Heavy work belongs in the DO alarm. The coordinator uses a SQLite migration (`new_sqlite_classes`).

## Local checks

Use Node.js 26. From the repository root, build the UI with `npm --prefix web ci` and `npm --prefix web run build`. Then:

```sh
cd cloudflare
npm ci
npm run typecheck
npm test
npx wrangler d1 migrations apply mail-hero --local --config wrangler.native.toml
npx wrangler dev --config wrangler.native.toml --ip 127.0.0.1
```

Use a local `.dev.vars` containing a disposable `CREDENTIAL_KEY` and, if needed, `DEV_AUTH_BYPASS=true`; keep it untracked. Wrangler local D1, R2 and DO data are synthetic test state. Local success does not prove account-level Free quotas, Email Routing failure behavior, or real SMTP arrival.

For deployment and the budget/backup procedure, follow [the setup guide](../docs/cloudflare-setup.md). Formal releases use [GitHub Actions](../docs/ci-cd.md). Every Wrangler command should explicitly select its local or production configuration. Deployment needs an authorized account session; never put credentials in source or chat.

## Persistence and recovery

R2 is permanent content storage in this architecture, not a temporary buffer to delete after another server acknowledges. Initial raw keys use `raw/<uuid>.eml`; their metadata includes envelope, receive timestamp, expected size and intake policy snapshot. DO work and D1 records point to this durable source. Parsed content and attachment objects are separate; deletion must remove every content copy while preserving non-content event and deduplication records.

Default logical intake capacity is 5 GiB and default retention is disabled. Capacity is an application safeguard, not an account-wide billing cap or a measurement of every backup/orphan/derived object. Do not set blanket R2 lifecycle deletion rules on live mail objects. Alarms provide at-least-once retries, not unlimited guaranteed retries; application state must expose terminal failures. [Alarm semantics](https://developers.cloudflare.com/durable-objects/api/alarms/).

Daily intake protection reserves a message and its raw bytes atomically in the coordinator before writing R2, even when D1 is unavailable. Defaults are 300 messages and 256 MiB per UTC day; exceeding either budget temporarily fails intake. Upstream retry behavior still needs live validation. These guards limit this application's intake, not the account's bill. Body search indexes only the first 16 KiB of UTF-8 text; the full body remains in R2 and `search_index_truncated` tells the UI when the search index is incomplete.

Repeated parse crashes stop automatically after three interrupted runs, leaving the original for inspection and an explicit reparse. Maintenance runs in a separate alarm invocation to respect the Free D1 limit of 50 queries per invocation. Each batch handles at most one safely expired message and one pending content purge. Raw-object repair scans at most 100 keys per page. A remaining retention/purge backlog or another raw page schedules continuation about ten minutes later; after a completed scan with no work, maintenance returns to a daily wake. No content expires until the owner enables retention.

D1 Time Travel covers only D1. It does not restore R2 objects, Worker secrets or DO state. An independent backup must account for all of those relationships, and restored outbound events must stay paused until duplicates are reconciled. See the setup guide's maintenance-window procedure.
