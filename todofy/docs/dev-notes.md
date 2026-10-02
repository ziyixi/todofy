# Todofy developer notes

How to work on Todofy: local commands, repo layout, the Python Workers idioms this code relies on, and
the contracts between modules. Todofy is two Workers: the TypeScript gateway `todofy` (`gateway/`: host
routing, Access, CSRF, webhook and Basic credentials, assets, cron) and the Python `todofy-core`
(`worker/`), which hosts the `TodofyCore` Durable Object where all D1, Gemini and Todoist work
runs. `gateway-contract.md` is the contract between them. Plans and decisions live in `cloudflare-migration-plan.md` (v2, §0.1
overrides) and `implementation-order.md`; where they disagree with this file on a name or interface,
this file reflects what is in the tree. The retired Go service is gone from the tree (S11); it stays in
the git history at `6c46ed4`.

## 1. Run everything locally

Prerequisites: Node 26 (`.nvmrc`), uv 0.12.10, Python 3.14 (`.python-version`; uv fetches it).
Run everything from `todofy/` in the monorepo.

```sh
npm ci --no-audit --no-fund          # wrangler 4.142.0 only; npm 11 warns about workerd/esbuild
                                     # postinstall scripts, which is harmless
uv sync --locked                     # dev tools; the Worker itself has no third-party packages
uv run ruff check worker tests tools deploy && uv run ruff format --check worker tests tools deploy
uv run pytest tests/unit tests/fakes tools deploy   # host CPython (tools includes a local-D1 round trip)
(cd gateway && npm ci --no-audit --no-fund && npm run lint && npm run typecheck && npm test)
(cd gateway && npm run test:runtime) # the gateway alone in workerd: the owner API's CPU per request (gateway-contract.md §8)
(cd web && npm ci --no-audit --no-fund && npm run typecheck && npm test && npm run build)  # build checks the JS budget
uv run pytest tests/runtime          # real workerd via `wrangler dev`, serially: ~10 min (about 80
                                     # dev servers, each running the gateway and todofy-core in one process)
uv run pytest tests/runtime -n 4     # the same tests in 4 processes (pytest-xdist): ~3 min
uv run pytest                        # everything (testpaths: tests, tools, deploy)
```

These are the steps of the `Todofy static checks` job and the `Todofy runtime` shards in the monorepo's
`.github/workflows/ci.yml` ([ci-cd.md](ci-cd.md)); CI also dry-runs both committed production configs
through `deploy/deploy_vars.py` with placeholder values for what the deploy adds. `npm run build` writes `uiassets/dist`; without it the runtime harness
serves a placeholder `index.html` and one placeholder file under `assets/`.

Running the runtime suite in parallel:

- A file always runs whole, in its own order, in one process. Tests in a file share the module's Worker,
  and some rely on the ones before them: 13 tests in 9 files fail when their file runs reversed. Files
  are independent of each other: every file passed in a random and in a reversed file order. So
  pytest-xdist runs with `--dist loadfile --no-loadscope-reorder` (the `addopts` default in
  `pyproject.toml`), and the rootdir `conftest.py` refuses every other mode (`--dist load`,
  `worksteal`, `loadgroup`, `each`, `loadscope`), also for `uv run pytest -n 4` over all testpaths
  (`tests/unit/test_pytest_setup.py`). Never add pytest-randomly or a rerun plugin.
- Ports: each pytest process takes the ports of its servers from its own range of 500, from 20000 up
  (the xdist worker number picks the range). That is below the Linux (32768–60999) and macOS
  (49152–65535) ephemeral ranges, where the fakes' and clients' OS-assigned ports live. Each server
  also gets an explicit `--inspector-port` from the range; wrangler's own pick (9229, else a random
  port) races between processes. To run several pytest commands at once, give each a different
  `TODOFY_TEST_PORT_SLOT` that is at least the previous one plus its `-n` (for example 0, 4 and 8 for
  three runs with `-n 4`).
- Shared state in the checkout is prepared under file locks in `.wrangler/`: `pywrangler sync` (once per
  process) and the first Pyodide download. `uv run python -m tests.runtime.warm_up` does both once, up
  front; CI runs it before each shard.
