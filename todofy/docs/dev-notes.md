# Todofy developer notes

Todofy is a TypeScript gateway plus a private Python Durable Object. It owns mail/summary/report data, not Tasks'
planning or task creation. Read the [gateway contract](gateway-contract.md), [Mail API](mail-api.md) and root proto
before changing a boundary. Source and current contracts supersede the retired rewrite proposals.

## 1. Build and test

```sh
bazel test //todofy:check
bazel build //todofy
bazel test //todofy:runtime_tests --local_test_jobs=1
bazel test //todofy:runtime_test_routing
```

Bazel declares the compiled UI, fixed Node/workerd/Pyodide/SDK and synthetic upstreams. A scenario file runs whole,
in its original order, with its own module-level server and state. Collection/runtime skips fail the target; native
JUnit is the result record. There are no custom shard weights, manual warm-ups or separate JUnit merger.

For raw-source interactive work, use the root workspace locks and thin `node proto/tools/ensure.mjs` materializer.
Keep local bindings and `.dev.vars`; D1 commands explicitly use `--local`. The gateway is primary when running the
original paired dev server: it owns the port, host routing, assets and cron. Core vars come from its own config,
not primary-only CLI overrides. Never publish a production config from this development loop.

For the interactive paired local server, from `todofy/` after raw-source materialization:

```sh
uv run pywrangler dev -c gateway/wrangler.toml -c wrangler.toml \
  --port 8787 --local-upstream todofy.localhost:8787 \
  --var TODOFY_PUBLIC_HOST:todofy.localhost --var TODOFY_HOOKS_HOSTS:todofy-hooks.localhost \
  --var BUILD_SHA:dev
```

## 2. Source map

| Directory/module | Responsibility |
| --- | --- |
| `gateway/src/` | Host routing, authentication, CSRF, assets, cron and RPC/transcoder adapters |
| `worker/todofy/core/` | Host-testable stdlib rules, vocabulary, prompts, validation and SQL definitions |
| `runtime/coordinator.py` | The only ledger writer; alarms, budgets, summary work and periodic ticks |
| `runtime/ledger.py` | Frozen events, compare-and-set transitions and owner request receipts |
| `runtime/model.py`, `model_settings.py` | Provider-neutral Router calls and separate saved mail/report selections |
| `runtime/reports.py`, `retention.py` | Bounded reports/precompute and retention |
| `runtime/owner_ui.py`, `mail.py` | Current owner/private Mail methods |
| `runtime/backup.py`, `metrics.py`, `ops.py` | Weekly D1 snapshots, counters and content-free operations |
| `core/sql/` | Every D1 statement and its expected index |
| `migrations/`, `api/`, root `proto/`/`contracts/` | Storage history, machine contract, current messages and frozen fixtures |
| `tests/unit`, `tests/fakes`, `tests/runtime` | Host rules, loopback providers and real paired workerd scenarios |

`runtime/api.py`/`owner_api` retain only the dated old-gateway compatibility surface. The gateway's current public
entrypoints are `Ops` and `Mail`. Historical column names mentioning Todoist remain data identities, not an active
integration. Do not rename stored identities during build or doc cleanup.

## 3. Python Workers rules

- `Default.fetch` returns 404; the core has no public routes. The gateway reaches
  `COORDINATOR.getByName("inbox-v1")` over RPC, with arguments it chose itself.
- Use `self.env`. Binding access is through JsProxy; absent attributes can raise, so the existing config readers
  supply defaults. Public config, personal inputs and provider connections keep their existing separate owners.
- Expected outcomes return the existing plain result objects. Python exceptions lose structured attributes over
  RPC. Return dictionaries/lists/strings/bytes rather than tuples or element-wise memoryviews.
- D1 uses `prepare(...).bind(...)`, `first/all/run` and atomic `batch`. DO SQLite uses synchronous
  `ctx.storage.sql.exec`. Alarms use epoch milliseconds; D1/business deadlines use Unix seconds.
- `runtime/interop.py` owns JS conversion, WebCrypto and bounded stream reading. `to_js` creates plain JS objects;
  `read_capped` cancels oversized input without buffering the rest.
- Model transport uses the shared Router client. A deadline bounds headers and body; cancellation aborts the
  binding request. Prompts, input fencing, business retry and token reservation remain Todofy's responsibility.
- Use host tests for pure rules, real workerd tests for JsProxy/stream/D1/DO behavior, and synthetic providers only.

