# Gateway contract: `todofy` ↔ `todofy-core`

The TypeScript gateway owns HTTP/authentication/assets and cron. The private Python Worker hosts `TodofyCore`, the
single ledger writer. Model invocation goes through Model Router; task creation belongs to Tasks. Current public
messages/routes are defined in root proto; this document describes the internal boundary and behavior around it.

## 1. Ownership and configuration

| Gateway `todofy` | Python core `todofy-core` |
| --- | --- |
| Owner/hooks hosts, Access, CSRF, machine credentials, assets, cron | No public routes; one SQLite-backed `TodofyCore`, instance `inbox-v1` |
| `COORDINATOR`, `ASSETS`, Analytics Engine | D1 `DB`, private backup R2, Model Router service binding, Analytics Engine |
| Owner identity and machine credential digests | No provider key or task-service credential |
| No D1 access | All ledger/model/scheduling work |

The production configs are `gateway/wrangler.toml` and `wrangler.toml`. Read actual variable/binding lists there;
there is no second configuration table here. Root workspace locks own dependencies. Bazel packages the Python SDK
from the existing Worker `pylock.toml` contract and both compiled Workers with the UI.

`BUILD_SHA` and maintenance settings reach both Workers through the existing deploy wrapper. The core also receives
processing pause. Provider secrets remain only in Router. The gateway never binds or queries D1.

## 2. Public routing and authentication

Unknown hosts and paths return 404 without a DO call. Hosts are matched lowercase, owner host first. A body rejected
from its headers is cancelled; a body forwarded to the core/assets is not consumed twice.

### 2.1 Hooks hosts

- `GET /health` reports the gateway build without calling the DO.
- `POST /hooks/mail` checks configured Bearer digest, credential, maintenance, JSON media type and declared size,
  then forwards the unread stream to `ingest`. The core enforces the actual 1 MiB limit, including chunked bodies.
- `GET /api/summary` and `/api/recommendation` validate Basic authentication before `newsletter`.
- Other methods/paths return 404. Hooks hosts must not redirect to owner Access.

Bearer uses the configured current/optional previous SHA-256 digests. Basic uses its comma-separated digest set.
Comparisons are constant-time; correct credentials never touch failure counters. A failed Basic check calls
`newsletter_auth_failure`: at most twenty failures are counted per UTC hour, then 429 with the next-hour retry time.
The gateway remembers that locked hour per isolate. Dependency failure while counting is 503; successful callers
cannot be locked out by failed attempts from someone else.

Machine errors use the existing `{error:{code,message,request_id}}` envelope and no-store JSON headers. Successful
core JSON is passed through byte-for-byte. Expected statuses and schemas are in `api/machine-api-v1.openapi.yaml`.

### 2.2 Owner host

The gateway verifies Access for assets and API requests, then the shared transcoder serves `todofy.ui.v1`. Before any
mutation body is read, it checks exact Origin, a nonempty bounded `X-CSRF-Token` and JSON media type, then maintenance.
Clients send `X-CSRF-Token: 1`; no signing secret or CSRF cookie exists.

Todofy's [edge-auth policy](../../packages/edge-auth/SPEC.md) uses ASCII case-insensitive owner/aliases, sixty-second
`nbf` leeway, header or last `CF_Authorization` cookie, one-hour JWKS cache and bounded unknown-key refresh. Local
bypass requires an explicit local flag/host and does not bypass a real Cloudflare request. Shared verification and
private-header rules are owned by that package; they are not reimplemented here.

Owner errors use `google.rpc.Status` with reason, request identity and localized message. Unknown API paths return
404 and known paths with the wrong method return 405. Unexpected core code/codec failures are INTERNAL; dependency
failures are UNAVAILABLE. Retry requires the original request identity where the method declares one.

All owner responses carry the private headers/CSP. Only successful non-HTML hashed assets under `/assets/` get the
long private immutable cache policy; SPA HTML and missing assets keep no-store.

### 2.3 Compatibility

