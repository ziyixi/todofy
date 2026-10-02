# Provider compatibility is not covered by fixture tests

CI checks contracts, security boundaries, degraded publication, usage accounting,
rendering/MIME, installed wheel resources, and the native Linux/amd64 image.
Its actual Codex startup smoke uses no login and makes no model requests. Passing
CI therefore does **not** establish that the live provider accepts every output
schema, has allowance, can reach sources, or produces a useful newsletter.

The startup schema catalog check and the per-call dynamic-schema check reject
unsupported keywords before any provider request. For example, `uniqueItems`
belongs to general JSON Schema but was rejected by the live Codex output endpoint.
Uniqueness/deduplication still belongs to the application; removing an unsupported
generation constraint must not remove content validation.

## Explicit post-deployment schema smoke

Keep the external trigger stopped while a release is being verified. After the
new service is healthy, run in its existing isolated runtime:

```sh
docker compose exec -T newsletter python -m newsletter.schema_smoke --allow-model-calls
```

This is an explicit allowance-spending diagnostic, not part of routine startup
or public CI. It makes four sequential minimal requests against the configured
model with the production brief/deep/repair/review schemas. It asks for empty
diagnostic envelopes, never synthetic newsletter articles. It does not access
the service database, Notion, Todofy, or Resend, and cannot send an email. It stops
on the first failure, reports only a safe error category, and closes each
temporary workspace. Its successful output includes provider-reported token
usage; these diagnostic tokens are separate from any issue's usage ledger.

Then perform a real content run, inspect the frozen preview and coverage receipts,
verify an independently reviewed chart when one exists, and test mail only with
explicit recipient authorization. Schema acceptance does not establish factual
quality, source availability, category coverage, image rendering in a particular
mail client, or inbox delivery. Do not silently replace a failed real content run
with fixtures or bypass an ambiguous send receipt.
