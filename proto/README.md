# `proto/`: protobuf as the IDL of the cross-app contracts

Protobuf is the interface definition language (IDL) of every cross-app contract. The wire does **not**
change: each contract keeps its JSON bytes through a small *wire JSON profile* codec per language. The
`.proto` files give every app generated types and enum tables, and `buf lint` and `buf breaking` make
"renamed, renumbered, retyped or removed" a CI failure.

Status: the foundation. `task_intent.proto` mirrors `contracts/task-intent-v1`. Lab (TypeScript) and
Todofy (Python) use the generated code **in tests only**: no Worker bundle contains it yet, and
`contracts/task-intent-v1` (JSON Schema, fixtures, `task-intent-v1.ts`) is still the wire contract.

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
4. **Lint and breaking.** `buf lint` uses `STANDARD` (AIP-aligned: `_UNSPECIFIED` zero values, enum
   prefixes, `lower_snake_case`, versioned packages) and `COMMENTS` (every element documented); exceptions
   are written next to the element with `buf:lint:ignore` and a reason. `buf breaking` uses `FILE`, the
   strictest category. `tools/profile_breaking.py` adds what buf cannot see but the profile treats as wire:
   an existing field gaining or losing `(google.api.field_behavior) = REQUIRED` or explicit presence
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
| `<package path>/*.proto` | One directory per proto package: `todofy/taskintent/v1/task_intent.proto` is `todofy.taskintent.v1` |
| `package.json`, `package-lock.json` | The toolchain pins (`dependencies`: buf, protoc-gen-es, the runtime) and this folder's test tools (`devDependencies`) |
| `ts/` | The TypeScript package `@ziyixi/proto`. Committed: `package.json` (its exports), `wire-json.ts` (the codec), `protobuf.ts` / `protobuf-wkt.ts` (the runtime re-exports). Generated: every directory (`ts/todofy/...`, `ts/google/...`) |
| `python/` | The Python package `ziyixi-proto`. Committed: `pyproject.toml` (static metadata, uv cache keys), `build_backend.py`, `src/ziyixi_proto/__init__.py` and `wire_json.py` (the codec). Generated: every directory under `src/ziyixi_proto/` |
| `tools/ensure.mjs` | Generates both languages when its stamp (`.generated.json`, ignored) does not match |
| `tools/gen_py.py` | The stdlib-only Python generator (frozen dataclasses, `IntEnum`s, field tables) |
| `tools/profile_breaking.py` | The profile's breaking rules (rule 4) |
| `scripts/breaking.sh`, `scripts/rules-selftest.sh` | The breaking gate against a base commit; the rules self-test |
| `testdata/wire-profile-cases.json` | 34 edge cases (timestamps, integer spellings, enum look-alikes, missing fields) that both codecs must answer identically |
| `test/*.test.ts`, `test/python/` | The codec and IDL tests, the same cases in both languages |

Every directory directly inside `ts/` and `python/src/ziyixi_proto/` is generated (`.gitignore`); every
file there is hand-written.

## How it works

`tools/ensure.mjs` hashes its inputs (every `.proto` file, `buf.yaml`, `buf.lock`, `buf.gen.yaml`,
`package-lock.json`, itself and `gen_py.py`) and every generated file, and compares with the stamp
`.generated.json`. When they match it exits in about 0.1 s without touching the network. Otherwise it
installs the pinned toolchain into `node_modules/` if those versions are not there (`npm ci --omit=dev`),
runs `buf generate` and `buf build | gen_py.py` into a temporary directory, moves the result into `ts/` and
`python/src/ziyixi_proto/` under a lock (parallel installs wait), and writes the stamp. It strips the
calling npm's settings from the environment, so `npm ci --prefix lab/worker` cannot redirect the nested
install.

**TypeScript.** An app declares `"@ziyixi/proto": "file:../../proto/ts"` and
`"postinstall": "node ../../proto/tools/ensure.mjs"`. npm links `node_modules/@ziyixi/proto` to `proto/ts`
whether or not anything is generated, then the postinstall generates. Generated files import
`@bufbuild/protobuf`, which Node, TypeScript, vitest and wrangler's esbuild resolve from the real path,
`proto/node_modules`: one copy for every app, no `paths`, `dedupe` or alias settings. (Checked on
2026-10-01 with a scratch import in Lab's `src/`: `wrangler deploy --dry-run` bundled the generated file,
`wire-json.ts` and one runtime from `../proto/node_modules`, +153 KiB, +31 KiB gzip.)

```ts
import { create } from '@ziyixi/proto/protobuf';
import { TaskIntentResultSchema, State } from '@ziyixi/proto/todofy/taskintent/v1/task_intent_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';

const { message, unrecognized } = fromWire(TaskIntentResultSchema, JSON.parse(text)); // an output: lenient
if (message.state === State.CREATED) { /* ... */ }
```

