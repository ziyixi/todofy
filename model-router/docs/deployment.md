# Model Router deployment

Production is declared in [wrangler.toml](../wrangler.toml), generated from the existing public cloud/resource
configuration. The private console is behind owner Access; `workers.dev` and preview URLs are disabled.

## Resources and connections

Router owns its request-history D1, private request-body and backup buckets, one SQLite `RouterEngine`, Workers AI
and static console assets. Create/adopt resources through the existing [bootstrap](../../tools/cloud-bootstrap/README.md),
then publish their generated identities. Do not hand-edit provider resources to bypass the infrastructure gate.

The protected GitHub Worker map contains only owner identity inputs. The connections declared in [app.toml](../app.toml)
remain Router secrets and survive normal publication:

- One `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` and `OPENAI_API_KEY`, shared by every caller.
- Executor Access client identity for the existing private Codex endpoint.
- Newsletter's inference-only credential; it may use Codex models, not other providers or embeddings.

Application bindings use immutable `props.app`; request JSON cannot choose caller identity. Home binds the
content-free Ops API. Owner mutations validate Access, Origin, CSRF header and JSON before reading the body.
Backups contain no connection credentials or SDK state.

`OPENAI_MONTHLY_LIMIT_USD` stops new API calls at the known UTC-month estimate. Unknown usage and in-flight calls
can differ from this total; it is not a supplier invoice hard cap. See [design](design.md).

## Check and publish

```sh
bazel test //model-router:check
bazel build //model-router
```

The check closure includes Worker/UI types and tests, real workerd flows, backup/restore, deploy-wrapper checks and
original bundle limits. Tests use synthetic providers and read no production request body or provider key.

Publish through root Actions after the same SHA passes CI. The publisher stages the checked compiled archive,
validates its config and hostname, applies existing migrations and uploads with `--no-bundle`. Operational variables
still go through the existing wrapper; a bare Wrangler deploy can erase them and must not be used.

The Codex gateway releases before Router, and Router before its callers. The connection-name gate checks declared
secret names even when preflight needs no upload. It does not prove credential validity or model inference.

For a coordinated interface change, let active turns settle, use the existing explicit maintenance switch, publish
executor/Router/callers in order and restore the switch through Actions. Maintenance rejects new Generate, Embed and
Create calls; catalog, context cleanup, history and backups remain available. Business pause/archive settings do not
change with transport deployment.

Require actual provider identity, no pending migration, Access probes and the matching Personal cloud reconcile.
An upload, completed backup and successful model/business call remain separate evidence.
