# Model Router deployment

The private console is `https://models.<zone>/`. The sole production config is
[`../wrangler.toml`](../wrangler.toml); its domain, account, Access audience and D1 UUID come from the
normal public cloud profile and resource export. `workers.dev` and preview URLs stay disabled.

The Worker owns D1 request metadata, the private `model-router-request-bodies` R2 bucket, one SQLite
`RouterEngine`, the Workers AI binding and its static console. The daily `04:47 UTC` trigger performs
bounded cleanup. Request bodies expire after seven days; metadata expires after ninety days. The new
bucket also has an independent seven-day object lifecycle, including orphaned bodies. Existing mail,
archive, backup and infrastructure-state buckets retain their own retention rules.

## Provisioning

Use the existing additive bootstrap documented in
[`tools/cloud-bootstrap/README.md`](../../tools/cloud-bootstrap/README.md#向现有账户新增应用), reusing the
existing protected private input, original encrypted-state passphrase and exact owner policy values.
Its `create_addresses` must name only:

```json
[
  "cloudflare_d1_database.app[\"model-router\"]",
  "cloudflare_r2_bucket.app[\"model-router-request-bodies\"]",
  "cloudflare_r2_bucket_lifecycle.model_router_request_bodies",
  "cloudflare_zero_trust_access_application.owner[\"model-router\"]",
  "cloudflare_zero_trust_access_policy.model_router_inference",
  "cloudflare_zero_trust_access_application.model_router_inference"
]
```

Run from the repository root:

```sh
python3 tools/cloud-bootstrap/bootstrap.py plan --mode extend --private-file <protected-private-file>
python3 tools/cloud-bootstrap/bootstrap.py cloud --mode extend --private-file <same-private-file>
```

Review the create-only plan before the second command. The existing gate rejects updates, replacements
or deletions of any existing resource, and the driver backs up the encrypted remote state before writes.
The exporter records actual D1/Access identities and regenerates the public configuration. Empty
bootstrap identity slots cannot pass the real release wrapper. No generated fake UUID or audience is
used for deployment.

After identities and the owner secret map are ready, remove `model-router` from the classifier's
`CHECK_ONLY` set. The existing one-target Codex gateway release precedes Router. Router then precedes the paired VPS/Newsletter
release, the migrated Mailsort, Todofy and Brief Workers, and Home. This ordering keeps both executor
and Router available before the migrated callers start.
After its first verified deployment, record the actual `RouterEngine` namespace as
`model-router-engine` in `config/resources.toml`, remove the `FIRST_DEPLOY_PENDING` exception in the same change. The ready Router already participates
in the normal reconcile matrix; its first main publication completes before that revision is reconciled.

## Authentication and credentials

Owner UI, request history, usage and session endpoints stay behind owner Access. A separate Bypass
application covers only ModelService's model catalog, generation, embedding and short-conversation
paths. The Worker still authenticates every call: an owner Access assertion or the exact Newsletter
Bearer token. The Bypass application grants no request-history or owner-console access.

Cloudflare callers bind the named `Inference` entrypoint with immutable `props.app` identifying
`mailsort`, `todofy` or `brief`. Request fields cannot choose the calling app. Home binds the separate
`Ops` entrypoint, which reports content-free status and has no guard capability.

`MODEL_ROUTER_WORKER_SECRETS` in the protected GitHub production environment contains only
`ACCESS_OWNER` and optional `ACCESS_OWNER_ALIASES`. Owner JSON mutations require the exact console Origin,
`X-CSRF-Token: 1` and `application/json` before body parsing. `/api/session` temporarily returns static `1` for
cached clients, without a cookie or signing key.

Migrated callers no longer declare provider or executor credentials. New bootstrap input rejects those retired
caller keys. Older Todofy Core GitHub maps may retain `GEMINI_API_KEY`; deploy parsers drop that exact field before
validation and never upload it. Release preflight separately tolerates the old live bindings until the owner
removes them after verified cutover. Gmail grants and Brief's Resend key remain with their applications.

Provider credentials are owner-machine secrets, excluded from GitHub maps and preserved by deployment:

- `ANTHROPIC_API_KEY` is the existing Brief workspace key, shared by every Claude caller and the
  Playground. All Claude calls together use that workspace's existing $80/month provider cap. Mailsort,
  Todofy and Brief keep their current business budgets and usage history; there are no per-app keys or
  workspace selectors.
- `GEMINI_API_KEY` is the one shared Gemini key. Both provider keys live only in Router secrets, never
  GitHub, client applications or the VPS.
- `CODEX_ACCESS_CLIENT_ID` and `CODEX_ACCESS_CLIENT_SECRET` supply the existing Cloudflare Access machine
  identity for the VPS executor. The executor verifies its Access JWT; no additional executor Bearer
  token is configured. Its public origin derives from the cloud profile. There is no new VPS service.
- `MODEL_ROUTER_NEWSLETTER_TOKEN` is the Router's independent external caller credential; Newsletter uses
  the corresponding `NEWSLETTER_MODEL_ROUTER_TOKEN` and `NEWSLETTER_MODEL_ROUTER_URL` in its own protected
  runtime configuration.

The Playground uses the same shared provider connections. Its recorded source is always `console`;
running inference does not invoke an application's business actions. Request and usage filters still
separate authenticated sources, independently of the shared provider billing account.

## Checks and release

The `Model Router checks` job runs deployment-boundary tests, Worker lint/types/synthetic tests, console
lint/types/tests/build and a production-config dry run. No check reads credentials or private bodies.
The pinned provider schema validates the lifecycle; its `max_age` is expressed in seconds. See
[provider 5.25.0 lifecycle schema](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v5.25.0/docs/resources/r2_bucket_lifecycle.md).

After the complete same-SHA gate passes, the reusable Worker release builds the checked console,
validates the bundle, runs the existing hostname guard, applies compatible D1 migrations and publishes
the Worker. Provider identity, pending migrations and anonymous owner-Access probes are verified before
recording success. The matching `Personal cloud reconcile` must also pass. Deployment, synthetic model
acceptance and each application's business acceptance remain separate checks.

On the first publication, Router uploads before its owner-machine connection secrets can be installed.
The release then fails its connection-name gate and leaves migrated callers skipped. After the owner
installs every declared connection secret, rerun the same SHA. The gate also runs when preflight selects
no upload. It reads secret names only; provider access and model execution require separate acceptance.
