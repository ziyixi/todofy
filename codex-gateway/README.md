# Codex gateway

Private execution through `openai-codex==0.163.0` and its pinned runtime. The Cloudflare model router
uses the generated `modelrouter.inference.v1` contract; provider details stay in this executor.
The service uses the subscription login mounted at
`CODEX_HOME`; it checks the SDK account type and does not use an API key or another model.

`POST /api/model/v1/generations:generate` returns one final text or schema-constrained JSON result.
`models/sol-6-1` maps to `gpt-6.1-sol`; the local catalog lists the other fixed mappings. Requested public
model and provider-reported model are separate fields. The latter stays empty when the SDK does not
report it. There is no automatic fallback. Empty effort preserves the SDK model default; callers can
explicitly select a supported effort. Temperature and model-side output caps are rejected before execution.
Instruction blocks remain ordered; the subscription adapter accepts cache hints without claiming cache control.
JSON Schema validation runs locally without fetching external references.
The model API accepts a 3 MiB wire request and up to 2 MiB of decoded final output.
Legacy inference keeps its existing smaller limits.

Optional `/api/model/v1/conversations` contexts keep the same ephemeral SDK thread and temporary workspace
for multiple turns. Creation accepts a caller-assigned `conversations/{id}` and a UUID `request_id` query
parameter, following the generated HTTP binding. The default total lifetime is 840 seconds, with the same
maximum; further turns cannot extend it. Each generation defaults to 110 seconds and can request up to
840 seconds, bounded by the remaining context lifetime. Concurrent turns on one context are rejected.
Get reports liveness. Close interrupts active work and acknowledges only after SDK/process/workspace cleanup.
Content-free SQLite receipts preserve confirmed closure across restart; interrupted contexts become `lost`
and can then be closed. No SDK thread is resumed and no model operation is replayed after restart.

Generate and Create accept private `Accept: text/event-stream` transport so the router can wait through
long calls. The stream sends `ready`, a heartbeat every 15 seconds, then one `result` containing the generated
wire JSON response. A setup or context error after headers uses terminal `error` with the shared HTTP RPC
Status body. Without that Accept header the response is final JSON. This transport is private; the public
router API returns only the final result. Disconnect cancels execution.

The generated result includes actual hosted-web search/open observations and per-call usage. Thread token
snapshots are cumulative; subsequent calls subtract the previous trusted snapshot, including cached and
reasoning subsets. Missing baselines or invalid counters leave `available=false`. Output text cannot claim
an observed search or open. `web_research=true` enables hosted live web and its required code-mode host;
shell, local file tools, browser, desktop, plugins, apps, skills and MCP servers remain disabled.

## Legacy rollout endpoints

`POST /api/codex/v1/inference:run` uses the generated `codex.inference.v1` wire JSON contract.
The request carries `instructions`, `input_json`, `output_schema_json` and an optional explicit `model`.
An empty model uses `gpt-6.1-sol` with medium effort; there is no automatic model fallback. An inference response carries
the selected model and fixed effort, output JSON, reported token counts and a safe `error_code`. Model failures return
HTTP 200 with an empty output and one of `codex_auth`, `codex_quota`, `codex_timeout`,
`codex_unavailable` or `codex_bad_answer`. Transport/configuration errors use the shared RPC Status body.
Failures before a model turn identify only their stage: `codex_configuration`, `codex_startup`,
`codex_account` or `codex_skills`. Authentication, quota and timeout codes take precedence. These codes
never include vendor error text, local paths or request content.

`POST /api/codex/v1/inference:check` uses the same verified Access identity. It reads the existing
subscription login and one bounded model-catalog page, returning only model identifiers, supported
efforts and a pagination flag. It does not start a thread or model turn, and returns no account identity,
credentials, descriptions or cursor. A catalog entry does not prove that a model turn will succeed.