- `test_alarm.py::test_timeout_really_closes_a_hanging_upstream_connection` measures the gap between
  the fake receiving the hung call and the fallback call against the 1.5 s `GEMINI_TIMEOUT_MS`. workerd
  arms `AbortSignal.timeout` on the isolate's clock, which stands still while Pyodide builds the
  request, so the gap on the real clock is 1.5 s give or take the Worker's CPU time around the two calls
  (1.4968–1.523 s measured; the fake's own stamps are within 1 ms of arrival). The bound is therefore
  `1.45 <=`: 50 ms of slack still proves the call waited out the timeout. It used to be `1.5 <=` and
  failed now and then, in parallel and serial runs alike. CI still runs `test_alarm.py` alone after each
  shard's xdist run (`.github/scripts/todofy-runtime-serial.txt`, [ci-cd.md](ci-cd.md)).
- Longest first: xdist hands out files in the order pytest collects them, so pass the files heaviest
  first. The CI plan prints them in that order; to run shard `I` of 3 exactly as CI does:

  ```sh
  uv run pytest tests/runtime --collect-only -q -p no:cacheprovider > /tmp/collected.txt
  uv run pytest -n 4 $(python3 ../.github/scripts/pytest_shards.py --collected /tmp/collected.txt \
    --durations ../.github/scripts/todofy-runtime-durations.json --workers 4 --total 3 --index I \
    --serial ../.github/scripts/todofy-runtime-serial.txt --serial-out /tmp/serial.txt)
  [ -s /tmp/serial.txt ] && uv run pytest $(cat /tmp/serial.txt)   # this shard's files that run alone
  ```

  Without `--serial`, `--total 1 --index 0` prints every file, heaviest first, for a single `-n 4` run.

One host test, `tools/legacy_migration/test_legacy_to_d1.py::test_model_table_matches_the_proto`,
cross-checks the legacy model table against the `protos` checkout. It reads `TODOFY_PROTOS_DIR` if set,
otherwise a `protos` checkout next to the monorepo checkout (or next to a standalone `todofy` checkout),
and skips when none is present, as in CI.

Other useful commands (all local, no credentials):

```sh
# Both Workers in one local process (gateway first: it owns the port, the cron trigger, the assets and
# --var). The committed configs are production: local bindings only, never --remote. The local hosts
# replace the production ones. wrangler dev would otherwise make the gateway's first production route
# every request's URL (whatever the Host header), which is neither local host, so --local-upstream pins
# the URL to the owner host: browse http://todofy.localhost:8787. To reach the hooks host instead (e.g.
# tools/smoke_webhook.py), restart with --local-upstream todofy-hooks.localhost:8787. DEV_AUTH_BYPASS
# applies only to *.localhost hosts. Core-only local values and secrets go in todofy/.dev.vars
# (.dev.vars.example; the runtime tests' cores read it too).
uv run pywrangler dev -c gateway/wrangler.toml -c wrangler.toml \
  --port 8787 --local-upstream todofy.localhost:8787 \
  --var TODOFY_PUBLIC_HOST:todofy.localhost --var TODOFY_HOOKS_HOSTS:todofy-hooks.localhost \
  --var BUILD_SHA:dev --var MAINTENANCE_MODE:false --var DEV_AUTH_BYPASS:true
# Apply D1 migrations to a throwaway local database
node_modules/.bin/wrangler d1 migrations apply DB --local --persist-to /tmp/todofy-d1 --config wrangler.test.toml
# Bundle checks of the production configs (without the deploy's --var values); list every module and binding.
# The exact deploy commands, with deploy/deploy_vars.py, are in cloudflare-setup.md §6.
CI=true uv run pywrangler deploy --dry-run --config wrangler.toml --outdir /tmp/todofy-core-bundle
CI=true node_modules/.bin/wrangler deploy --dry-run --config gateway/wrangler.toml --outdir /tmp/todofy-gateway-bundle
```

`uv run pywrangler dev` / `deploy` re-create `.venv-workers/` and `python_modules/` (both gitignored)
whenever `pyproject.toml` or `pylock.toml` change. `pylock.toml` pins `workers-runtime-sdk` with its hash
and is generated by pywrangler; commit it.

## 2. Repo layout

```
wrangler.toml                  todofy-core production config (D1, the DO class; no routes; top level =
                               production); must keep this name, next to python_modules/ (pywrangler)
.dev.vars.example              local core values (copy to .dev.vars, gitignored)
wrangler.test.toml             todofy-core for the runtime tests: short timeouts, fake upstreams
gateway/                       the gateway Worker `todofy` (TypeScript, own package.json and lockfile;
                               Access, CSRF and private headers come from ../packages/edge-auth, linked
                               by a `file:` dependency and compiled into this Worker)
  src/                         index.ts (routing, cron), hooks.ts, owner.ts, access.ts, csrf.ts, ...
  test/                        vitest unit tests with fake ASSETS/COORDINATOR bindings
  wrangler.toml                gateway production config (hosts, assets, cron, COORDINATOR → todofy-core)
  wrangler.test.toml           runtime tests: DEV_AUTH_BYPASS
  wrangler.test-auth.toml      runtime tests: real Access JWT checks against a loopback issuer
migrations/0001_init.sql       the D1 schema; 0002_daily_metrics.sql adds the owner UI's daily trends (§6);
                               0003_ops.sql adds mail_events.canary_run_id, mail_reminders.ops_count/ops_generated_at (§5, ops-v1);
                               0004_gtd.sql adds the GTD ledger (gtd_snapshots, gtd_snapshot_tasks, gtd_daily,
                               gtd_reviews) and mail_reminders.project_id (gtd-features.md);
                               0005_task_intents.sql adds task_intents and task_intent_tasks (§5, task-intent-v1)
api/                           machine-api-v1.openapi.yaml (the hooks hosts' routes: webhook, newsletter,
                               health; the owner API is ../proto/todofy/ui/v1), newsletter report
                               schemas; the webhook body references ../contracts/mail-received-v1 (shared,
                               generated from proto/mailhero/webhook/v1; core/contract.py reads every body
                               with its generated Python codec)
worker/todofy/core/            pure stdlib Python, host-testable, no `js`/`workers` imports
  vocab.py api_errors.py contract.py render.py prompts.py reminder_text.py request_id.py
  backoff.py classify.py todoist_request.py report_schema.py gemini_wire.py gtd.py ops.py intents.py
  sql/                         every D1 statement, one module per owning runtime module
worker/todofy/runtime/         runs only inside workerd (imports `js`, `workers`, `pyodide`)
tests/unit/                    host tests for core/, the migration and the API contract (golden/ = Go captures)
tests/fakes/                   in-process loopback HTTP fake (+ its own tests)
tests/runtime/                 black-box tests against `wrangler dev` (gateway + core) with real
                               D1/DO/alarms/cron/assets (harness.py; run serially or in parallel, §1)
tests/mail_contract.py         paths of the shared contract: ../contracts/mail-received-v1 holds the schema and
                               the exact webhook bytes Mail Hero's builder emits (compat fixtures, synthetic mail);
                               tests/unit/mail_cases.py mutates them for the differential tests against the frozen
                               hand-written schema and parser (tests/unit/legacy/)
web/                           owner UI (React + Vite); builds into uiassets/dist; calls todofy.ui.v1 through the
                               generated client (@ziyixi/proto/http-client, src/api/client.ts)
tools/                         legacy SQLite snapshot → D1 export/verify scripts and the webhook smoke test
                               (stdlib, Python 3.9+)
deploy/                        deploy_vars.py (adds what is never committed: --var values, each Worker's
                               secrets file) and the tests of the committed production configs
```

Conventions: English identifiers and comments, Chinese user-facing strings, type hints everywhere,
comments explain why. `core/` modules import each other relatively (`from .vocab import Code`);
runtime modules import absolutely (`from todofy.core.vocab import Code`). Comments that cite
`*.go` files refer to the Go service at `6c46ed4` (git history).

## 3. Python Workers idioms used here

Layout and entry
- `main = "worker/todofy/runtime/entry.py"`, `base_dir = "worker"`: every `.py` under `worker/` is
  uploaded and module names are relative to it, so imports are `todofy.core.x` / `todofy.runtime.x`.
  The dry-run bundle lists `todofy/core/*.py`; the runtime tests prove core imports work in Pyodide.
- `entry.py` exports `Default(WorkerEntrypoint)`, whose `fetch` answers 404 (the core has no public
  routes), and re-exports `TodofyCore` in `__all__`.
- pywrangler picks the Python version from the root `wrangler.toml` only (`compatibility_date =
  "2026-09-08"` + `python_workers` → Python 3.14 / Pyodide 3.14.2), whatever `--config` says. Every
  other config must keep the same date and flags (`tests/runtime/test_configs.py` guards the test ones,
  `deploy/test_wrangler_configs.py` the gateway).

Host routing, credentials and assets live in the gateway (`gateway/src`, gateway-contract.md §2)
- `TODOFY_PUBLIC_HOST` → `owner.ts`: Access JWT on every request, including assets; `/api/*` or
  `ASSETS` (SPA fallback via `not_found_handling`, `run_worker_first = true`), private headers added.
- Every name in `TODOFY_HOOKS_HOSTS` (comma-separated) → `hooks.ts`: exactly `POST /hooks/mail`,
  `GET /api/summary`, `GET /api/recommendation`, `GET /health`. Anything else, and any other host → 404.
- `request.url` carries the Host header under `wrangler dev`, so tests pick the vhost with
  `host: todofy.localhost` / `host: todofy-hooks.localhost`.
- The gateway calls the object's RPC methods on `env.COORDINATOR.getByName("inbox-v1")` with arguments it
  picks itself (the owner API gets the canonical owner); the object's `fetch` answers 404 to everything.
  Bodies are passed as streams, unread. Every method answers with an `http.Result` dict, which the gateway
  turns into the HTTP response (gateway-contract.md §3).

Env, secrets, bindings (core)
- `config.var(env, NAME, default)`, `flag()` (== "true"), `csv()` (lowercased list). A missing binding
  raises on the JsProxy; `var` uses getattr with a default. Secrets read exactly like vars.
- Dev-only switches (`DEV_AUTH_BYPASS`, `DEV_ACCESS_LOOPBACK_ISSUER`) are gateway vars and only work when
  `TODOFY_PUBLIC_HOST` ends with `.localhost`; no production config holds `DEV_*` (tests check it).
- Use `self.env` in handlers. The core has no `scheduled()`: the gateway's cron calls the object's `wake()`.

Answers (`runtime/http.py`)
- RPC methods take plain arguments (JS strings arrive as `str`, null as `None`, a ReadableStream as a
  JsProxy that `interop.read_capped` reads) and return `Result.wire()`, a plain dict. Build a `Result`
  with `ok(data)` (200, `json.dumps(ensure_ascii=False)` text), `NO_CONTENT` (204) or
  `failed(status, ApiError.X, retry_after=None)`. Never raise for an expected outcome: a Python
  exception reaches the gateway only as an opaque `PythonError` with a traceback (503 there).
- Return `bytes`, `str`, dicts and lists over RPC, never a tuple (refused) or a memoryview/typed array
  (converted element by element, about 1.5 s per MiB in workers-runtime-sdk 1.9.0).
- Every error body of the hooks hosts (and of `owner_api`, the previous gateway's) is the envelope
  `{"error": {"code", "message", "request_id"}}` (`api/machine-api-v1.openapi.yaml`). Codes are the
  closed `core.api_errors.ApiError` (== the document's `ApiErrorCode`, unit-tested), messages come from
  `api_errors.MESSAGES`. The gateway's `errorEnvelope()` (`gateway/src/http.ts`) builds the envelope and
  logs `{request_id, status, code}` once for every error, `failed()` results included; the core builds no
  envelopes and never sees the request ID, except `http.error_response()` (the fetch handlers' 404 and
  the transition 503), which makes and logs its own (gateway-contract.md §4). A new code means editing
  `ApiError`, `MESSAGES` and the document's enum together. The owner API (todofy.ui.v1) answers
  google.rpc.Status instead: `owner_ui` returns a reason (`core/owner_ui.py` `Reason`, the reasons of
  `proto/todofy/ui/v1/errors.proto` and `common.errors.v1`) and the gateway builds the Status.

D1 (`env.DB`, wrapped by the SDK)
- `stmt = env.DB.prepare(sql).bind(*args)` (Python `None` → NULL); `await stmt.first()` → JsDict or None
  (`row.col` or `row["col"]`); `await stmt.all()` → `.results` (list of JsDict); `await stmt.run()`;
  `await env.DB.batch([s1, s2])` → list of results (`results[1].results[0].col`); results are plain
  Python, `json.dumps` works. D1 times are Unix seconds.
- Only run SQL from `todofy.core.sql` (see §4.2): `env.DB.prepare(views.RECENT_PAGE.sql)`.

Durable Object (SQLite-backed)
- `self.ctx.storage.sql.exec(sql, *args)` is synchronous → cursor with `.one()` / `.toArray()`. Create DO
  tables in `__init__` with `IF NOT EXISTS`.
- Alarms: `await self.ctx.storage.getAlarm()` (None or epoch ms), `await self.ctx.storage.setAlarm(ms)`;
  handler `async def alarm(self, alarm_info=None)`.
- `interop.now_ms()` / `interop.utc_now()`. Time does not advance during pure CPU work in workerd, so
  CPU cannot be timed inside the isolate; production CPU comes from Workers Logs.

Outbound calls (`runtime/interop.py`)
- `await fetch_with_timeout(url, timeout_ms=..., method=, headers={}, body=str|bytes)` → `Upstream(status,
  body: bytes, failure: Failure | None, retry_after: str | None)`. The deadline (`AbortSignal.timeout`)
  covers the body read and really closes the socket (runtime-tested against a hanging fake).
- Pyodide raises AbortError (an OSError) for every fetch failure. Only `signal.aborted` separates a
  timeout (`Failure.TIMEOUT`) from anything else, and nothing proves a failed request was never sent, so
  every other failure is `Failure.LOST`. `Failure.NOT_SENT` is never produced; if the Todoist owner finds a
  reliable pre-send signal it can add one, with a runtime test using a refused port.
- `upstream.outcome()` → `core.classify.HttpOutcome` (parses Retry-After) — feed it to `classify_*`.
- `to_js(value)` makes plain JS objects (default conversion builds a Map); `ArrayBuffer.to_bytes()`;
  `sha256_hex(bytes)` uses WebCrypto.

Local runtime quirks (not production behaviour)
- Local cron: `GET /cdn-cgi/local/scheduled?cron=...` (`Worker.trigger_cron`). `/__scheduled` and
  `--test-scheduled` no longer work in wrangler 4.142 (the plan docs carry an as-built note).
- `wrangler dev` holds an answer to a request whose body nobody read until the body is consumed, so the
  gateway cancels an unread upload after answering on the headers alone (401/403/404/413/415/503). If an
  answer still leaves an upload in flight (405 from assets), wrangler's local proxy may fail the next POST
  on that dev server with a 500. Send such requests without a body, use `Worker.headers_only_status`, or
  use the per-test `throwaway_worker` fixture.
- wrangler's local proxy passes a chunked upload on only in large pieces (1.1 MiB unterminated never
  reached the object in a probe; 3.2 MiB did) and may add a length, so an HTTP test cannot prove that the
  object stops reading early. `test_owner_body_limit.py` proves the early stop on `interop.read_capped`
  itself, fed a JS stream through the clients probe's `/read-capped` route, and checks the owner route
  with a complete chunked body of exactly 16 KiB (served) and 16 KiB + 1 (400, nothing written).
- A binding to a Worker the dev process does not run (the gateway started alone) gets a plain-text 503
  `Worker "todofy-core" not found` from wrangler itself, not the gateway's `unavailable` envelope.
- The first object call after startup takes ~2 s (Pyodide cold start); the harness only waits on the
  gateway's `/health`, which never calls the object.
- workerd downloads the ~14 MB Pyodide bundle from `pyodide-capnp-bin.edgeworker.net` on every start
  unless it gets `--pyodide-bundle-disk-cache-dir`, which wrangler never passes. A slow download once
  stalled a dev server for 77 s and once killed it (`read(): Operation timed out`), so the runtime harness
  launches workerd through `.wrangler/workerd-with-pyodide-cache` (via `MINIFLARE_WORKERD_PATH`), which
  caches it in `.wrangler/pyodide-cache`. Plain `pywrangler dev` still downloads it each time.
- The harness starts `node_modules/.bin/wrangler dev` itself: `pywrangler dev` runs `pywrangler sync` and
  `npx wrangler --version` on every start (about 1.2 s) and then the same `npx wrangler dev`. The harness
  runs `pywrangler sync` once per pytest process instead. A new server's empty persist directory gets a
  copy of one migrated per process and database, instead of its own `d1 migrations apply` (1.3 s).

## 4. Contracts every module must keep

### 4.1 Vocabulary, units, identities
- States, error codes and owner actions: `core.vocab` only (== migration CHECKs == the todofy.ui.v1 enums'
  wire names == the machine document's `ApiErrorCode`, tested).
  The owner-facing Chinese text for each code lives only in `web/src/lib/labels.ts`; change it together
  with the behaviour it describes.
  Transition actors are the literals `worker` / `owner`.
- Units: core timing constants and `backoff.*` are seconds; D1 columns are Unix seconds (store
  `math.ceil`ed deadlines); DO alarms are epoch ms. Pass `now: int` (Unix seconds) through runtime calls.
- Mail source: every ledger row uses `source_id = var(env, "MAIL_SOURCE_ID", "mail-hero-personal")`.
- Payload hash: lowercase hex SHA-256 of the exact webhook bytes (`interop.sha256_hex`).
- Owner identity: the gateway's `access.ts` (Todofy's policy for the shared `packages/edge-auth`
  verifier) returns `ACCESS_OWNER` ASCII-lowercased (aliases in `ACCESS_OWNER_ALIASES` map to it) and passes
  it to `owner_ui` (and `owner_api`, the previous gateway's); `owner_actions.owner` is always that value.

### 4.2 SQL
- Every D1 statement is a module-level `Query(sql, index, sort_allowed=False)` in `worker/todofy/core/sql/`,
  in the module named after its runtime owner (`ledger`, `views`, `reminders`, `reports`, `retention`,
  `metrics`, `gtd`).
  `tests/unit/test_schema_sql.py` discovers all of them and checks each query plan uses its index with no
  unbounded scan, so adding or widening a statement needs no test edit. Placeholder column lists
  (`SELECT event_id ...`) are meant to be widened by the owner.
- "Active" is always the `sql.ACTIVE` IN list (never `NOT IN`), due rows are `sql.DUE`, attention is
  `sql.ACTIVE AND sql.ATTENTION` with the cutoff `now - ATTENTION_AGE_SECONDS`.
- Every state change is one `STATE_CAS` (`state = ? AND version = ?`, `version = version + 1`, check
  `meta.changes == 1`) plus its `event_transitions` insert in the same `batch()`. Moving to `complete` or
  `ignored` also sets `payload = NULL` (CHECK-enforced) and, for `complete`, inserts the `summaries` row.
  Each dependent insert (transition, summaries row, owner action) is guarded by `changes() = 1`, i.e. the
  statement just before it changed one row, so a lost CAS writes nothing (a version match alone is not
  enough: a writer one version behind matches the row another writer has just moved). A transition takes
  a completed summary or an owner action, never both (`tests/runtime/test_ledger_cas.py`).
- Statements that write (INSERT/UPDATE/DELETE) are also `Query` constants; name the index of the key they
  hit (`sqlite_autoindex_<table>_1` for primary keys). A plain `INSERT ... VALUES` has no query plan, so
  the test only checks that its index is a unique index of the inserted table.

### 4.3 HTTP
- Webhook: the gateway (`hooks.ts`) checks Bearer vs `MAIL_WEBHOOK_TOKEN_SHA256` / `_PREVIOUS` (constant
  time), then `MAINTENANCE_MODE` (503 `maintenance` with `Retry-After`), 415, and 413 for a declared
  `Content-Length` over 1 MiB, and passes the body stream and the `Idempotency-Key` header to the
  object's `ingest`. A request without `Content-Length` is accepted and the object stops reading at 1 MiB
  (413). The object requires one Idempotency-Key equal to `event_id` (a value containing "," means
  repeated → 400), runs `contract.parse_mail_event`, answers 204 (stored or same bytes), 409 (different
  bytes), 400, or 503.
- Newsletter: the gateway checks Basic, `sha256("user:password")` compared in constant time with every
  digest in the comma-separated `REPORT_BASIC_AUTH_SHA256` (list two while rotating). A correct credential
  goes straight to the object's `newsletter(kind, query)` (`reports.serve`) and is always served. A failure
  goes to `newsletter_auth_failure()` (`reports.count_auth_failure`), counted per UTC hour in `auth_failures`;
  after 20 a failing request gets 429 and nothing more is written (at most 20 D1 writes an hour). That
  lockout no longer slows guessing, so the newsletter password must be a random secret of at least 128
  bits. A stored report is served only when computed since the latest `REPORT_PRECOMPUTE_UTC` time and
  `ok`/`empty_window`; otherwise the coordinator computes one within 40 s, and anything but a usable
  report is 503 (the newsletter reads only the HTTP status, so an old or empty-by-failure report is never
  a 200). Responses must validate against `api/summary-v1` / `recommendation-v1`, which are generated from
  `proto/todofy/report/v1/report.proto` (`cd proto && npm run schema`; never edited by hand; the UI reads the
  reports as the generated messages of `@ziyixi/proto`):
  `core/report_schema.py` builds every report as a generated message written by the wire codec, which refuses one
  that breaks a rule, and `tests/unit/test_report_wire.py` pins the bytes of synthetic reports
  (`golden/reports-v1.json`, written before the move onto the IDL).
- Owner API (todofy.ui.v1, `proto/todofy/ui/v1`): the gateway checks Access on every request, then serves
  `/api/v1/*` with the shared transcoder: Origin and CSRF on writes (it also issues `GET /api/csrf`),
  `MAINTENANCE_MODE`, a 16 KiB body limit and a strict read of every request; page tokens are the gateway's
  (bound to the list's other fields). Every rpc but `GetIntegration` is one `owner_ui` call: the object reads
  the request strictly again with the generated Python code, does the work (30 s CPU, single writer; writes
  with `request_id` idempotency via `owner_actions`, its `action_request_id` column) and answers the generated
  response message (`runtime/owner_ui.py`, mapped from the ledger's dicts by `core/owner_ui.py`), which the
  gateway reads leniently and writes. The paths before todofy.ui.v1 answer 410 `reload_required` for one release
  (gateway-contract.md §2.2); the object keeps `owner_api` for the previous gateway until then.
- One coordinator per D1 database: `ledger.recover_interrupted` treats every `summarizing` /
  `todo_sending` row as abandoned, so two objects on the same database would undo each other's work.
  A rollback or cutover stops one before the other runs (gateway-contract.md §6.5).

## 5. Module contracts

The build phase split the Worker between four owners (P, O, R, T below); the split still marks the
module seams. Signatures are the contract between modules — change one together with its callers.

| Owner | Files |
|---|---|
| **P – pipeline** | `runtime/coordinator.py`, `runtime/ledger.py`, `runtime/gemini.py`, `runtime/todoist.py`, `core/sql/ledger.py`, `config.py`, `interop.py` |
| **O – owner API** | `runtime/api.py`, `core/sql/views.py` |
| **G – gateway** | `gateway/` (TypeScript: routing, Access, CSRF, webhook and Basic credentials, assets, cron) |
| **R – reports & reminders** | `runtime/reports.py`, `runtime/reminder.py`, `runtime/retention.py`, `core/sql/{reports,reminders,retention}.py` |
| **T – runtime tests** | `tests/fakes/{gemini_fake,todoist_fake}.py`, `tests/runtime/test_*.py` scenarios (v2 §6.2 + impl-order §1.5), `wrangler.test.toml` and `gateway/wrangler.test*.toml` vars |

`entry.py`, `http.py`, `core/*` and the migration stay with the lead; a new `ApiError` or a schema change
goes through the lead. The signatures below are as built (S5/S6 done); the spike code is gone.

### entry.py (lead; exists)
```python
class Default(WorkerEntrypoint):
    async def fetch(self, request) -> Response      # always 404: the core has no public routes
```

### config.py (P)
Existing `var/flag/csv`, plus small typed readers as needed:
```python
def integer(env, name: str, default: int) -> int
def source_id(env) -> str                           # MAIL_SOURCE_ID, default "mail-hero-personal"
def gemini_models(env) -> list[str]                 # GEMINI_MODELS csv, first is preferred
```
Vars (plain, with defaults): `MAIL_SOURCE_ID`, `GEMINI_API_BASE`, `GEMINI_MODELS`,
`GEMINI_TIMEOUT_MS` (60000), `GEMINI_DAILY_TOKEN_BUDGET` (3000000), `TODOIST_API_BASE`,
`TODOIST_DEFAULT_PROJECT_ID`, `LOOKUP_DELAY_MS` (120000), `BACKOFF_BASE_MS` (60000),
`WATCHDOG_MS` (120000), `TODOIST_ATTEMPT_TIMEOUT_MS` (14000), `REPORT_DEFAULT_TOP` (10), `REPORT_PRECOMPUTE_UTC` ("13:30"), `REMINDER_ENABLED`,
`LEGACY_TEXT_RETENTION_DAYS`, `MAINTENANCE_MODE`, `PROCESSING_PAUSED`, `FORCE_PAUSE_TODOIST`,
`BUILD_SHA`, `TODOFY_PUBLIC_HOST` (the reminder's link); the GTD ledger's `GTD_COLLECT_UTC` ("13:00", `off`
in the test config), `GTD_REVIEW_ENABLED`, `REPORT_CARRYOVER_DAYS` (14; 0 turns the carryover off),
`TODOIST_OPS_PROJECT_ID` and `TODOIST_REVIEW_PROJECT_ID` (optional; unset = the default project) and the
test knob `GTD_PAGE_TIMEOUT_MS` (20000). Core secrets set by the owner: `GEMINI_API_KEY`,
`TODOIST_API_KEY`. The gateway's vars and secrets (`ACCESS_*`, `TODOFY_HOOKS_HOSTS`,
`MAIL_WEBHOOK_TOKEN_SHA256(_PREVIOUS)`, `REPORT_BASIC_AUTH_SHA256`, `CSRF_SIGNING_KEY`) are listed in
gateway-contract.md §1. Test configs shorten `*_MS` values (including the gateway's
`JWKS_REFRESH_COOLDOWN_MS`); production never sets them.

### coordinator.py (P) — the only writer of the ledger
RPC methods, called only by the gateway's binding (gateway-contract.md §3; `fetch` answers 404). Each
returns `Result.wire()` except `wake` and `setup`:
```
ingest(idempotency_key, body)             webhook stream → 204|400|409|413|503
wake()                                    → None (the gateway's cron)
newsletter(kind, query)                   stored or on-demand report, after the gateway accepted Basic
newsletter_auth_failure()                 count a failed Basic credential → 401 | 429
owner_ui(owner, method, request, cursor)  the owner API todofy.ui.v1 (owner_ui.handle): {"ok", "next_cursor"}
                                          or {"error", "detail", "retry_after"}, never raised
owner_api(owner, method, path, query,     the owner API before todofy.ui.v1 (api.handle), only for the previous
          content_length, body)           gateway during this release's deploy; removed next release
setup()                                   {"mail_source_id", "configured": {...}} for the setup page
ops_status() | ops_set_guard(input_json)  the gateway's Ops entrypoint (contracts/ops-v1, below):
ops_canary_result(event_id)               {"ok": value} or {"error": "invalid_input" | "busy" | "unavailable"},
ops_report(report_json)                   never raised; JSON text in, plain dicts out
task_intent_propose(intent_json)          the same entrypoint's task-intent-v1 methods (below), same shape
task_intent_status(ref_json)
```
Every other method is callable over RPC too (Python exposes them all, `_`-prefixed ones included); only
the gateway binds the class, and it calls only these.
The owner API calls the object's methods directly: `apply_reconcile(owner, event_id, action, version,
action_request_id, task_id)` (`reconcile` wraps it for `owner_api`), `recompute_outcome(owner, action_request_id,
kind, top_n)` (`recompute` wraps it), `event_detail(event_id)`,
`compute_report(kind, top_n, now)`, `event(id)` and `budgets()` (Overview).
Alarm loop (v2 §5.3): running guard → maintenance check → watchdog alarm → settle the token
reservation of a summary call an eviction cut short → `ledger.recover_interrupted` → at most one step
(summary, task, lookup), skipped while `PROCESSING_PAUSED` → `reminder.tick`, `reports.tick`,
`retention.tick` when their `control` time is due → `gtd.tick` when `gtd_state` says the snapshot or the
review is due → next alarm = min(ledger due, control times, GTD times). A
wake-up that arrives while the loop runs re-arms the alarm for now when the loop ends. DO SQLite tables
it owns: `control(next_reminder_check, next_report, next_maintenance, todoist_blocked_until)`,
`llm_usage(day, reserved_tokens, used_tokens, calls)`, `llm_inflight(event_id, day, reserved)`,
`todoist_calls(minute_bucket, count)`, `report_requests(hour_bucket, count)`,
`report_failures(kind, top_n, day, count)`; `gtd_state` (runtime/gtd.py) holds the GTD ledger's schedule,
collection cursor, ops facts and HMAC key as one JSON document. Budget helpers used by R:
```python
def reserve_tokens(self, tokens: int, now: int) -> bool
def settle_tokens(self, reserved: int, used: int, now: int) -> None
def take_report_slot(self, now: int) -> bool        # hourly report-computation cap
def report_failures(self, kind: str, top_n: int, day: str) -> int
def count_report_failure(self, kind: str, top_n: int, day: str) -> None
```
A summary settles its reservation on every exit: nothing spent before the request goes out, all of it if
the call dies midway (as `reports._generate`), the real count after an answer.

### ledger.py (P)
```python
@dataclass(frozen=True, slots=True)
class EventRow:                                     # one mail_events row, times in Unix seconds
    source_id: str; event_id: str; state: EventState; version: int; payload: str | None
    summary: str; summary_model: str; todo_body: str; todoist_request_id: str; task_id: str
    attempt_count: int; crashes: int; next_attempt_at: int; last_error_code: str
    imported: bool; created_at: int; updated_at: int

class Stored(StrEnum): NEW, DUPLICATE, CONFLICT

async def ingest(db, source_id, event_id, payload: str, payload_hash: str, now: int) -> Stored
async def get(db, source_id, event_id) -> EventRow | None
async def next_due(db, now: int, *, todoist: bool = True) -> EventRow | None  # pending/summarized/todo_created
async def next_lookup(db, now: int) -> EventRow | None          # todo_unknown with a scheduled lookup
async def next_wake_at(db, *, todoist: bool = True) -> int | None  # todoist=False leaves out summarized rows and lookups
async def recover_interrupted(db, now: int, *, lookup_at: int) -> None  # summarizing→pending(+crash), todo_sending→todo_unknown
async def transition(db, row: EventRow, to: EventState, *, actor: str, now: int, code: str = "",
                     completed: CompletedSummary | None = None, action: OwnerAction | None = None,
                     **columns) -> EventRow | None   # CAS + transition row (+ summaries row, + owner action); None if lost
async def find_action(db, owner, action_request_id, request_hash) -> ActionClaim      # read only (reconcile)
async def claim_action(db, owner, action_request_id, kind, request_hash, now) -> ActionClaim  # insert, then read (recompute)
async def finish_action(db, owner, action_request_id, result_ref: str, http_status: int) -> None
async def release_action(db, owner, action_request_id) -> None   # a failed recompute: the same id runs again
async def take_over_action(db, owner, action_request_id, request_hash, now, stale_before) -> bool  # an unfinished claim
```
`ActionClaim.claim` is `new`, `replay` (with `result_ref`, `http_status`) or `conflict` (same id, different
hash → 409). A recompute stores only a computed report (200); a failure (429, 503) releases its claim, and a
claim whose run never finished is taken over after `RECOMPUTE_CLAIM_STALE_S` (120 s), so repeating the same
`request_id` after a retryable error computes it then (AIP-155).

### gemini.py (P; used by R)
```python
@dataclass(frozen=True, slots=True)
class GeminiResult:
    verdict: GeminiVerdict          # core.classify, from the last model tried
    text: str                       # first candidate text when ok
    model: str                      # model that answered (or the last one tried)
    tokens: int                     # usageMetadata.totalTokenCount summed over attempts

async def generate(env, *, system: str, user: str, deadline_ms: int,   # deadline_ms: absolute epoch ms
                   response_schema: dict | None = None, preface: str = "") -> GeminiResult
```
Tries `gemini_models(env)` in order while `verdict.next_model`, each attempt capped by
`GEMINI_TIMEOUT_MS` and the remaining `deadline_ms`. No retries across alarms here; the caller applies
`backoff`. `user` is always framed by `core.gemini_wire` between `<<<BEGIN_CONTENT>>>` and
`<<<END_CONTENT>>>` (markers inside the content are neutralised; golden-tested); trusted `preface` text,
such as the truncation notice, goes before the fence. Summary step: `system=prompts.SUMMARY_EMAIL`,
`user=gemini_wire.summary_content(event)`, `preface=render.content_notice(event)`.

### todoist.py (P; used by R)
```python
@dataclass(frozen=True, slots=True)
class CreateResult:
    verdict: TaskVerdict            # or ReminderVerdict via classify_reminder
    task_id: str

async def create_task(env, request: TaskRequest, *, budget_ms: int) -> CreateResult
    # up to TODOIST_MAX_ATTEMPTS while verdict.retry_inline, TODOIST_ATTEMPT_TIMEOUT(_MS) each,
    # backoff.inline_delay between, same frozen bytes and X-Request-Id every time. Once an attempt may
    # have created the task (a timeout, say), the call ends CREATED or UNKNOWN only
    # (classify.final_task_verdict): a later 429/5xx never turns into a durable resend.
async def find_footer_tasks(env, event_id: str) -> list[str] | None
    # GET /api/v1/tasks?project_id=&cursor=, ≤ LOOKUP_MAX_PAGES pages, None on any failure
```
Build requests with `todoist_request.build_task_request` and `request_id.todoist_request_id`.

### reminder.py (R)
```python
async def tick(env, coordinator, now: int) -> int     # returns the next check time
async def page(db, before_day: str | None, limit: int) -> tuple[list[dict], str | None]  # for api.py
```
Claims the UTC day with `INSERT ... ON CONFLICT(day) DO NOTHING` before calling `todoist.create_task`,
freezing the project (`TODOIST_OPS_PROJECT_ID`, else `TODOIST_DEFAULT_PROJECT_ID`; a row from before
migration 0004 has `project_id = ''` and retries into the default project);
`unknown` is never resent that day; `failed` retried hourly up to `REMINDER_MAX_ATTEMPTS`. Nothing is sent
while `REMINDER_ENABLED` is off or `FORCE_PAUSE_TODOIST` or `PROCESSING_PAUSED` is on.

### gtd.py (R; `core/gtd.py`, `core/sql/gtd.py`; [gtd-features.md](gtd-features.md))
```python
async def tick(env, coordinator, now: int) -> None    # the snapshot and/or the review, each on its own time
def next_at(store) -> int                              # for _next_alarm_ms
def facts(env, store) -> core.gtd.GtdFacts             # ops status(): object storage only
def release(store, now) / retry_later(store, now, at)  # a shed guard ended / a tick raised
async def daily(db, days: int, now: int) -> dict       # the previous gateway's GET /api/v1/gtd/daily
async def day_page(db, size, before, now) -> (days, before)    # ListGtdDays (todofy.ui.v1 GtdDay), newest first
async def review_page(db, size, before, now) -> (reviews, last)  # ListGtdReviews, the last 12 weeks
```
The coordinator stands in for the Todoist budget (`count_todoist_calls`, `todoist_wait`, `block_todoist`)
and step metrics (`record_step`). **Snapshot**: once a UTC day at `GTD_COLLECT_UTC`, `GET /api/v1/tasks`
(every project, `limit=200`, ≤ 10 pages), then `GET /api/v1/tasks/completed/by_completion_date` (7-day
window, ≤ 5 pages), then the aggregates: at most `CALLS_PER_ALARM` (5) GETs per invocation, continuing a
second later from the cursor in `gtd_state`. Each page is one `INSERT … SELECT … FROM json_each(?)` of
`core.gtd.snapshot_row` objects: a metadata whitelist plus `content_hmac` (HMAC-SHA256 with a key made in
and never leaving the object's storage); titles and descriptions are dropped with the page. A failed list
is retried in 10 minutes (Retry-After honoured; 401/403 blocks Todoist for 6 h like any call) at most three
times a UTC day; more than 10 pages is `partial` (aggregates stored with `complete = 0`, no counters, no
carryover); a failed completed list leaves `completed_7d` NULL (`completed_source = 'none'`). Skipped while
`PROCESSING_PAUSED`, `FORCE_PAUSE_TODOIST`, a Todoist block or a full call window; a `shed` guard defers a
new snapshot (job `gtd_snapshot`, 48 h bound). **Review**: Sunday 17:00 UTC to the end of the ISO week, when
`GTD_REVIEW_ENABLED`: one Todoist task per ISO week (`gtd_reviews`, claimed before the POST with its title,
body and project frozen; `X-Request-Id = todoist_request_id(subject, body, "todofy-review:" + week)`);
`unknown` is never resent, `failed` is retried hourly up to 5 times within the week, a week left `sending`
becomes `unknown`. The body holds counts, trends and links only (`core.gtd.review_body`). The daily
completed list marks a review task done (`completed_at`), which drives `review_age_days`.

### reports.py (R)
```python
async def tick(env, coordinator, now: int) -> int     # precompute at REPORT_PRECOMPUTE_UTC; next time
async def compute(env, coordinator, kind: str, top_n: int, now: int, budget_ms: int) -> dict
async def serve(env, coordinator, kind: str, query: str) -> Result  # newsletter(kind) after the gateway's Basic check
async def count_auth_failure(db, now: int) -> Result  # a failed Basic credential: 401, or 429 once locked
async def latest(db) -> dict                          # ReportsLatest for api.py
```
The recommendation's input is the 24 h window plus the **carryover** (`reports.carryover`): mail tasks of
the `REPORT_CARRYOVER_DAYS` (≤ 14) before the window whose `task_id` the `ok` snapshot of the latest
scheduled collection (`gtd.last_collect`: today's `GTD_COLLECT_UTC` once passed, else yesterday's; never an
older list) still lists, at most 30 picked round-robin over the days they arrived (`gtd.pick_carried`,
oldest day first), each `[N 天前] summary` cut to 1 KiB, the block ≤ 16 KiB, newest first after the new
rows; the prompt is then `prompts.recommend_prompt(top_n, carryover=True)`, which asks for a "（N 天前）"
reason prefix on carried picks. Without that snapshot (none, `failed`, `partial`, `collecting`, taken
before the slot), with `REPORT_CARRYOVER_DAYS = 0`, `GTD_COLLECT_UTC = off`, on any error in those reads,
or once a precompute attempt of the recommendation failed that UTC day, the input, prompt and payload are
exactly the 24 h report; a token reservation refused with the carried lines is retried at once without
them. The payload adds `new_count` and `carryover_count`
(`task_count` is their sum; `empty_window` only when both are 0). The summary report never carries.
Precompute only `top_n = REPORT_DEFAULT_TOP` (default 10, what the newsletter asks for); other `top`
values are computed on demand under the hourly cap (429 with `Retry-After` until the next UTC hour). A
summary longer than the newsletter's 12,000 characters is cut at a line break with a notice
(`report_schema.fit_summary`) rather than failed. `tick` counts failures per report and UTC day in the
coordinator: a failed or `model_output_invalid` report is retried in 10 minutes, after the other report,
at most `PRECOMPUTE_ATTEMPTS` (3) times a day. On-demand work runs in the object
(`coordinator.compute_report`) with a 40 s budget; see §4.3 for what the newsletter gets.

### retention.py (R)
```python
async def tick(db, env, now: int) -> bool             # one bounded sweep; True if more work remains
```
Uses only `core.sql.retention` batches (≤ 13 bounded writes per call, one D1 batch: summaries and reports
after 90 days, owner actions after 180, auth failures after 30, imported legacy text at its `expires_at` and,
with `LEGACY_TEXT_RETENTION_DAYS`, after that many days; the GTD ledger's raw snapshot rows after 14 days,
1000 a batch, its snapshots and aggregates after 120 days, its reviews after 400; a failed task intent's text
after 30 days (an UPDATE), every finished intent and its task rows 400 days after its last change, task rows
first); never deletes `mail_events`. `tests/unit/test_intents.py` checks this count against the code.

### Gateway (G; `gateway/src`)
`access.ts` and `csrf.ts` are adapters over the shared package `packages/edge-auth` (the repository
root; its `SPEC.md` has every parameter): they pass Todofy's values and map the package's failure
reasons to Todofy's codes; the package itself is never edited for one app. `access.ts` (Access JWT:
RS256 via WebCrypto, keys cached per isolate for an hour, an unknown kid refetches at most once a
minute; `alg`/`kid`/no `crit`, `iss`, `aud`, `exp`, `iat`, optional `nbf`, non-empty `sub` and `email`
matched case-insensitively over ASCII only, non-ASCII addresses refused; `ACCESS_OWNER_ALIASES` ≤ 8 emails mapped to `ACCESS_OWNER`),
`csrf.ts` (`Origin` must equal `https://<TODOFY_PUBLIC_HOST>`, `http://` only under the `.localhost`
dev rule; `X-CSRF-Token` must equal the first `todofy_csrf` cookie; an HMAC-signed
`{kind, owner, nonce, exp}` (12 h) keyed by `CSRF_SIGNING_KEY`, 64 hex; missing or malformed → 503
`NOT_CONFIGURED` on `GET /api/csrf` and every write, reads keep working), `http.ts` (error
envelopes; the package's private headers plus the `/assets/` cache exception), `crypto.ts` (the hooks
hosts' Bearer and Basic digest checks only), `owner.ts` (the gate: Access → the old paths' 410 →
`/api/csrf` → the owner API, private headers on every response), `ui.ts` (TodofyUiService on the shared
transcoder: CSRF and `MAINTENANCE_MODE` on writes in its `authorize` hook, one `owner_ui` call per rpc with
the page tokens and `request_id` handled here, `GetIntegration` from the gateway's facts and the object's
`setup()`), `warm.ts` (runs the codec once at global scope, outside every request's CPU), `hooks.ts` (webhook, newsletter, health), `metrics.ts`
(one Analytics Engine point per request and cron, §6), `retired.ts` (the empty `TodofyCoordinator`
class this script still exports; a gateway-only release of its own deletes it, gateway-contract.md
§6.6). The rules are in gateway-contract.md §2; the gateway's unit tests check its error messages
against `core.api_errors`.

### owner_ui.py (`core/owner_ui.py` maps to the generated messages of `proto/todofy/ui/v1`)
```python
async def handle(env, coordinator, owner: str, method: str, request_json: str, cursor_json: str | None) -> dict
METHODS: dict[str, tuple[type, Handler, bool]]         # rpc name → (request message, handler, writes)
```
Reads the request strictly with the generated code, refuses writes in maintenance or while a backup holds the
ledger, and answers the response message or a reason; the reads are api.py's (`overview_data`, `event_page`,
`legacy_text_data`), `reminder.page`, `metrics.day_page`, `gtd.day_page` / `review_page`. Page sizes follow
AIP-158 (0 → the default, above the maximum → the maximum, negative → `BAD_REQUEST`).

### api.py (O)
```python
async def handle(request: OwnerRequest, env, coordinator, owner: str) -> Result  # old /api/v1/* (RPC owner_api)
def setup(env) -> dict                                 # the object's facts for the setup page (RPC setup())
```
The routes are the previous gateway's (removed next release); the readers below them are shared with
owner_ui.py.
Everything runs in the object: overview (D1 counts + `coordinator.budgets()`), events pages, event detail,
reminders (`reminder.page`), `reports/latest` (`reports.latest`), legacy text, reconcile and recompute.
Cursors are opaque base64url of `created_at:event_id` (events) or the day (reminders).
The owner API's answers are the generated messages of `proto/todofy/ui/v1`; the runtime tests read each with
the generated code (`tests/runtime/harness.py` `filled`).
Imported `legacy:<hash>` / `legacy:row-<id>` rows (CloudMailin era, or Mail Hero rows with no ledger event)
are an archive: the reports read their summaries by date, and only `wrangler d1 execute` reaches their text.
`GetLegacyText` (`legacyTexts/{id}`) serves an event's text only: a `legacy:` key's colon is outside AIP-122's
IDs, and no page links one. Review IDs are the ISO week in lower case (`gtdReviews/2026-w40`); page cursors
of a day or a week must name a real one (`core/owner_ui.text_cursor`), else `BAD_REQUEST`.

### backup.py (weekly D1 backup; `core/backup.py`, `core/sql/backup.py`)
```python
async def run(env, store, now: int) -> int | None   # called by the alarm loop after recover_interrupted:
                                                     # epoch ms to continue at while a job holds the ledger
def holds_ledger(env, store, now: int) -> bool       # owner writes answer UNAVAILABLE while True
def next_run(env, store) -> int | None               # for _next_alarm_ms; None without the BACKUPS binding
def overview(env, store, now: int) -> dict           # ServiceStatus.backup (todofy.ui.v1 BackupStatus)
```
Sunday 10:00 UTC, or due now on an object with no `backup_state` row (a new or wiped object); after a
backup the next run is the first Sunday 10:00 on a later UTC day. A job pages every table by rowid
(`rowid > last AND rowid <= max`, `max` fixed when it starts), reads `mail_events.payload` by rowid at
most 8 rows at a time, and writes one gzip NDJSON part per table per alarm invocation to
`backups/<job start>/` (e.g. `backups/2026-10-04T100002Z/`), then `manifest.json` last. Every job has its
own prefix and never deletes or rewrites another: a second job on the same day (a first deploy early on
a Sunday, lost object state) cannot cost a complete backup. Every table is in every backup,
`legacy_mail_text` included, so each backup restores on its own and a row D1 retention deletes leaves R2
once the last backup holding it rotates out. While the job runs (a few minutes; LEASE = 30 min at most)
the alarm skips the ledger step and the ticks (the metrics flush included) and owner writes get 503:
that is what makes the pages one snapshot. A job that ends writes one `backup` metrics point (§6). At most `BACKUP_QUERY_BUDGET` (30; tests use 1) D1 statements and 24 MiB of rows per invocation.
Retention, after each new manifest, keeps the newest 6 complete prefixes and deletes every incomplete
one older than the new one (the leftovers of failed or lost jobs). The job state is a JSON document in
the DO SQLite table `backup_state`; losing it only makes the next backup due now. Only
`tests/runtime/test_backup.py` binds the bucket (the shared test config has none, so no other scenario
pauses for a backup). `tools/backup_restore.py` downloads, checks, and turns a backup into SQL
(docs/cloudflare-setup.md §7).

### ops-v1 (lead; `core/ops.py`, `runtime/ops.py`, `gateway/src/ops.ts`)
The operations surface a dashboard Worker in the same account reaches through a service binding to the
gateway's named entrypoint `Ops` (`[[services]] service = "todofy" entrypoint = "Ops"`); no public route,
no Access policy. The contract is `../contracts/ops-v1` (README, generated schema, fixtures) with its IDL
`../proto/ops/v1/ops.proto`: the gateway implements the generated services (`ops_wire.ts`, types only) and the
core reads every input strictly and writes every output as a generated message (`ziyixi_proto.ops.v1`) with
the wire codec, which checks the contract's value rules. `Ops` forwards each method to one `ops_*` RPC method and turns `{"error": code}` into
`new Error(code)`; a failed call is `unavailable`. `core/ops.py` holds every rule the IDL cannot (guard expiry
against the clock, signals and health, canary result, digest items, the report's byte size) and builds outputs only from
numbers, booleans, timestamps and closed codes; `tests/unit/test_ops_core.py` validates them against the
schema and `test_ops_golden.py` pins their bytes. CI: the root `Contracts` job runs `test_ops_contract.py`,
`test_ops_core.py`, `test_ops_golden.py` and the gateway's
`test/ops.test.ts` (with Mail Hero's side of ops-v1); `tests/runtime/test_ops.py` (real bindings, a probe
Worker bound with `entrypoint = "Ops"`, like the dashboard) runs in `Todofy checks`. The golden canary is
`contracts/mail-received-v1/fixtures/canary_event.json`; its `event_id` differs from every other fixture's
(`test_mail_hero_compat.py` checks it), because the runtime suite posts all fixtures to one Worker.
```
status()          one D1 batch of 6 indexed reads (views.ACTIVE_COUNTS, ATTENTION_COUNT, RECEIVED_SINCE,
                  OLDEST_DUE, reminders.REMINDER_DAY, intents.COUNTS) + object storage; D1 failure → health "down"
setGuard(input)   object storage only (ops_guard); idempotent; shed until ≤ 36 h; expires by itself
canaryResult(id)  one primary-key read (ledger.get)
reportOps(report) object storage only (ops_report, ≤ 8 KiB); a later generated_at already stored wins
```
`status()` also reports the GTD ledger from the object's `gtd_state` (no D1 read): counters `inbox_open`,
`inbox_oldest_days`, `overdue`, `carryover_open`, `completed_7d` (the latest complete aggregate; left out
while unknown) and `review_age_days` (while `GTD_REVIEW_ENABLED`); signals `gtd_snapshot_stale` (warning,
`age_hours`: collection allowed and the last ok snapshot, or the first attempt, over 48 h ago) and
`review_overdue` (info, `days` > 10: shown, never `degraded`, never in the digest).
Object storage (`runtime/ops.DO_SCHEMA`, may be lost like the other object tables): `ops_guard` (epoch ms),
`ops_job_runs` (last run of each deferrable job), `ops_report` (the dashboard's latest report).

Canary events (`mail.received.v1` with top-level `canary`, `contract.MailEvent.canary_run_id`, stored in
`mail_events.canary_run_id`): same intake and idempotency; the normal summary step (same prompt, token
reservation, `llm_inflight`), recorded as Analytics Engine step `canary`; then `complete` without a
`summaries` row when the answer passes `clean_summary`, `render_todo_body` and `build_task_request`
(built, never sent), else retried up to 3 attempts for `summary_failed`/`llm_quota` and otherwise
`ignored` with the code. Where real mail would wait for the owner (`failed_summary`, crash limit, budget)
a canary ends `ignored`. `_create_task`/`_lookup` and `recover_interrupted` end a canary an older
release left at a Todoist step as `ignored` `canary_side_effect_blocked`; `allowed_actions(...,
canary=True)` is empty. `sql.REAL_MAIL` keeps canaries out of every list and count (attention page and
count, Overview counts, recent pages, the reminder), `metrics._walk` skips them, and the event detail
answers `canary: true`. A processing pause holds a canary `pending` (reported as `processing`).

Guard `shed` defers only: a new weekly backup (unless the last complete one is older than 7.5 days, 12 h
before `backup_stale` at 8 days, or there is none; a running job continues), a new GTD snapshot (unless the
last one is 48 h old), the retention tick and the metrics rollup (each unless its last complete run is 72 h old; a run that continues in a minute, one batch
of a backlog, does not count, so once due a job keeps its cadence until it has caught up). A deferred job's own time moves to min(guard end, bound); ending or changing the guard
makes them due again and wakes the object. Everything else keeps running: intake, the ledger steps,
canaries, recovery, the watchdog, the reminder/digest, report precompute and the cron wake.

Digest: `reminder.tick` adds `core.ops.digest(coordinator.latest_ops_report(), now)` (warning and
critical items of a report at most 36 h old, critical first) to the day's one task; an ops-only day
still gets its task (title `[Todofy System] 运维：{n} 项需要关注`), the claim freezes the text,
`mail_reminders.ops_count` and `ops_generated_at`, and a day without ops items keeps the exact old text.
Each report is listed by at most one day's reminder, and on its own (no attention) only from the UTC
day after it was generated, so the dashboard's 23:40 report is the next day's digest, never also a task
that evening.

### task-intent-v1 (`core/intents.py`, `core/sql/intents.py`, `runtime/intents.py`, `gateway/src/ops.ts`)
Another app in the account proposes Todoist tasks through the gateway's `Ops` entrypoint
(`proposeTasks`, `taskIntentStatus`; contract `../contracts/task-intent-v1`). Todofy never calls Gemini
for an intent, never fetches its URLs, and logs only the source, intent ID, task number, counts and codes.

Recording (`propose`, in this order): the input is checked against every schema rule (`core/intents.py`:
a strict read of the generated `TaskIntent` with the wire JSON codec for closed objects, known enum names
and types, then `fullmatch`, code-point lengths, distinct items; a lone surrogate is refused) and frozen
as its canonical JSON (its wire JSON: schema key order, compact, absent optionals left out) with its
SHA-256. `tests/unit/test_intents.py` pins the canonical bytes and hash of every intent fixture.

The messages and enums are generated from `proto/todofy/taskintent/v1/task_intent.proto` into the
stdlib-only package `ziyixi_proto` (the Worker's one `[project]` dependency; `uv sync` builds it,
`pywrangler sync` vendors it into `python_modules/`, never committed; `proto/README.md`). Results are
generated `TaskIntentResult` messages written with `to_wire`. The ledger keeps error codes by wire name
(`code_name`/`code_of`); a name this build does not know (a row written by a newer build) reads as
`ErrorCode.UNSPECIFIED` and is answered as `null`, never a crash. (1) A row
for `(source, intent_id)` answers first: another hash → `rejected`/`intent_conflict`; created →
`duplicate`; failed → re-queued unless a pause holds (`REQUEUE` + `REQUEUE_TASKS` in one batch: refused
tasks back to `pending`, unknown ones to `recheck`, a new 48-try/7-day window, the text restored if
retention had dropped it); otherwise its state (`pending`, or `paused` recorded while a pause holds). A failed intent proposed again while a pause
holds is answered `paused` (recorded, the pause's code), not its old failure: nothing was re-queued;
`taskIntentStatus` keeps answering `failed` until a proposal after the pause re-queues it.
(2) `TASK_INTENT_SOURCES` (unset: every source the contract knows; empty: none, an off switch that
leaves mail running) → `source_not_allowed`; an item URL whose host is not exactly on the source's list (lab:
`arxiv.org`) → `url_not_allowed`. (3) Maintenance, processing pause, `FORCE_PAUSE_TODOIST`, the Todoist
auth block, a backup lease → `paused`, nothing written. (4) One batch: the intent row, inserted only while
the source has fewer than 10 intents that UTC day (`RECORD`, count on `task_intents_created`), its task
rows with a frozen UUID `X-Request-Id` each (`RECORD_TASKS`, guarded by `changes() = 1`), and the row as
stored; no insert and no row → `daily_limit`, a row → a concurrent twin, replayed. Then the alarm is woken.

Creating (`step`, from `coordinator._step`): intents need Todoist, so they are considered only while
`_todoist_wait` allows calls; when mail and an intent are both due they take turns (`intent_turn`). A
step works on the oldest due intent: a task left `sending` was interrupted and becomes `unknown`; then at
most one read-only footer lookup and six creates, each re-gated by `_todoist_wait`, counted in the
15-minute window, under the watchdog, and no new call once the step has run 60 s. In subtasks mode the
parent (n = 0) goes first and every child sends `parent_id` instead of `project_id`
(`build_task_request(..., parent_id=)`); no child is sent before the parent exists or after it failed.
Task states (`core.intents.TaskState`): created; unknown (a timeout, lost answer, 500 or 2xx without an
ID) → footer lookup after `LOOKUP_DELAY_MS`: a match is created (the first of several), none fails the
task `todoist_result_unknown`, a failed scan retries up to 6 times; recheck (after the proposer's retry)
→ the same lookup, none resends the frozen request; 401/403 → the existing 6 h block, the task waits;
another 4xx or a request Todoist would refuse → failed `todoist_rejected`; 429/502-504/not sent →
durable backoff (`rate_limited` / `retry_wait`) until 48 tries or 7 days, then failed
`todoist_rejected`. The intent is `created` when every task exists (its text is dropped in the same
statement), `failed` when no task can progress, else `pending` due at its earliest actionable task.
Task text (`task_text`): content is the title as given; the description is the item's description, its
URL, in separate mode `— <parent title>`, and the footer `Todofy intent: <source>/<intent_id>#<n>`
(`has_footer` matches it only as the last line, so quoted text cannot pass for another task), as blocks separated by a blank line. D1 per step: at most 17
statements. Metrics: Analytics Engine steps `intent` (counted in `todoist_creates`) and `intent_lookup`
(`todoist_lookups`); `status()` counters `intents_pending` and `intents_failed_7d` (its sixth read).
Retention: a failed intent's text after 30 days; finished intents 400 days after their last change,
their task rows first. Both tables are in the weekly backup; a restored pending intent resumes
creating its unfinished tasks (reconcile with the proposer first, like mail).

### health (lead)
`GET /health` on the hooks hosts is answered by the gateway alone: `{"build", "service": "todofy",
"status": "healthy", "timestamp"}` (the newsletter's preflight reads `service` and `status`). The
"oldest due row" signal lives in the Overview `oldest_due_at`.

### Fakes (T)
Extend `tests/fakes/server.py` rather than forking it: `gemini_fake.py` (x-goog-api-key check,
`generateContent` queue, `usageMetadata`, records `systemInstruction`/`responseSchema`) and
`todoist_fake.py` (Bearer check → 401, auto-increment ids, `GET /api/v1/tasks` paged
`{results, next_cursor}` for one project or all, `GET /api/v1/tasks/completed/by_completion_date` paged
`{items, next_cursor}` with the cursor left out on the last page, task metadata (priority, due, deadline,
labels, added_at), `complete()`/`delete()`, records `X-Request-Id`); both seed 429 with `Retry-After` in
seconds and HTTP-date forms, `delay_ms`, and `hang`. The reports probe (`tests/runtime/reports_probe`) also
has a Durable Object, `GtdProbe`, that runs `runtime/gtd.py` on a real object storage at any `now`.

## 6. Metrics and ops queries

Two sinks, with different jobs (`core/metrics.py`, `runtime/metrics.py`, `gateway/src/metrics.ts`):

- **Workers Analytics Engine**, binding `METRICS`, dataset `todofy_metrics`, on both Workers. Write-only
  from the Workers (reading needs the SQL API and an account token, which the Workers never hold), so it
  serves the owner's ad-hoc queries below, never the UI. Workers Free includes 100,000 points written
  and 10,000 read queries per day; points are kept three months. Local dev binds a dataset that accepts
  every write and stores nothing, so shapes are unit-tested instead (≤ 20 blobs, ≤ 20 doubles, one index
  ≤ 96 bytes, ≤ 250 points per invocation). A failed write never fails the request or step: the core
  logs it (`{"metrics": "write_failed"}`), the gateway drops it silently.
- **D1 `daily_metrics(day, key, value)`** (migration `0002`), for the budget page's 30-day trends
  (`GET /api/v1/metrics/daily?days=1..90`, default 30; finished UTC days only, oldest first). The
  charts (`web/src/components/TrendChart.tsx`) colour series with the categorical `--series-1…5`
  tokens, never the status tones (accent and ok are both green); lines also differ by dash, stacked
  bars have a gap. The token chart shows up to five models, largest total first; with more (a changed
  model list), the four largest plus one 其他 series, so no two series share a colour. Every chart also has a text summary and a table.

Point layouts (one dataset; `blob1` tells them apart):

| Writer | `index1` | `blob1` | `blob2` | `blob3` | `blob4` | `double1` | `double2` | `double3` | `double4` |
|---|---|---|---|---|---|---|---|---|---|
| gateway, per request and cron | route | host kind: `owner`, `hooks`, `unknown`, `cron` | method (`OTHER` if unusual) | route template (`/api/v1/mailEvents/{id}`, `asset`, `page`, `other`, `wake`) | status class `2xx`…`5xx` | wall ms to response headers | request Content-Length (0 if none) | response Content-Length (0 if none) | — |
| core, per upstream step | step | step: `summary`, `canary` (a canary's summary call), `task`, `lookup`, `reminder`, `report`, `backup`, `gtd` (one read-only snapshot page), `review` (the Sunday review's create) | outcome: `ok`/`failed` (Gemini), `TaskResult` (task, reminder), ledger state (lookup) | error code or empty | Gemini model or empty | upstream wall ms | tokens in (prompt) | tokens out (total − prompt) | requests sent (models tried, POSTs; 0 for lookups) |

Never written: paths, query strings, event IDs, subjects, addresses, the owner's identity, upstream bodies.
`backup` is one point per job, written when it ends: outcome `ok`/`failed`, code `storage_error` or
`lease_expired`, `double1` the job's wall ms from start to end.

`daily_metrics` keys per finished UTC day: `mails_received` (always, 0 included: it marks the day as
recorded), `mails_completed`, `mails_failed` (moves to `failed_summary`), `latency_p50_s`/`latency_p90_s`
(arrival → `complete` of the day's completions, nearest rank), `gemini_calls`, `gemini_tokens:<model>`,
`todoist_creates`, `todoist_lookups`; zero counters are not stored. How it stays within the D1 budget:

- Mail counts and latencies come from `event_transitions`, walked by rowid from a cursor kept in the
  object's SQLite (`metric_flush`): ≤ 3 pages of 500 per alarm, so each transition is read once (a few
  hundred rows read per day, never a scan).
- Step counters (`gemini_*`, `todoist_*`) are added to the object's SQLite (`metric_counts`) when a step
  ends, not to D1. Like the data point, the counter write is best effort: `runtime/metrics.record`
  never raises and logs `{"metrics": "count_failed"}` (a full object storage, say), and every caller
  runs it after the step's result is committed (the ledger transition, the reminder's `FINISH`), so it
  can never sit between a Gemini call or a created Todoist task and its record. A failed write only
  under-counts that day (`tests/runtime/test_metrics_daily.py`, `tests/unit/test_metrics_record.py`).
- A few minutes after UTC midnight (`metric_flush.next_at`, one more time in `_next_alarm_ms`) the
  object writes each finished day as one `INSERT … SELECT … FROM json_each(?)` statement plus one bounded
  expiry (400 days), in one batch: about a dozen rows plus their primary-key index, i.e. a few dozen D1
  rows written per day. A backlog (days without alarms) is caught up at most 7 days per flush, a minute
  apart.
- If the object's storage is lost (cutover, `crash_and_restart(lose_object_storage=True)`), counting
  restarts at the newest transition; that day is only partly seen and stays `recorded: false`, and so
  do days that were never written. A transition committed just after midnight with an older timestamp
  than one already walked is dropped rather than rewriting a finished day.
- The same restart happens when the database changes under a kept object: a backup restore that
  production is switched to, or a D1 Time Travel restore in place (cloudflare-setup.md §7).
  `event_transitions.id` has no AUTOINCREMENT, so the restored database hands out ids again from its own
  `max(id) + 1`; walking on from the old cursor would skip them and write those days with
  `mails_received = 0`. `metric_flush` therefore keeps the counted row's `event_id` and `at` next to the
  cursor, and every flush first reads that row by id (`CURSOR_ROW`, one rowid lookup). A missing or
  different row logs `{"metrics": "cursor_reset"}` and takes the lost-storage path: the switch day and
  the days since the last written one stay `recorded: false`. Cursor 0 (an empty ledger) is not checked.

### Ops queries (read-only)

For checking production from the owner's machine (`npx wrangler login`). None of these prints row
content; keep it that way (the repository and its logs are public).

| Question | Where |
|---|---|
| Last backup, its key, rows, size, next run, last failure | owner UI → 健康 → 备份 (ServiceStatus `backup`, todofy.ui.v1 `BackupStatus`) |
| What the bucket holds | `npx wrangler r2 bucket info todofy-backups` (object count and size; wrangler 4.142.0 has no `r2 object list`, the dashboard's R2 browser lists keys) |
| One backup's tables, row counts and part hashes | `npx wrangler r2 object get todofy-backups/<key>manifest.json --file manifest.json --remote` (names, counts and SHA-256 only) |
| Backup job progress or errors | Workers Logs of `todofy-core`, filter on the `backup` field: `planned`, `done` (rows, bytes), `deleted`, `error` (exception type, step), `failed` (`storage_error`, `lease_expired`), `retention_error` |
| Legacy text size (drives backup size and time) | `SELECT count(*) AS n, sum(length(CAST(text AS BLOB))) AS bytes FROM legacy_mail_text` via `npx wrangler d1 execute <database> --remote --command "..."` (reads each legacy row once) |
| Account-wide D1 rows read/written today (shared with Mail Hero) | Cloudflare dashboard → D1 → metrics, or Workers & Pages → usage; a backup reads each row of every table once |
| GTD ledger: the day's snapshot and aggregates (counts only, no task text) | owner UI → 更多 → GTD, or `SELECT day, status, task_count, pages, error_code FROM gtd_snapshots WHERE day >= '<YYYY-MM-DD>'` and `SELECT * FROM gtd_daily WHERE day >= '<YYYY-MM-DD>'` via `npx wrangler d1 execute <database> --remote --command "..."`; Workers Logs field `gtd` (`collect`, `review`: states, codes, counts) |
| Daily metrics as stored (counts only, no content) | `SELECT day, key, value FROM daily_metrics WHERE day >= '<YYYY-MM-DD>' ORDER BY day, key` via `npx wrangler d1 execute <database> --remote --command "..."` (the primary-key index; a dozen rows a day) |
| Metrics write failures or a cursor restart | Workers Logs of `todofy-core`, filter on the `metrics` field: `write_failed` (Analytics Engine), `count_failed` (the object's counters), `cursor_reset` (the ledger database changed, §6); the gateway drops a failed write without a log line |

### Analytics Engine SQL API

Create an account API token with **Account Analytics: Read** only, keep it out of the repo and the
Workers, and query:

```sh
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_ANALYTICS_TOKEN" --data-binary @query.sql
```

Rows are sampled at high volume, so always count with `SUM(_sample_interval)` and weight quantiles by it.

1. Gateway traffic and wait per route over the last day (spot a slow or failing path):
   ```sql
   SELECT blob1 AS host, blob3 AS route, blob4 AS status, SUM(_sample_interval) AS requests,
          quantileExactWeighted(0.5)(double1, _sample_interval) AS p50_ms,
          quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms
   FROM todofy_metrics
   WHERE timestamp > NOW() - INTERVAL '1' DAY AND blob1 IN ('owner', 'hooks', 'unknown', 'cron')
   GROUP BY host, route, status
   ORDER BY requests DESC
   ```
2. Failures of upstream steps by code, per hour over the last week:
   ```sql
   SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour, blob1 AS step, blob3 AS code,
          SUM(_sample_interval) AS steps
   FROM todofy_metrics
   WHERE timestamp > NOW() - INTERVAL '7' DAY
     AND blob1 IN ('summary', 'task', 'lookup', 'reminder', 'report', 'backup', 'gtd', 'review') AND blob3 != ''
   GROUP BY hour, step, code
   ORDER BY hour DESC, steps DESC
   ```
3. Gemini tokens and latency by model and step, per day over the last month:
   ```sql
   SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day, blob4 AS model, blob1 AS step,
          SUM(_sample_interval) AS calls, SUM(double2 * _sample_interval) AS tokens_in,
          SUM(double3 * _sample_interval) AS tokens_out,
          quantileExactWeighted(0.9)(double1, _sample_interval) AS p90_ms
   FROM todofy_metrics
   WHERE timestamp > NOW() - INTERVAL '30' DAY AND blob1 IN ('summary', 'report')
   GROUP BY day, model, step
   ORDER BY day DESC, tokens_in DESC
   ```
4. Todoist retries and slow creates (attempts > 1 means inline retries happened):
   ```sql
   SELECT blob1 AS step, blob2 AS outcome, SUM(_sample_interval) AS steps,
          SUM(double4 * _sample_interval) AS requests,
          quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_ms
   FROM todofy_metrics
   WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob1 IN ('task', 'reminder', 'lookup')
   GROUP BY step, outcome
   ORDER BY steps DESC
   ```

These queries were written against Cloudflare's SQL reference and have not been run against the account.
