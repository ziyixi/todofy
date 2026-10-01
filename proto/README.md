# `proto/`: protobuf as the IDL of the cross-app contracts and the apps' UI APIs

Protobuf is the interface definition language (IDL) of every interface the repository defines: the
cross-app contracts and each app's UI API (the HTTP/JSON between its UI and its Worker, [HTTP
APIs](#http-apis)). The wire stays JSON: each contract keeps its JSON bytes, and every API speaks the same
snake_case form, through a small *wire JSON profile* codec per language. The `.proto` files give every app
generated types and enum tables, `buf lint`, `buf breaking` and Google's api-linter make "renamed,
renumbered, retyped, removed or not AIP-shaped" a CI failure, and a shared transcoder and client route and
call the HTTP APIs from the same descriptors.

Status: `task_intent.proto` is the IDL of `contracts/task-intent-v1`, and both sides run on the generated
code (2026-10-01): Lab (TypeScript) builds its intents as generated messages and reads Todofy's results with
the codec; todofy-core (Python) reads every input strictly with the codec and writes every result as a
generated message. Todofy's gateway takes its method signatures from the generated service (types only).
The wire bytes did not change (each side's tests pin them). `contracts/task-intent-v1` keeps the JSON
Schema and fixtures as the published wire description, and `task-intent-v1.ts` only the value rules the IDL
cannot express (bounds, URL hosts). `lab/ui/v1` is Lab's owner API (2026-10-01): Lab's Worker serves it
through `ts/http-transcoder.ts` and Lab's UI calls it through `ts/http-client.ts`; it is the pilot of the
HTTP APIs, which ops-v1, recommendation-v1, mail-received-v1 and every app's UI API follow.

## Rules

1. **One folder.** `proto/` holds the buf module (`buf.yaml`, `buf.lock`, `buf.gen.yaml`, the `.proto`
   files under their package path), the pinned toolchain and the hand-written codec runtimes. Apps never
   keep a copy of any of it.
2. **Generated code is never committed.** It is gitignored. The commands developers already run
   generate it: `npm ci` / `npm install` in a TypeScript app (its `postinstall`), `uv sync` / `uv run` in
   Todofy (the build of `ziyixi-proto`), and CI. A missing generated directory never breaks dependency
   resolution: the package manifests are committed, only the files their exports point at are generated.
3. **One version.** buf, protoc-gen-es and the protobuf-es runtime are pinned once, exactly, in
   `package.json` and `package-lock.json` here. No app has its own `@bufbuild/protobuf`: an app imports the
   runtime from `@ziyixi/proto/protobuf`, which resolves this folder's copy, so every bundle holds exactly
   the runtime the generator targets. `.github/scripts/test_proto.py` enforces it (and the wiring below).
   Generation is deterministic; CI generates twice and compares.
4. **Lint and breaking.** `buf lint` uses `STANDARD` (AIP-aligned: `_UNSPECIFIED` zero values, enum prefixes,
   `lower_snake_case`, versioned packages) and `COMMENTS` (every element documented); exceptions are written
   next to the element with `buf:lint:ignore` and a reason, and the AIP-shaped HTTP packages are excused (in
   `buf.yaml`) only from the two response-name rules the AIPs contradict. Google's api-linter
   (`scripts/api-lint.sh`, one pinned version) checks every package but `prototest/` against the AIPs; its
   exceptions are `(-- api-linter: ... --)` comments with a reason, next to the element. `buf breaking` uses
   `FILE`, the strictest category. `tools/profile_breaking.py` adds what buf cannot see but the profile treats
   as wire: an existing field gaining or losing `(google.api.field_behavior) = REQUIRED` or explicit presence
   (`optional`), and a new `REQUIRED` field in an existing message. `scripts/rules-selftest.sh` proves the
   rules bite (17 cases).
5. **Adding an enum value is compatible by design**, so neither buf nor the profile check flags it. What
   keeps consumers working is the reading rule: outputs are read leniently (an unknown enum name reads as
   `*_UNSPECIFIED`, an unknown field is skipped, both listed in `unrecognized`), and a consumer branches on
   known values with a default, never inferring success from an error code. Inputs are read strictly.

## Layout

| Path | What |
| --- | --- |
| `buf.yaml`, `buf.lock` | The module (`path: .`, tooling directories excluded), lint and breaking rules, the `buf.build/googleapis/googleapis` dependency pinned by commit and digest |
| `buf.gen.yaml` | protobuf-es v2 (`target=ts`, `import_extension=ts`, `erasable_syntax=true`) into `ts/` |
| `<package path>/*.proto` | One directory per proto package: `todofy/taskintent/v1/task_intent.proto` is `todofy.taskintent.v1`; `lab/ui/v1/*.proto` is `lab.ui.v1`, Lab's owner UI API |
| `package.json`, `package-lock.json` | The toolchain pins (`dependencies`: buf, protoc-gen-es, the runtime) and this folder's test tools (`devDependencies`) |
| `ts/` | The TypeScript package `@ziyixi/proto`. Committed: `package.json` (its exports), `wire-json.ts` (the codec), `http-path.ts`, `http-rule.ts`, `http-transcoder.ts`, `http-client.ts` and `rpc-status.ts` (the HTTP runtime, [HTTP APIs](#http-apis)), `protobuf.ts` / `protobuf-wkt.ts` (the runtime re-exports). Generated: every directory (`ts/todofy/...`, `ts/lab/...`, `ts/google/...`) |
| `python/` | The Python package `ziyixi-proto`. Committed: `pyproject.toml` (static metadata, uv cache keys), `build_backend.py`, `src/ziyixi_proto/__init__.py` and `wire_json.py` (the codec). Generated: every directory under `src/ziyixi_proto/` |
| `tools/ensure.mjs` | Installs the pinned toolchain when `node_modules/` does not match the lockfile, and generates both languages when its stamp (`.generated.json`, ignored) does not match |
| `tools/gen_py.py` | The stdlib-only Python generator (frozen dataclasses, `IntEnum`s, field tables) |
| `tools/profile_breaking.py` | The profile's breaking rules (rule 4) |
| `scripts/breaking.sh`, `scripts/rules-selftest.sh` | The breaking gate against a base commit; the rules self-test |
| `scripts/api-lint.sh`, `tools/api-linter/` | Google's api-linter on every package but `prototest/`: a Go tool module (`go.mod` pins api-linter and the Go toolchain, `go.sum` every checksum) that the script builds into `.tools/` (ignored) |
| `prototest/v1/prototest.proto` | Test fixtures of the runtimes, never used by an app: a message with every field kind of the profile and a service with every kind of HTTP binding |
| `testdata/http-cases.json` | The HTTP runtime's cases on `prototest.v1.BookService`: 46 requests and what the transcoder answers, 12 request messages and what the client sends; every implementation (a Python transcoder later) runs them |
| `testdata/wire-profile-cases.json` | 62 edge cases (timestamps, integer and double spellings, enum look-alikes, maps, missing fields, null) that both codecs must answer identically |
| `test/*.test.ts`, `test/python/` | The codec and IDL tests, the same cases in both languages; `test/cross-language.test.ts` pipes bytes through both codecs (`test/python/roundtrip.py` in a child process); `test/ensure.test.ts` runs `tools/ensure.mjs` on a copy of this folder (a deleted toolchain, an abandoned lock, the commands Windows needs) |

Every directory directly inside `ts/` and `python/src/ziyixi_proto/` is generated (`.gitignore`); every
file there is hand-written.

## How it works

`tools/ensure.mjs` checks two things: that `node_modules/` holds every package `package-lock.json` pins,
at that version (the generated code imports the protobuf-es runtime from there, so a deleted
`proto/node_modules` is restored even when the generated files are current), and that its inputs (every
`.proto` file, `buf.yaml`, `buf.lock`, `buf.gen.yaml`, `package-lock.json`, itself and `gen_py.py`) and every
generated file still match the stamp `.generated.json`. When both hold it exits in about 0.1 s without
touching the network. Otherwise, under a lock, it installs the whole lockfile (`npm ci`: the generator, the
runtime and this folder's test and editor types), runs `buf generate` and `buf build | gen_py.py` into a
temporary directory, moves the result into `ts/` and `python/src/ziyixi_proto/`, and writes the stamp. It
strips the calling npm's settings from the environment, so `npm ci --prefix lab/worker` cannot redirect the
nested install.

The lock (`.generate.lock/owner.json`) names its holder's pid and host. Parallel installs wait for it and
say whom they wait for. A run interrupted by Ctrl-C or killed leaves the lock behind; the next run sees
that the pid no longer runs on this host, takes the lock over at once and removes the dead run's temporary
directories. A lock it cannot check (another host on a shared disk, or one without an owner file) is taken
over after 10 minutes; a waiter gives up only after 15.

Every tool starts without a shell, so the same steps run on Windows: buf is its JavaScript entry point run
by the current `node`, as is npm on Windows (`npm.cmd` cannot be spawned without a shell), and
`buf.gen.yaml` starts `protoc-gen-es` as `node <its entry point>`. `gen_py.py` runs on `PROTO_PYTHON` (the
build backend passes its own interpreter), else `python3`, or `python` on Windows. Only the macOS and Linux
paths are exercised (locally and in CI); the shell scripts under `scripts/` are for CI and need a POSIX
shell.

**TypeScript.** An app declares `"@ziyixi/proto": "file:../../proto/ts"` and `"postinstall": "node
../../proto/tools/ensure.mjs"`. npm links `node_modules/@ziyixi/proto` to `proto/ts` whether or not anything
is generated, then the postinstall generates. Every npm script that compiles, tests or serves the generated
code (`tsc`, `vitest`, `wrangler`) has a `pre<script>` that runs the same command, in the app and in any
package that imports the app's sources, so `npm run typecheck`, `npm test` or `npm run dev` after a pull or a
branch switch that changed a `.proto` file regenerates first instead of using stale types (`test_proto.py`
requires those scripts). Generated files import `@bufbuild/protobuf`, which Node, TypeScript, vitest and
wrangler's esbuild resolve from the real path, `proto/node_modules`: one copy for every app, no `paths`,
`dedupe` or alias settings. Measured on 2026-10-01 with Lab's production dry-run: its `index.js` grew from
166,530 to 336,996 bytes (gzip 44,365 to 79,211; wrangler's upload total 162.63 to 329.10 KiB, gzip 43.45 to
77.70 KiB), of which the protobuf-es runtime is about 145 KB (descriptor decoding: `descriptor_pb`, the
registry, the binary reader) and the generated code and `wire-json.ts` about 21 KB. Todofy's gateway imports
types only: +0.1 KiB (a new bound).

```ts
import { create } from '@ziyixi/proto/protobuf';
import { TaskIntentResultSchema, State } from '@ziyixi/proto/todofy/taskintent/v1/task_intent_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';

const { message, unrecognized } = fromWire(TaskIntentResultSchema, JSON.parse(text)); // an output: lenient
if (message.state === State.CREATED) { /* ... */ }
```

Across a Workers service binding (not gRPC), `WireService<typeof TaskIntentService>` turns a generated service
into the entrypoint's methods (`proposeTasks(input: WireObject): Promise<WireObject>`): the caller declares its
binding with it, the implementation `implements` it, and both sides keep plain JSON objects on the wire.
`wireEnum(ModeSchema, Mode)` gives one enum's wire names and back for code that stores or shows them outside a
message (a D1 column, an owner API), and `WireName<typeof Mode>` is the union of those names as a type
(`'subtasks' | 'separate'`): Lab's internal records derive from it, so a new enum value fails Lab's typecheck
until it maps it to `lab.ui.v1`. Python has `wire_name(member)` and `wire_member(cls, name)`.

**Python.** Todofy declares `ziyixi-proto` in its `[project] dependencies` (todofy-core imports it) with
`[tool.uv.sources] ziyixi-proto = { path = "../proto/python" }`. uv builds it with
`python/build_backend.py` (standard library only, no build dependencies to download), which checks the
stamp the way `ensure.mjs` does and runs `ensure.mjs` only when it does not match, then packages
`src/ziyixi_proto`. uv rebuilds whenever one of the package's `cache-keys` changes (the stamp's inputs, the
hand-written runtime and the stamp itself), so `uv run pytest` after editing a `.proto` file or switching
branches regenerates by itself. The stamp is a key because it is gitignored with the generated code: after
`git clean -fdX` uv would otherwise reinstall its cached wheel and leave the source tree, which pywrangler
vendors from, without generated code. A generation rewrites the stamp, so the next `uv run` rebuilds once
more (ensure.mjs finds nothing to do). One case no key can catch: a clean when the cached wheel was built
while the stamp was missing too (only one `uv` command since a fresh clone). So the source tree has two
more guards: Todofy's `package.json` runs `ensure.mjs` as its postinstall (every pywrangler command needs
that `npm ci` for wrangler, and a clean removes `node_modules/` too), and its runtime test harness runs
`ensure.mjs` before `pywrangler sync`.

```python
from ziyixi_proto.todofy.taskintent.v1 import task_intent_pb as pb
from ziyixi_proto.wire_json import from_wire, to_wire

read = from_wire(pb.TaskIntent, json.loads(text), strict=True)  # an input: strict
```

The source is not editable on purpose: todofy-core imports the package, so it is in Todofy's
`[project] dependencies`, and `pywrangler sync` vendors it into `python_modules/` from this same source
(`pylock.toml` lists it as a directory). pywrangler builds that wheel inside Pyodide, which cannot start
processes; the backend then only verifies the stamp (which `uv sync` on the host already made current, so
`uv sync` runs first) and copies files. pywrangler re-syncs only when `pyproject.toml` or `pylock.toml`
change, so Todofy's runtime test harness compares the vendored copy with the installed one and forces a
sync when they differ (after running `ensure.mjs`); for `pywrangler dev` by hand after an IDL
change, run `uv run pywrangler sync --force`. If Pyodide's build still reports that the generated code is
not current, run `npm run ensure` here and retry.

**Editors.** After the app's install, VS Code resolves every import: TypeScript through the linked package
(the generated `.ts` files are real files under `proto/ts`), Python through the installed package in
`todofy/.venv` (select that interpreter). The files of `proto/` itself resolve too, since the app's
install put this folder's whole lockfile (vitest, Node and Workers types) in `proto/node_modules`.

**Offline.** Only the first generation needs the network (npm for the toolchain, buf.build once for the
locked googleapis module, which buf caches in `~/.cache/buf`). After that, reinstalls and regeneration
work offline (`npm ci --offline`, `uv sync --offline`).

## Common tasks

```sh
cd proto
npm ci                                   # the toolchain and this folder's test tools
npm run generate                         # regenerate now (any app's npm install / uv sync also does it)
npm run lint                             # buf format + buf lint
npm run api-lint                         # Google's api-linter (needs Go; tools/api-linter/go.mod)
npm run breaking -- "$(git merge-base HEAD origin/main)"   # buf breaking + the profile rules
npm run selftest                         # the rules still bite
npm run check:deterministic              # generate twice more, compare with the installed output
npm run typecheck && npm test            # both codecs (TypeScript, then Python 3.14 through uv)
```

After editing a `.proto` file or `wire-json.ts`/`wire_json.py`, a TypeScript app's next `npm run
typecheck|test|dev` regenerates first (its pre-scripts); Todofy's next `uv run` rebuilds by itself.
`wire-json.ts` itself is not generated: the apps read it in place.

**Adding a contract.**

1. Create `<app>/<service>/v1/<name>.proto` with `package <app>.<service>.v1;` (one directory per service;
   the directory must match the package). Mirror the JSON contract field for field: field numbers in the
   JSON Schema's property order (so field-number order reproduces today's key order), the v1 field names,
   every enum with its AIP-126 prefix and an `_UNSPECIFIED` zero value, `REQUIRED` where the schema
   requires a field. Only the kinds the profile supports: `string`, `bool`, 32-bit integers, `double`, enums
   (top-level or nested in a message), messages, `repeated` fields, maps with `string` keys and
   `google.protobuf.Timestamp`; anything else (64-bit integers, `float`, `bytes`, oneofs, nested messages,
   other well-known types as fields) stops generation with an error.
2. `npm run lint` until clean, then `npm run generate`.
3. Add the contract's fixtures to `test/` and `test/python/` (round trip byte for byte, enum and field sets
   equal to the JSON Schema), and a new kind of field to `testdata/wire-profile-cases.json` first.
4. In each app that uses it: the TypeScript dependency and postinstall above, or the Python source above;
   then add the app to `PROTO_USERS` in `.github/scripts/ci_changes.py` (`True` once its Worker bundles the
   generated code, which also makes a `proto/` change deploy it). `test_proto.py` fails until both agree.

## Wire JSON profile

`ts/wire-json.ts` and `python/src/ziyixi_proto/wire_json.py` map a message to exactly the JSON the v1
contracts send:

- proto field names (`intent_id`, never `intentId`), written in field-number order;
- an enum value is its name without the prefix, in lower case (`STATE_NOT_FOUND` is `"not_found"`), matched
  exactly (no case folding); the zero value is never written;
- a `REQUIRED` field is always written, as `null` when unset; any other unset field is omitted;
- a `Timestamp` is RFC 3339 UTC with 0-3 fraction digits and a real calendar time, written in one canonical
  form (no fraction for a whole second, else 3 digits);
- an integer is a JSON number with a zero fractional part (`1.0` reads as 1, as `JSON.parse` must);
- a double is a finite JSON number (no NaN or infinity); both codecs write the same value, and the same
  bytes for integral values (written as integers) and for 1e-4 <= |x| < 1e16, where Python's `repr` and
  `JSON.stringify` agree;
- a map has `string` keys and is a JSON object in one canonical order: the order `JSON.stringify` gives an
  object whose keys were set in code point order (array-index keys such as `"10"` come first, numerically),
  which Python reproduces; a map value is never null, and an unrecognized map value is reported as
  `field{}` (a key is data, and paths never carry data);
- a proto3 scalar without `optional` is omitted at its default (`""`, 0, false) unless it is `REQUIRED`;
- null is "no value" only where the writer writes it (a `REQUIRED` enum, message or `optional` scalar);
  anywhere else (`"recorded": null`, a list, a field that is omitted when unset) it is a wrong type;
- **strict** reads (inputs) refuse unknown fields and enum names, `null`, wrong types and a missing
  `REQUIRED` field; **lenient** reads (outputs) skip unknown fields and read unknown enum names as 0, both
  listed by path in `unrecognized` (never with values); a wrong type or a missing `REQUIRED` field still
  fails.

Value rules (lengths, patterns, ranges, allow-lists) are not part of the IDL or the profile. They stay
with each contract (its JSON Schema and each app's own checks), and a consumer applies the value rules its
control flow depends on even on a lenient read.

Why not ProtoJSON: it renames fields to lowerCamelCase, writes enums as `"STATE_PENDING"`, omits
`null`s, and its "ignore unknown" mode silently turns every v1 enum value into 0. Why not the official
Python runtime: about 1 MB more per Python Worker and 2.4-4 times the CPU of today's code, against about
15 KB of generated standard-library code and codec (todofy-core's upload grew from 482.68 to 499.79 KiB,
gzip 136.54 to 142.01 KiB; in local workerd without a memory snapshot, importing `core/intents.py` with it
costs about 7 ms more than the hand-written version did). The protobuf-es runtime adds about 34 KB gzip to
a TypeScript Worker that bundles it.

## HTTP APIs

Each app's UI API (the HTTP/JSON interface between its UI and its Worker) is a proto service here too, in
Google's style: resources and methods by the AIPs, `google.api.http` bindings, google.rpc.Status errors. The
Worker serves it through the shared transcoder and the UI calls it through the shared client, both driven by
the generated descriptors, so the `.proto` file is the one description of routes, shapes and errors. Lab's
owner API is the first (`lab/ui/v1`, 2026-10-01); ops-v1, recommendation-v1, mail-received-v1 and every app's
UI API follow the same pattern.

**Conventions** (what api-linter does not already enforce):

- Package `<app>.ui.v1` in `<app>/ui/v1/`, one service `<App>UiService`, resources in their own files and the
  service with its request and response messages in `<app>_ui_service.proto`; `errors.proto` holds the
  `ErrorReason` enum (each value's name without `ERROR_REASON_` is an `ErrorInfo.reason`, and the enum lists
  the transcoder's `BAD_REQUEST`, `NOT_FOUND` and `METHOD_NOT_ALLOWED`). Java options as AIP-191 asks.
- Paths under `/api/v1/` (`/api/v1/{name=decks/*}:decide`): `/api` stays the prefix that separates an app's
  API from its static UI on the one host, and the version is in the path. An app's other HTTP surface (the
  CSRF token at `GET /api/csrf`, `/health`) is transport and stays outside the service.
- Resource-oriented design (AIP-121/122/123): `google.api.resource` with a pattern on every resource,
  `resource_reference` on every field that names one, singletons for per-owner state (`settings`); standard
  methods where they fit (AIP-131/132/133/134/135, with AIP-158 page tokens on lists) and custom methods
  (AIP-136, `:verb`) for actions. `(google.api.field_behavior)` on every field: `REQUIRED`/`OPTIONAL` on
  inputs, `OUTPUT_ONLY` on what the server computes, `IDENTIFIER` on `name`. A mutation takes an AIP-155
  `request_id` with `(google.api.field_info).format = UUID4`.
- An api-linter exception is written next to the element with its reason, `(-- api-linter: <rule>=disabled
  aip.dev/not-precedent: <why> --)`; file-wide ones go in the file's header comment. Never in a config file.

**JSON.** Bodies, query parameters and answers use the [wire JSON profile](#wire-json-profile), not ProtoJSON:
snake_case field names, lower-case enum names without their prefix, RFC 3339 timestamps. The transcoder
reads a request strictly (an unknown field, enum name or query parameter, a wrong type or a missing
`REQUIRED` field is `INVALID_ARGUMENT`) and writes the answer with `toWire`; the client writes the request
with `toWire` and reads the answer leniently (unknown fields and enum names are skipped and reported, so an
older UI keeps working against a newer Worker). Under the profile, `REQUIRED` on an input field means "must
be present"; an `OUTPUT_ONLY` field is omitted when unset, which a typed client reads as unset.

**The transcoder** (`ts/http-transcoder.ts`, `HttpTranscoder`). The app keeps its own fetch handler:
authentication (Cloudflare Access through `packages/edge-auth`) runs first for every path, then
`transcoder.handle(request, context, requestId)` routes by the bindings, calls the app's `authorize` hook with
the matched route before reading the body (CSRF and Origin for every method but GET), builds the request
message from the path variables, the body (`*` or one field, `application/json`, at most `maxBodyBytes`) and
the query (`a.b=1`, repeated keys; form encoding, so `+` is a space), checks UUID4 fields and clears
`OUTPUT_ONLY` input fields (AIP-203), calls the typed handler and writes the answer (`no-store`, `nosniff`). A
path no binding has returns null, for the app's other routes; another method on a known path is 405 with
`Allow`; `OPTIONS` is 204 with `Allow` and no CORS headers (same-origin only); `HEAD` is `GET` without the
body. Handlers throw `RpcError(code, reason, message, {details})`; the body is a google.rpc.Status in Google's
HTTP form (`{"error": {"code": <HTTP status>, "message", "status": <code name>, "details": [ErrorInfo,
LocalizedMessage, RequestInfo, typed details]}}`, `ts/rpc-status.ts`). Messages are fixed English; nothing
from the request is echoed. Path templates (`ts/http-path.ts`) follow http.proto (`*`, `**`,
`{field.path=...}`, `:verb`, its percent-decoding rules), with the precise choices written at the top of the
file (a raw `:` in the last segment is a verb; literals beat `*` beat `**`). Unsupported bindings (`custom`,
`response_body`, a body on GET or DELETE, a non-message body field) fail when the routes are built, on the
first request.

**The client** (`ts/http-client.ts`, `createHttpClient(Service, send)`): one typed method per rpc
(`client.getDeck({ name: 'decks/2026-09-30' })` resolves to a `Deck`), laid out by the rpc's primary binding;
`send` is the app's transport (credentials, CSRF header, retries). A non-2xx answer throws `RpcStatusError`
with the parsed Status (`reason`, `localizedMessage`, `requestId`, `readDetail(status, Schema)`), or
`HttpResponseError` when the body is not one (a proxy page, an expired Access session).

**Cost** (measured 2026-10-01 on Lab, `lab/worker/test/runtime/cpu.test.ts`: a sampled DevTools CPU profile of
the workerd isolate around each request, LabState included; noisy at 0.1 ms resolution, medians of 10 warm
runs, three runs each). Warm requests: a 20-card deck 0.9 → 1.1 ms, a full page of 50 likes 1.0-1.25 →
1.4-1.6 ms, a decide plus an undo 2.6-3.0 → 2.6-3.3 ms (the transcoder's decode, the map to messages and
`toWire` are a few tenths of a millisecond). The isolate's first API request (a deck) 1.9 → 3.9 ms, from
running the new code paths once; the route table itself is built when the Worker's global scope constructs
the transcoder (about 2 ms in a fresh Node process), outside any request. Bundles: Lab's Worker 329.2 →
405.7 KiB (gzip 77.8 → 101.3 KiB, wrangler's dry run), its UI's JavaScript 327.7 → 442.6 kB (gzip
103.6 → 139.3 kB): the protobuf-es runtime in the UI and the embedded descriptors of `lab.ui.v1` and
`google/api`.

**Adding a UI API.**

1. Write `<app>/ui/v1/*.proto` by the conventions above; `npm run lint && npm run api-lint` until clean.
2. Add the app's UI package (its `web/`) as a TypeScript user: `"@ziyixi/proto": "file:../../proto/ts"` in
   `dependencies`, the `postinstall` and the pre-scripts (Rules); the Worker is one already if it uses proto.
3. Worker: `new HttpTranscoder(<App>UiService, handlers, { domain, maxBodyBytes, authorize, localize,
   onUnexpected })` after authentication; keep the app's error copy as `localize`. UI: `createHttpClient`
   with a transport that adds credentials and the CSRF header, and read errors by `status.reason`.
4. Move the old routes off: an old UI tab calls the old paths until it reloads, so either keep them for one
   release as `additional_bindings` (when the old request and answer shapes still decode) or answer them
   with a "reload" error in the old envelope (what Lab did, `lab/worker/src/http.ts`); remove that after
   one release.

Python: a Python Worker's transcoder will implement the same behaviour and run `testdata/http-cases.json`;
the profile's Python twin already supports every kind these APIs use.

## CI

The **Proto checks** job (`.github/workflows/ci.yml`) runs when `proto/`, `.github/` or `tools/` changed,
or on a dispatch: `npm ci`, `npm run lint`, `npm run api-lint` (Go from `tools/api-linter/go.mod` via
`actions/setup-go`), `scripts/breaking.sh` against the **Changes** job's `base`
output (the commit of the last successful `main` run on `main`, the merge base with `origin/main` on a
branch; the checkout has `fetch-depth: 0`), the rules self-test, the determinism check,
`test_proto.py` (one version, wiring), and both codecs' typecheck and tests. When Changes has no base (it
runs everything: first run, unusable base, dispatch), `breaking.sh` compares with `HEAD~1` and says so in
the log; a base that predates `proto/` has nothing to break. The job is in `CI gate`'s needs and in
`CHECK_JOBS` (a push to `main` reuses a green branch run only if it passed Proto checks).

A `proto/` change also re-checks every app in `PROTO_USERS` (Lab and Todofy) and runs `Contracts` (the
task-intent-v1 tests check the codecs against the schema). It deploys a user only when the user's bundle can
change: the user compiles the package in (`PROTO_USERS[app]` is `True`, as for both today) and the change is
outside tests, test data, the check scripts, the api-linter tool module and Markdown.

## Later

Planned: every other app's UI API on the [HTTP APIs](#http-apis) pattern, and the full replacement of `ops-v1`,
`mail-received-v1` and `recommendation-v1` (each a package per service, e.g. `ops/status/v1`,
`mailhero/webhook/v1`). Shared types come from the same googleapis dependency (`google.rpc.Status`) or a
`common/<name>/v1` package. Each contract moves the way task-intent-v1 did: the IDL and tests first, then
both sides on the generated code with every frozen v1 byte pinned by tests (Mail Hero's legacy fixtures are
pinned by SHA-256; Todofy pins the canonical hashes of the task-intent fixtures, which D1 keeps for 400 days).
