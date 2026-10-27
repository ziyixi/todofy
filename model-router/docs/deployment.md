# Model Router deployment

The private console uses the configured Models host. The production config is
[`../wrangler.toml`](../wrangler.toml); account, domain, Access audience, D1 and namespace identities come from
`config/cloud.toml` and `config/resources.toml`. `workers.dev` and preview URLs remain disabled.

The Worker owns the request-history D1 database, private `REQUEST_BODIES` and `BACKUPS` buckets, one SQLite
`RouterEngine`, Workers AI and the console assets. Metadata is retained for ninety days and live request bodies
for seven days. The existing daily `04:47 UTC` trigger starts bounded cleanup and backup work; the engine Alarm
copies completed history and retained bodies into one dated snapshot. Daily snapshots have seven-day retention
in the backup bucket, so copied bodies can remain for roughly fourteen days from their original creation.
Provider credentials, SDK state and live contexts are excluded. See [backup and restore](backup.md).

## Resources

Provision resources through the existing [additive bootstrap](../../tools/cloud-bootstrap/README.md#向现有账户新增应用),
using the protected private input, original encrypted-state passphrase and existing owner policy values.
The Router's original resources and namespace are registered. Adding its backup storage needs only these
create addresses:

```json
[
  "cloudflare_r2_bucket.app[\"model-router-backups\"]",
  "cloudflare_r2_bucket_lifecycle.model_router_backups"
]
```

From the repository root:

```sh
python3 tools/cloud-bootstrap/bootstrap.py plan --mode extend --private-file <protected-private-file>
python3 tools/cloud-bootstrap/bootstrap.py cloud --mode extend --private-file <same-private-file>
```

Review the create-only plan before the second command. The existing bootstrap gate rejects updates,
replacements and deletions of existing resources, and backs up the encrypted remote state before writing.
The exporter records public resource identities and regenerates configuration. The backup bucket and live body
bucket each expire their own objects after seven days; existing mail, archive, backup and infrastructure-state
buckets retain their policies.

## Invocation and credentials

All applications use the root `modelrouter.inference.v1` types and shared clients. Model IDs are native provider
IDs. Generate has flat invocation options and returns one final result; it exposes no public token stream,
provider payload or caller-chosen execution identity. Newsletter alone uses the bounded Codex context:
Create, up to two Generate calls on the same SDK thread, then Close with an empty cleanup acknowledgement.
Owner request history and usage use the separate console API in `console.proto`.

Owner UI, request history and usage stay behind owner Access. A narrow Bypass application
covers only ModelService's catalog, generation, embedding and context paths. The Worker authenticates each call
with the owner Access assertion or exact Newsletter token. Owner JSON mutations require exact Origin,
`X-CSRF-Token: 1` and `application/json` before body parsing. The Newsletter token reaches only Codex models:
other providers and embeddings answer `PERMISSION_DENIED` with `MODEL_NOT_ALLOWED` before a request is recorded,
so synthetic Claude, Gemini and embedding checks use the owner's Access identity.

Cloudflare callers use the `Inference` binding with immutable `props.app` naming `mailsort`, `todofy` or `brief`.
Home binds the content-free `Ops` entrypoint. Application request fields cannot choose either identity.

`MODEL_ROUTER_WORKER_SECRETS` in GitHub's protected production environment contains only `ACCESS_OWNER` and
optional `ACCESS_OWNER_ALIASES`. The following owner-machine connections are installed directly in Router
secrets and preserved by normal publication:

- `ANTHROPIC_API_KEY`: one shared key in the existing Claude workspace, including Playground use, under the
  owner's configured US$80/month workspace cap. Application budgets and history remain in their applications.
- `GEMINI_API_KEY`: the shared Gemini key.
- `CODEX_ACCESS_CLIENT_ID` and `CODEX_ACCESS_CLIENT_SECRET`: the existing dedicated Access identity for the VPS
  executor. The backend verifies Access JWTs. Its public issuer/audience are baked into the gateway image.
- `MODEL_ROUTER_NEWSLETTER_TOKEN`: Newsletter's inference-only credential. Its VPS configuration uses the same
  value as `NEWSLETTER_MODEL_ROUTER_TOKEN`, with `NEWSLETTER_MODEL_ROUTER_URL` naming the Models origin.

Provider keys stay only in Router secrets. Backups do not export any credentials. The gateway keeps its existing
subscription login/PVC; privileged Platform deployment authentication remains separate. Gmail grants and Brief's
Resend connection stay with their applications. Playground calls record source `console` and perform no application
business action.

## Checks and coordinated release

`Model Router checks` runs deployment-boundary checks, Worker lint/types/synthetic tests, backup/restore tests,
console tests/build and a production-config dry run. Gateway checks use synthetic JWTs, a fake SDK and offline
process tests; Linux CI also verifies image imports and parent-death cleanup. These checks do not read provider
keys or private request bodies. Lifecycle ages use seconds with the pinned provider's
[lifecycle schema](https://github.com/cloudflare/terraform-provider-cloudflare/blob/v5.25.0/docs/resources/r2_bucket_lifecycle.md).

`BUILD_SHA` and `MAINTENANCE_MODE` are injected by the normal release wrapper. Set the explicit GitHub production
variable `MODEL_ROUTER_MAINTENANCE_MODE` to `true` or `false`; publication rejects a missing value. Use the normal
Actions path so the deployed maintenance value is preserved.

For a coordinated invocation-schema change, allow current calls and contexts to settle before enabling
maintenance. While enabled, Generate, Embed and CreateConversation return `MODEL_MAINTENANCE`.
The read-only model catalog and CloseConversation remain available for Newsletter startup and cleanup.
Owner history and backup work
remain available. Keep maintenance enabled while the executor, Router and callers move to the same checked
contract. This does not change application pause/archive modes or release their queued business work.

The existing release order is gateway, Router, then migrated Workers and the paired VPS/Newsletter release.
After the complete same-SHA gate passes, the reusable Worker release builds the checked console, validates the
bundle and hostname, applies the D1 migrations and publishes. Its connection-name gate also runs when preflight
selects no upload; it checks names, and does not prove that credentials or inference work. A fresh installation
can upload Router first, install its declared connections through the owner flow, then rerun the same SHA.

After all callers use the new contract, publish the explicit maintenance-off value and perform the authorized
synthetic model and application checks. Verify provider identity, pending migrations and anonymous Access
probes, then require the matching main `Personal cloud reconcile` with resolved infrastructure drift.
Deployment, backup completion, model inference, application business success and cloud restore remain separate evidence.