The old owner routes and static `/api/csrf` reply remain for their dated window in
[history](../../docs/history.md#owner-api-compatibility). Keep the core's old `owner_api` until that gateway window
closes; it is not a current client API. Do not remove these routes early during build/doc cleanup.

`/task/<id>` redirects a valid task identifier to the configured Tasks URL without a DO call. The private Mail API
has no public host route; its binding/access is described in [mail-api.md](mail-api.md).

## 3. Internal RPC

`gateway/src/coordinator.ts` and `worker/todofy/runtime/coordinator.py` are the concrete pair. The gateway obtains
`COORDINATOR.getByName("inbox-v1")`. Client credential/cookie/owner headers are not forwarded; canonical owner identity
is an argument produced by gateway authentication. The object's normal `fetch` returns 404.

Expected failures are values because a Python exception loses structured attributes across JS RPC. A machine
`CoreResult` is:

```text
{status, body: string|null, error: {code,message}|null, retry_after: int|null}
```

A successful body is the core's serialized JSON, a 204 has no body, and the gateway builds error envelopes with its
own request ID. A failed RPC call itself becomes UNAVAILABLE. Logs contain identifiers, status and safe reason/type,
never credential, subject, body or model content.

| Method | Responsibility |
| --- | --- |
| `ingest(idempotency_key, unread_body)` | Validate/store a frozen Mail Hero event; 204 for accepted/identical bytes, 409 for identity conflict |
| `wake()` | Run the alarm loop from cron; exceptions fail the scheduled invocation |
| `newsletter(kind, query)` | Serve valid precomputed data or bounded on-demand computation; maintain existing report budgets |
| `newsletter_auth_failure()` | Count failed Basic credentials and return 401/429 |
| `owner_ui(owner, method, request_json, cursor_json)` | Strictly decode and execute one current owner RPC |
| `setup()` | Content-free configured facts for owner integration status |
| `mail(method, request_json)` | One private `todofy.mail.v1` request |
| `ops_status`, `ops_set_guard`, `ops_canary_result` | Content-free ops-v1 status/guard/canary contract |

`owner_ui` returns wire JSON in `{ok,next_cursor}` or `{error,detail,retry_after}`. The gateway passes successful bytes
through except list pages, where it adds the opaque page token. Page tokens are bound to the original filters.
Owner mutations use their existing etag/request-ID receipts. Maintenance and a backup's ledger hold refuse writes
without bypassing those rules.

Mail returns `{ok:wire_json}` or `{error,retry_after}`. The entrypoint's immutable read/write access is checked before
body parsing. Tasks creates its own deterministic task, then marks mail converted; Todofy performs no task write.

Ops returns `{ok:value}` or its bounded contract error. Home uses only its same-account binding. Guarding optional
backup/retention/metrics work does not stop ingestion, summaries, canaries or report processing. The protocol and
producer-specific signals are in [ops-v1](../../contracts/ops-v1/README.md).

Python exposes methods on its class across RPC, including helpers; only the gateway binds that class. The TypeScript
interface is kept in step with the Python implementation and exercised by real paired runtime tests.

## 4. Storage and lifecycle

One coordinator writes each D1 ledger. Two coordinators against the same database would treat each other's in-flight
work as interrupted and could repeat calls. Maintain this invariant during restore, revert and replacement.

Mail ingestion freezes event identity/bytes; retries do not reinterpret them. Summaries remain until the owner
explicitly deletes them. Converted/deleted mail leaves its event ledger for deduplication. A crash recovers an
interrupted summary according to the existing bounded state machine, not a blind external side-effect replay.

The private R2 backup contains D1 data, not provider keys or DO runtime context. Restore into a new empty database,
verify it and change bindings under maintenance using [setup/recovery](cloudflare-setup.md#7-backups-and-restore).

## 5. Publication and migration history

Only Actions publishes a checked source. It stages the compiled archive, runs hostname guards, applies D1 migrations,
deploys core before gateway and performs provider/machine/Access checks. The matching main reconcile is required.
A core change must serve the previous gateway until the new gateway is live; a breaking internal method removal
needs a compatible staged release. See [CI/CD](ci-cd.md).

Published DO migration tags are storage history. Core `v2` renamed `TodofyCoordinator` to `TodofyCore`; gateway `v2`
deleted its retired coordinator. Keep those tags on reverts and do not restore an old coordinator export. A fresh
account's complete migration path is a separate rebuild exercise; local dry-run does not prove provider acceptance.
The old single-Python-Worker cutover/rollback procedures are historical, available in Git, and are not current runbooks.

## 6. Tests and local development

```sh
bazel test //todofy:check
bazel test //todofy/tests/runtime:runtime_tests --local_test_jobs=1
bazel test //todofy/gateway:check
```

The original paired workerd scenarios exercise real core/gateway/Tasks bindings, local D1/DO, alarms, routing, Access,
stream limits, crash recovery and assets. They use declared Node/workerd/Pyodide/SDK/UI inputs and synthetic upstreams.
A skipped runtime case fails its target. CPU tests keep their calibrated budgets and fresh isolates; production
responses remain pre-encoded to avoid decoding large reports or legacy text again.

Interactive local development keeps the original local-only configs and host pinning described in
[developer notes](dev-notes.md). It does not publish production configuration. Old experiments and microbenchmark
measurements remain in Git/dated [verification](verification.md); source tests own current limits.
