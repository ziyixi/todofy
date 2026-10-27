# Codex gateway

The private executor runs only `gpt-6.1-sol` through `openai-codex==0.163.0` and the matching bundled CLI.
It uses the existing subscription login at `CODEX_HOME`; there is no provider API key or model fallback.
Provider details stay here. Applications call the Router's generated `modelrouter.inference.v1` API.

## Execution API

The existing Tunnel reaches `/api/codex/v1/model/*`. The equivalent `/api/model/v1/*` paths work locally;
both decode the same generated request types.

- `GET .../models` returns the one native model and supported efforts without starting the SDK.
- `POST .../generations:generate` takes flat model, input, instruction blocks, effort and optional JSON Schema.
  It returns one final Generation with a server-generated request name, model, output, usage, actual web
  observations and a safe error when execution fails. Empty effort preserves the SDK model default.
  A nonzero output-token cap is unsupported. `allow_fallback` permits no alternate model here.
- `POST .../conversations` opens Newsletter's context using its caller-chosen `conversations/{UUID}` name,
  model, instructions, effort, schema, web-research switch and total timeout. Success returns `{}`.
- `POST .../conversations/{UUID}:close` returns `{}` only after SDK/process/workspace cleanup completes.
  Repeated close of an absent context succeeds. Cleanup failure returns a safe unavailable error.

A context turn supplies `conversation` and `input`, without replacement model/options. The same ephemeral SDK
thread handles both turns. Contexts live only in the process, expire after at most 840 seconds, and are never
resumed after restart. There is no context database, request deduplication, operation UUID or replay mechanism.
A duplicate active context name is rejected. The retired `codex.inference.v1` package and its run/check routes
have no consumers. Home continues to use the separate `codex.monitor.v1` contract.

Each generation defaults to 110 seconds and can request up to 840 seconds, bounded by the remaining context
lifetime. Concurrent operations on one context are rejected. Close can cancel an active turn or pending setup,
then waits for cleanup. Standalone generations also use a temporary workspace and ephemeral SDK thread.
The transport accepts at most 3 MiB of request JSON and 2 MiB of final output. JSON Schema validation fetches no
external references. Ordered instruction blocks are joined in order; cache hints do not promise cache control.

Generate and Create accept private `Accept: text/event-stream` transport to keep the Tunnel connection alive.
It sends `ready`, a heartbeat every 15 seconds and one `result`; setup failures after headers use a terminal
`error` containing the shared RPC Status body. Create's result is `{}`. Without that Accept header the response
is final JSON. This transport stays between Router and executor; applications receive only the final result.
Disconnect cancels the operation and waits for cleanup.

`web_research=true` is available only when creating a context. It enables hosted live web and its required
code-mode host. Search/open observations come from completed SDK events; output text cannot manufacture them.
Shell, local file tools, browser, desktop, apps, plugins, skills and MCP servers stay disabled.
SDK token snapshots are cumulative: later turns subtract the prior trusted snapshot. Input/output totals include
cache and thinking consumption; cache counters are subsets. Missing or invalid snapshots leave usage unavailable.

## Authentication and runtime

Every inference/control route requires one `Cf-Access-Jwt-Assertion`. PyJWT verifies RS256 signatures against
the fixed issuer's cached JWKS, exact issuer/audience, expiry and issuance time, then the documented service-token
claims (`type=app`, nonempty `common_name`, empty `sub`). Header presence or an old Bearer cannot authorize a
localhost request. See [JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
and [service-token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).

The image bakes public issuer/audience from `config/cloud.toml` and `config/resources.toml` alongside its source
SHA. No auth environment overrides or extra shared token are used. Privileged Platform authentication is separate.
`/healthz` stays an unauthenticated, content-free local probe, with baked source SHA, release request ID and Home's
existing inference observations. It does not verify login or model access.

`CODEX_HOME` is the existing login-only mount. Startup makes a private temporary CLI home and links only
`auth.json` into it; token refresh writes through that link. Caches, skills and SQLite files stay out of the
shared login directory. The SDK account must be the subscription account type. SDK/CLI versions must match.
The final launch environment removes unrelated credentials. A dedicated process group covers hosted-tool
children, and Linux parent-death notification handles abrupt server termination. Container restart discards
its temporary files. Run one server process per state directory. Normal shutdown closes active contexts.
No prompts, responses, private URLs, credentials or vendor error text are logged; access logging is disabled.

Build from the repository root after generating the shared Python package:

```sh
node proto/tools/ensure.mjs
docker build -f codex-gateway/Dockerfile --build-arg SOURCE_SHA=<full-commit-sha> .
```

## Home observations

The existing Home Codex page reads `/healthz` through the five-minute Platform/Fleet observer. Its generated
`InferenceStatus` shape stays unchanged. The monitor consumes slim Generation/Usage directly, without an old
inference response adapter. Samples record the actual effort (`default` when omitted) in `requested_effort`;
the original monitor `effort` field remains medium for that existing wire contract.

`DATA_DIR/inference-monitor.sqlite3` keeps UTC completion-day totals and the latest eight content-free samples.
History survives app recreation; the response exposes the latest 30 recorded days. Earlier usage remains unknown.
Process counters and active work reset on restart. Usage availability distinguishes reported zero from missing
consumption. Storage failures do not fall back to memory. These observations are not a billing ledger.

## Offline checks

```sh
uv run --locked --package personal-codex-gateway python -m unittest discover -s codex-gateway/tests -v
uv run --locked --package personal-codex-gateway ruff check codex-gateway/src codex-gateway/tests
uv run --locked --package personal-codex-gateway ruff format --check codex-gateway/src codex-gateway/tests
```

Tests use a fake SDK, real synthetic RSA-signed JWTs, local JWKS, temporary SQLite and synthetic processes.
They cover two turns, web observations, usage gaps/deltas, JSON/SSE, Empty create/close replies, timeouts,
cancellation, cleanup acknowledgement and Home persistence. They do not log in or call a model.
The image probe runs under `--network none` with synthetic JWTs and a fake executor. Linux CI verifies parent-death
process cleanup; that test is skipped on other platforms.