## 4. Ledger, SQL and model invariants

Vocabulary comes from `core.vocab`, matching stored CHECK constraints and the generated messages' wire names.
User-facing Chinese labels live in the UI's label module. Source/event identities and payload hashes are frozen.

Every D1 statement is a `Query` constant under `core/sql/`, with the key/index it uses. The SQL test discovers these
queries and checks their actual query plans. Keep active/due/attention predicates in the existing shared SQL rules,
not slightly different copies in readers.

A state transition is one `(state,version)` compare-and-set plus its transition/summary/owner-action effects in the
same batch. Dependent statements are guarded by the preceding `changes() = 1`; a lost transition writes no
secondary record. Completion drops raw payload and freezes the summary/model. Deleted summaries leave the event
ledger, so they cannot be summarized again.

Only one coordinator may write a ledger. Recovery treats interrupted summaries as abandoned; a second live writer
would reset the first one's in-flight work. Keep this invariant on database restore, replacement and reverts.

A model call reserves tokens before execution, then settles actual or conservative unknown usage on every exit.
Saved model changes affect future work, not completed summaries. `GEMINI_DAILY_TOKEN_BUDGET` and historical metric
keys are legacy physical names covering the current provider-neutral calls. Do not reset budgets when changing
transport or model choice. Prompt snapshots and output-schema examples are tested separately from frozen legacy
contract fixtures.

Reports use their bounded recent-mail window and optional pending-mail carryover. Precompute and on-demand work keep
the existing daily/hourly caps and bounded retry. An unusable result is not served as an empty successful report.
Only the owner deletes summaries; ordinary retention does not. Source constants and SQL own current bounds.

## 5. Gateway and current APIs

Access runs before owner body parsing; exact Origin, CSRF header and JSON checks run before mutations. Use the shared
edge-auth adapters and root transcoder/client, not another JWT/CSRF implementation. Machine routes retain their
existing credential/error envelopes; owner APIs use `google.rpc.Status`.

Successful core answers remain pre-encoded through the gateway except list pages, whose opaque tokens it composes.
Do not decode and rewrite large summaries, reports or legacy text just to forward them; the CPU suite protects that
path and existing budgets. Binding-provided Mail access gates reads/writes before body parsing.

The authoritative RPC shapes and errors are in [gateway-contract.md](gateway-contract.md); public owner/report/mail
messages are in root proto. Update both sides of an internal signature in one change, with compatible deployment
ordering. Keep dated old-client responses until [their window](../../docs/history.md#owner-api-compatibility) closes.

## 6. Backups, metrics and local harness details

Weekly backups freeze their column set, write table parts and the manifest last, and temporarily hold ledger writes.
Restore into a new empty D1 and verify it before switching bindings under maintenance. Details and actual commands
are in [setup/recovery](cloudflare-setup.md#7-backups-and-restore).

Analytics Engine is write-only from Workers and best-effort. Points contain route templates, safe codes, timings and
counts, never subject/body/owner/URL. D1 `daily_metrics` supplies finished-day UI trends. Physical `gemini_*` keys and
pre-retirement `todoist_*` rows keep their historical meaning; missing observations stay unrecorded.

The metrics walker uses indexed transition pages and bounded flushes. It checks the saved cursor's row identity so
switching/restoring D1 cannot silently skip reused row IDs. Lost or changed state restarts observations rather than
inventing a successful empty period. Metrics failures never change the business outcome they describe.

The real local harness deliberately handles these observed platform behaviors:

- `wrangler dev` can hold a headers-only refusal until the unread body is cancelled.
- Its pooled proxy can lose an unsafe method at the idle timeout. The existing harness refreshes an idle connection
  with a safe GET; it does not retry the business request itself.
- Local D1/R2 use SQLite. Do not open a second CLI writer beside a running server. `Worker.d1` uses that server's
  Local Explorer; bucket file reads happen after the server stops.
- Each test process/pair owns its ports, registry and persist state. A standalone gateway cannot accidentally reach
  another test's core. Cancellation/deadline tests use actual hangs and socket cleanup, not sleeping assertions.
- The first core invocation includes Pyodide startup. Bazel supplies the pinned cached bundle and native workerd;
  it does not perform an unpinned runtime download or run package generation during a test.

Operational views show counts/status, not private content. Use owner health for backup state, Home for shared usage
and Workers logs for safe error types/codes. A production content read or a real model/recompute requires its own
current authorization; local fixtures do not prove business success.