Every inference/control route requires one `Cf-Access-Jwt-Assertion`. The backend uses PyJWT to verify
RS256 signatures against the fixed issuer's cached JWKS, exact issuer/audience, expiry and issuance time.
It then requires the documented service-token claims (`type=app`, a nonempty `common_name`, empty `sub`).
A header's presence or a legacy Bearer value cannot authorize a direct localhost request.
See [Cloudflare's validation contract](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
and [service-token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).

The image bakes public issuer/audience from `config/cloud.toml` and `config/resources.toml` into
`build-info.json` beside the source SHA. They need no deployment secret or auth environment overrides.
The Router keeps the existing Access service identity for the dedicated Tunnel path; the gateway needs
no additional shared token. `/healthz` remains an unauthenticated, content-free local probe.

Configure `CODEX_HOME` as the existing login-only mount and `DATA_DIR` as the writable monitor directory
(`.data` for local runs). At process startup the
service creates a private temporary CLI home and links only the shared `auth.json` into it. SDK token refresh writes through that link; cache, skills and SQLite files stay out
of Newsletter's login directory. `SOURCE_SHA` is a Docker build argument baked into `build-info.json`; the release supplies
`CODEX_GATEWAY_RELEASE_REQUEST_ID` separately. Authentication runs before reading the request body.
The body is limited to 768 KiB and output to 64 KiB. Legacy operations stay capped at 110 seconds. There are no
saved jobs or automatic retries. One-shot requests have their own temporary workspace and ephemeral thread.
The app does not log request bodies, model output, credentials or vendor error text. Access logging is disabled.

The legacy runtime disables shell, browser, desktop, web, app/plugin, image, memory and multi-agent features.
It supplies no MCP servers, disables the pinned system skills and verifies that no skills are enabled
before starting a model turn. Any returned tool item rejects the answer. These checks do not claim
that the Codex protocol exposes a global empty tool-list option.

The launch helper supervises a dedicated process group, so terminating the SDK process also terminates
its hosted-tool descendants. On Linux a parent-death signal handles abrupt server-worker termination.
Run one server process per state directory; live contexts belong to that process. Container restarts use
the normal container process boundary. The synthetic Linux parent-death test runs only on Linux.

Build from the repository root after generating the root proto package:

```sh
node proto/tools/ensure.mjs
docker build -f codex-gateway/Dockerfile --build-arg SOURCE_SHA=<full-commit-sha> .
```

The image includes the Python packages and SDK runtime. No host Python or Node installation is needed.
`GET /healthz` returns `source_sha` from the baked file and the release request ID. An environment value
cannot replace the baked source identity. Local runs without a baked file report a null SHA, and the
request ID may be empty. This health check does not verify login, model access or inference.
The independent workload, TLS routing and login mount belong to deployment configuration.

## Monitor

Open [Codex inference in Home](https://home.ziyixi.science/#/ops/codex-gateway) for request counts,
successes/failures, reported tokens, latency, the installed SDK and the latest eight completed requests.
The internal health response includes the root-proto `InferenceStatus`; the existing five-minute host observer
forwards it through Fleet. Home retains its normal cached status reads and manual refresh. The page shows the
actual sample time, so a cached read does not look like a new observation.

Gateway persists one summary row per completion day in UTC, including completed request, success and failure
counts, reported-usage count, input/output tokens and total duration. A request that crosses midnight counts on
its completion day. Summaries and the latest eight request samples survive process or app recreation in
`DATA_DIR/inference-monitor.sqlite3`; deployment mounts an independent directory on the existing persistent
volume. The health response exposes the latest 30 recorded days, newest first. Stored day rows remain in SQLite.
`history_since` records when this database began observing requests. Earlier usage is unknown; upgrading does
not reconstruct lost process counters. Startup and writes require working storage and do not fall back to memory.

Both generated model calls and legacy calls update these counters. Samples use `default` when effort was
left to the SDK; the legacy top-level configured effort remains medium.
Only validated, authenticated inference requests count; health and metadata checks do not. HTTP 200 with a
nonempty `error_code` is a failed inference. Completed failures, including cancellation, count even when usage
is unavailable. An abrupt process termination before completion is not reconstructed. `usage_available` and the
reported-usage count distinguish reported zero from missing usage. The original top-level counts, token totals,
active work and latency fields still cover the current process lifetime and reset on restart. A sample's sequence
is assigned when its request starts within that process, so persisted samples can repeat a sequence after restart.
Samples contain only time, safe model identifiers, effort, duration, token counts and fixed errors. The database
contains no prompts, responses or account identity. These observations are not a billing ledger or account-wide
quota. Mailsort separately persists its own daily/monthly classification usage in its existing database.

Local synthetic checks:

```sh
cd codex-gateway
uv sync --locked
uv run --locked python -m unittest discover -s tests -v
uv run --locked ruff check src tests
uv run --locked ruff format --check src tests
```

Tests use a fake SDK, real synthetic RSA-signed JWTs, local JWKS fixtures, temporary SQLite files, an in-process ASGI client and synthetic sleeping processes.
They check two-turn reuse, usage deltas, web observations, JSON/SSE transport, expiry, timeout, cancellation,
restart receipts and cleanup acknowledgements. They do not log in or call a model.

The image smoke feeds `tests/image_probe.py` to the built container under `--network none`. It exercises
baked public policy and actual JWT verification with a synthetic JWKS and fake runner, verifies that an
unauthenticated localhost request fails before body reading, and never opens the provider login.