**Python.** Todofy declares `ziyixi-proto` (today in its `dev` dependency group) with
`[tool.uv.sources] ziyixi-proto = { path = "../proto/python" }`. uv builds it with
`python/build_backend.py` (standard library only, no build dependencies to download), which checks the
stamp the way `ensure.mjs` does and runs `ensure.mjs` only when it does not match, then packages
`src/ziyixi_proto`. uv rebuilds whenever one of the package's `cache-keys` changes (the stamp's inputs and
the hand-written runtime), so `uv run pytest` after editing a `.proto` file regenerates by itself.

```python
from ziyixi_proto.todofy.taskintent.v1 import task_intent_pb as pb
from ziyixi_proto.wire_json import from_wire, to_wire

read = from_wire(pb.TaskIntent, json.loads(text), strict=True)  # an input: strict
```

The source is not editable on purpose: when a Python Worker imports the package, it moves to
`[project] dependencies`, and `pywrangler sync` vendors it into `python_modules/` from this same source.
pywrangler builds that wheel inside Pyodide, which cannot start processes; the backend then only verifies
the stamp (which `uv sync` on the host already made current) and copies files. Verified on 2026-10-01 with
a scratch copy of Todofy that imported the package from `worker/`: `pywrangler sync`, `pywrangler deploy
--dry-run` (the bundle lists `python_modules/ziyixi_proto/...`) and the workerd runtime tests, where the
module loaded from `python_modules` and round-tripped a result.

**Editors.** After the app's install, VS Code resolves every import: TypeScript through the linked package
(the generated `.ts` files are real files under `proto/ts`), Python through the installed package in
`todofy/.venv` (select that interpreter).

**Offline.** Only the first generation needs the network (npm for the toolchain, buf.build once for the
locked googleapis module, which buf caches in `~/.cache/buf`). After that, reinstalls and regeneration
work offline (`npm ci --offline`, `uv sync --offline`).

## Common tasks

```sh
cd proto
npm ci                                   # the toolchain and this folder's test tools
npm run generate                         # regenerate now (any app's npm install / uv sync also does it)
npm run lint                             # buf format + buf lint
npm run breaking -- "$(git merge-base HEAD origin/main)"   # buf breaking + the profile rules
npm run selftest                         # the rules still bite
npm run check:deterministic              # generate twice more, compare with the installed output
npm run typecheck && npm test            # both codecs (TypeScript, then Python 3.14 through uv)
```

After editing a `.proto` file or `wire-json.ts`/`wire_json.py`, a TypeScript app sees the change after
`npm run generate` here (or its own `npm install`); Todofy's next `uv run` rebuilds by itself.

**Adding a contract.**

1. Create `<app>/<service>/v1/<name>.proto` with `package <app>.<service>.v1;` (one directory per service;
   the directory must match the package). Mirror the JSON contract field for field: field numbers in the
   JSON Schema's property order (so field-number order reproduces today's key order), the v1 field names,
   every enum with its AIP-126 prefix and an `_UNSPECIFIED` zero value, `REQUIRED` where the schema
   requires a field. Only the kinds the profile supports: `string`, `bool`, 32-bit integers, enums, messages,
   `repeated` fields and `google.protobuf.Timestamp`; anything else stops generation with an error.
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
11 KB of generated standard-library code. The protobuf-es runtime adds about 32 KB gzip to a TypeScript
Worker that bundles it.

## CI

The **Proto checks** job (`.github/workflows/ci.yml`) runs when `proto/`, `.github/` or `tools/` changed,
or on a dispatch: `npm ci`, `npm run lint`, `scripts/breaking.sh` against the **Changes** job's `base`
output (the commit of the last successful `main` run on `main`, the merge base with `origin/main` on a
branch; the checkout has `fetch-depth: 0`), the rules self-test, the determinism check,
`test_proto.py` (one version, wiring), and both codecs' typecheck and tests. When Changes has no base (it
runs everything: first run, unusable base, dispatch), `breaking.sh` compares with `HEAD~1` and says so in
the log; a base that predates `proto/` has nothing to break. The job is in `CI gate`'s needs and in
`CHECK_JOBS` (a push to `main` reuses a green branch run only if it passed Proto checks).

A `proto/` change also re-checks every app in `PROTO_USERS` (Lab and Todofy today). It deploys a user only
when the user's bundle can change: the user compiles the package in (`PROTO_USERS[app]` is `True`) and the
change is outside tests, test data, the breaking scripts and Markdown. Today both users are test-only, so
no `proto/` change deploys anything.

## Later

Planned, not in this foundation: `google.api.http` annotations and AIP-style resource methods for each
app's owner UI API with an in-repository transcoder, and the full replacement of `ops-v1`,
`mail-received-v1` and `recommendation-v1` (each a package per service, e.g. `ops/status/v1`,
`mailhero/webhook/v1`). Shared types come from the same googleapis dependency (`google.rpc.Status`) or a
`common/<name>/v1` package. Each contract moves consumer first, keeps every frozen v1 byte (Mail Hero's
legacy fixtures are pinned by SHA-256), and only then lets a Worker bundle the generated code.
