# Codex gateway

Private, synchronous structured inference through `openai-codex==0.163.0` and its pinned runtime.
The default model is `gpt-6.1-sol`, with medium effort.
The service uses the subscription login mounted at
`CODEX_HOME`; it checks the SDK account type and does not use an API key or another model.

`POST /api/codex/v1/inference:run` uses the generated `codex.inference.v1` wire JSON contract.
The request carries `instructions`, `input_json`, `output_schema_json` and an optional explicit `model`.
An empty model uses the service default; there is no automatic model fallback. An inference response carries
the selected model and fixed effort, output JSON, reported token counts and a safe `error_code`. Model failures return
HTTP 200 with an empty output and one of `codex_auth`, `codex_quota`, `codex_timeout`,
`codex_unavailable` or `codex_bad_answer`. Transport/configuration errors use the shared RPC Status body.
Failures before a model turn identify only their stage: `codex_configuration`, `codex_startup`,
`codex_account` or `codex_skills`. Authentication, quota and timeout codes take precedence. These codes
never include vendor error text, local paths or request content.

`POST /api/codex/v1/inference:check` uses the same bearer and Access identity. It reads the existing
subscription login and one bounded model-catalog page, returning only model identifiers, supported
efforts and a pagination flag. It does not start a thread or model turn, and returns no account identity,
credentials, descriptions or cursor. A catalog entry does not prove that a model turn will succeed.

Configure `CODEX_GATEWAY_TOKEN` as an inference-only bearer secret, `CODEX_HOME` as the existing login-only
mount. At process startup the service creates a private temporary CLI home and links only the shared
`auth.json` into it. SDK token refresh writes through that link; cache, skills and SQLite files stay out
of Newsletter's login directory. `SOURCE_SHA` is a Docker build argument baked into `build-info.json`; the release supplies
`CODEX_GATEWAY_RELEASE_REQUEST_ID` separately. Authentication runs before reading the request body.
The body is limited to 768 KiB, output to 64 KiB and each model operation to 110 seconds. There are no
saved jobs or automatic retries. Each request has a temporary workspace and an ephemeral thread.
The app does not log request bodies, model output, credentials or vendor error text. Access logging is disabled.

The runtime disables shell, browser, desktop, web, app/plugin, image, memory and multi-agent features.
It supplies no MCP servers, disables the pinned system skills and verifies that no skills are enabled
before starting a model turn. Any returned tool item rejects the answer. These checks do not claim
that the Codex protocol exposes a global empty tool-list option.

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

Gateway totals cover the current process lifetime and reset on restart. Only validated, authenticated inference
requests count; health and metadata checks do not. HTTP 200 with a nonempty `error_code` is a failed inference.
`usage_available` distinguishes reported zero from missing usage. Request samples contain only time, safe model
identifiers, effort, duration, token counts and fixed errors. These are not a billing ledger or account-wide quota.
Mailsort separately persists its own daily/monthly classification usage in its existing database.

Local synthetic checks:

```sh
cd codex-gateway
uv sync --locked
uv run --locked python -m unittest discover -s tests -v
uv run --locked ruff check src tests
uv run --locked ruff format --check src tests
```

Tests use a fake SDK and an in-process ASGI client. They do not log in or call a model.
