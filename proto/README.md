# Proto IDL and shared runtimes

`proto/` owns the repository's cross-application contracts, owner HTTP APIs, pinned generators and shared wire JSON
runtimes. Field shapes and value rules live in IDL; semantic contracts and frozen fixtures live in
[contracts](../contracts/README.md). Applications use generated types and the shared codec, transcoder and client.

Bazel compiles each IDL package with its declared imports. Consumers use package-scoped providers such as
`//proto/tasks/ui/v1:ts` and `//proto/platform/runtime/v1:python`. Generation reads the real `buf.gen.yaml`;
the Google APIs repository validates `buf.lock` against its commit-specific archive checksum. Actions use pinned
tools and declared inputs, without a developer's `node_modules` or a second generation lifecycle.

| Target | Output or check |
| --- | --- |
| `//proto/ts:pkg` | Complete TypeScript package; consumers can assemble smaller packages with `proto_package` in `bazel/ts_package.bzl` |
| `//proto:python_wheel` | Reproducible stdlib-only Python wheel, excluding test-only namespaces |
| `//proto:schemas` | Published contract schemas from package-scoped generation |
| `//proto:check` | Format/lint, API lint and annotation agreement, strict TypeScript compilation, both codecs, golden bytes, Schema freshness, mutation guards, determinism and materialization |
| `//proto:breaking` | Git-baseline compatibility, retirement and wire-profile checks; run with `bazel run //proto:breaking -- BASE` |
| `//proto:materialized` | Generated-only tree for raw pnpm/uv development |

Handwritten TypeScript modules have individual providers such as `//proto/ts:rpc-status`; `:runtime` aggregates them.
Recall's declaration boundary is `//proto/ts:recall_ingest_v1_types`, limited to its ingest and wire-codec type closure.
Raw source consumers run `node proto/tools/ensure.mjs` to copy verified Bazel outputs into the existing export paths.

Newsletter's engine retains its independent locked `ziyixi-protos` protocol and versioned deployment JSON.
Its owner read API, `newsletter.ui.v1`, belongs here. Model Router's internal API has the coordinated-update
exception described [below](#internal-model-router-changes); other APIs retain normal compatibility rules.

## Rules

1. **One folder.** `proto/` holds the buf module (`buf.yaml`, `buf.lock`, `buf.gen.yaml`, the `.proto`
   files under their package path), the pinned toolchain and the hand-written codec runtimes. Apps never
   keep a copy of any of it.
2. **Generated code is never committed.** It is gitignored. The commands developers already run
   generate it: `pnpm install --frozen-lockfile` at the repository root (the workspace postinstall), `uv sync` / `uv run` in
   Todofy (the build of `ziyixi-proto`), and CI. A missing generated directory never breaks dependency
   resolution: the package manifests are committed, only the files their exports point at are generated.
3. **One version.** buf, protoc-gen-es and the protobuf-es runtime are pinned once, exactly, in
   the root `pnpm-workspace.yaml` catalog and `pnpm-lock.yaml`. No app has its own `@bufbuild/protobuf`: an app imports the
   runtime from `@ziyixi/proto/protobuf`, which resolves this folder's copy, so every bundle holds exactly
   the runtime the generator targets. `.github/scripts/test_proto.py` enforces it (and the wiring below).
   Generation is deterministic; CI generates twice and compares. googleapis has two pins, bumped together:
   `buf.lock` (what buf compiles the module and generates the TypeScript against) and the genproto Go code compiled
   into api-linter (`tools/api-linter/go.mod`, through which it interprets the `google.api` annotations);
   `tools/api-linter/googleapis`, run first by `pnpm run api-lint`, fails unless every googleapis file the module
   imports is the same in both.
4. **Lint and breaking.** `buf lint` uses `STANDARD` (AIP-aligned: `_UNSPECIFIED` zero values, enum prefixes,
   `lower_snake_case`, versioned packages) and `COMMENTS` (every element documented); exceptions are written
   next to the element with `buf:lint:ignore` and a reason, and the AIP-shaped HTTP packages are excused only
   from the two response-name rules the AIPs contradict: `links/ui`,
   `watch/ui`, `mailsort/ui`, `dashboard/ui`, `mailhero/ui`, `recall/ui` and `newsletter/ui` by those two `buf:lint:ignore` lines on each method that answers a resource (with the
   reason in the file's header),
   because `buf.yaml` reaches every proto user's deploy (`proto_deploys` below) and a new package must not
   redeploy the other apps. Google's api-linter
   (`//proto:api_lint_test`, one pinned version) checks every package but `prototest/` against the AIPs; its
   exceptions are `(-- api-linter: ... --)` comments with a reason, next to the element. `buf breaking` uses
   `FILE`, the strictest category: names, numbers, types, removals. buf compares no custom option, so
   `tools/profile_breaking.py` adds what it cannot see but is wire here. For the wire profile: an existing
   field gaining or losing `(google.api.field_behavior) = REQUIRED` or explicit presence (`optional`), and a
   new `REQUIRED` field in an existing message. For the HTTP APIs, where the URL is the wire (an open tab of
   an older UI and every other client keep calling the paths they were built with): a binding of an
   existing method (verb, path template, body, response_body) that is no longer among its bindings (adding
   an `additional_binding`, or demoting the old primary binding to one, is compatible), a lost
   `method_signature`, a `google.api.resource` whose type changed or that lost a pattern, an existing input
   field that gains `OUTPUT_ONLY` or `IDENTIFIER` (the transcoder would drop what clients send), and a
   `(google.api.field_info).format` added to or changed on an existing field. For the wire options of
   `common/wire/v1`: an existing map that gains or loses `keep_order` and an existing list or map that gains or loses
   `write_empty` (every producer's bytes change: `PROFILE_FIELD_SAME_ORDER`, `PROFILE_FIELD_SAME_EMPTY`), and an
   existing method that gains or loses `positional` (callers and receivers would disagree on the arguments).
   The value rules are wire too, since both codecs check them on every read, a consumer's lenient read included:
   a rule of an existing field of an output may not change either way (older and newer readers check older and
   newer writers; only an `open` list may change, a list may become `open`, and an open list may give way to the
   field's format, kept or new, when every listed value matches it), a rule of a field only inputs
   reach may loosen but never tighten (the apps deploy before the dashboard that calls them), a union's
   discriminator may not change, the relations between fields are rules too (a field's `present_when` like its other
   rules; a message's `any_match` groups may not change on an output, and an input-only message may drop one but not
   gain one: `PROFILE_RULE_SAME_MATCH`), and a closed enum may not gain a value or change its `closed` (rule 5). Formats
   compare by pattern, length and JSON Schema `format`, so renaming a format is compatible. Like buf, it skips the
   directories `buf.yaml` lists under `breaking.ignore` (the runtimes' fixtures). `scripts/rules-selftest.sh`
   proves the rules bite (76 cases, on `tasks/inbox/v1`, `watch/ui/v1`, `ops/v1`, `dashboard/ui/v1`, `todofy/report/v1`,
   `mailhero/webhook/v1` and `prototest`, the retirement of a package, a file, an enum value, an allowed value, an rpc
   with its request and a field among them), and `test/python/test_profile_breaking.py` checks the directions on
   synthetic images.

   Reviewed output-rule corrections are recorded in `reviewed-rules.json` with their exact old/new values and
   rollout reason. The CLI permits only that one registered field rule when all other rules and field identity
   remain unchanged; `violations()` and every unlisted change stay strict. The runtime resource inventory repair
   deploys Fleet consumers before Platform producers through the existing release dependencies.
5. **Adding a value to an open enum is compatible by design**, so neither buf nor the profile check flags it.
   What keeps consumers working is the reading rule: outputs are read leniently (an unknown enum name reads as
   `*_UNSPECIFIED`, an unknown field is skipped, both listed in `unrecognized`), and a consumer branches on
   known values with a default, never inferring success from an error code. Inputs are read strictly. A contract
   whose consumers branch on every value of an enum, with no default to fall back to, marks it
   `option (common.wire.v1.closed) = true` (every enum ops-v1 writes): every read refuses an unknown name, a
   lenient one too, and a new value is a new major version (`PROFILE_ENUM_CLOSED`).
6. **Retiring an element.** Deleting a published package, file, enum value, field, allowed value, rpc or message is
   breaking by every rule above, and that stays so. When no producer or consumer of it remains (the app that used it is removed in
   the same change), [`retired.json`](retired.json) lists it by full name with the date and the reason, and
   `tools/retired.py` (run by `//proto:breaking` and the self-test before `buf breaking` and the profile rules)
   first checks that the head keeps the promise: no file under a retired package path or of its package name, no
   retired file (`files`, by its path: buf compares at FILE level, so a file is retired whole, with every service,
   message and enum it defines, and no kept file of the base may import it, `RETIRED_FILE_IMPORTED`), no retired
   allowed value, and a retired enum value absent with **both its number and its name reserved**
   (`reserved 1; reserved "NAME";`, so neither is ever reused: a stored row may still hold the old name), and so is
   a retired field (`fields`, by full name and number). A retired rpc (`methods`, by service and name) is absent
   from its service, and a service whose every rpc is retired goes with them. A retired top-level message (`messages`) is absent from the head, and no kept field or rpc of the
   base uses it (`RETIRED_MESSAGE_REFERENCED`): a message is retired together with everything that uses it. A kept
   file may import a retired package or file only for retired fields; the base drops that import with them. It then
   removes exactly the listed elements from the base, so their deletion is the base's state and every other difference
   is checked as before; an element the base no longer has is left alone. Once every base CI compares with is newer
   than the deletion (the first green run on `main` after it), an entry does nothing and may be removed; the `reserved`
   lines stay. Release selection follows the candidate and baseline Bazel graphs, including removed dependencies.

## Layout

| Path | Responsibility |
| --- | --- |
| `<domain>/<api>/v*/` | IDL and package-scoped `proto_library` declarations |
| `buf.yaml`, `buf.lock`, `buf.gen.yaml` | Lint/breaking rules, Google APIs pin and authoritative protobuf-es options |
| `bazel/` | Descriptor, generation, packaging and materialization rules |
| `ts/` | Handwritten runtime at the root; generated package directories are ignored |
| `python/` | Stdlib runtime, wheel backend and ignored generated package directories |
| `tools/gen_py.py`, `gen_wire_ts.py`, `gen_schema.py` | Canonical generators reused by Bazel actions |
| `tools/wire_rules.py`, `profile_breaking.py`, `retired.py` | Value-rule interpretation and compatibility checks |
| `tools/api-linter/` | Go tool/module pins and annotation agreement check |
| `test/`, `testdata/`, `prototest/` | Synthetic fixtures, runtime tests and cross-language cases; `prototest` never ships in the wheel |

Published schemas are generated from `gen_schema.py`'s `SCHEMAS`. A target publishes a `$defs` document or one
self-contained message schema; consumer schemas allow unknown fields. Legacy `$defs` names remain aliases
(`ALIASES`). Frozen legacy schemas and wire fixtures are compatibility evidence and are never regenerated.

## How it works

Bazel owns compilation and generation. Each IDL directory declares a `proto_library` with its actual imports;
package actions reuse the pinned Buf/protobuf-es tools and the existing Python, wire TypeScript and Schema generators.
The real `buf.gen.yaml` is an action input. The Google APIs repository validates `buf.lock` before using its
commit-specific archive checksum. Actions consume declared files and toolchains, without local `node_modules`.

For raw pnpm/uv development, `node proto/tools/ensure.mjs` runs `bazel build //proto:materialized` from the
repository root and copies that target's generated modules into the existing source export paths. It requires
Bazel 9.3.1 on PATH; `BAZEL` can name its executable. Bazel decides freshness using the same graph as CI.
The script does not install dependencies or invoke generators. `materialized/manifest.json` records declared
input hashes and generated output hashes; `.generated.json` is its ignored copy in the source tree.

The existing `.generate.lock` serializes source-tree copies. Outputs are staged and verified before replacing
only generated package directories. Handwritten runtime files and workspace `node_modules` links remain in place.
A dead local holder is recovered; a waiter reports the current holder.

### TypeScript

An app declares `"@ziyixi/proto": "workspace:*"` and `"postinstall": "node
../../proto/tools/ensure.mjs"`. pnpm links `node_modules/@ziyixi/proto` to `proto/ts` whether or not anything
is generated, then the postinstall materializes Bazel outputs. Every pnpm script that compiles, tests, lints with types, bundles
or serves the generated code (`tsc`, `vitest`, `eslint` through typescript-eslint's project service, `wrangler`,
`vite`) has a `pre<script>` that runs the same command, in the app and in any package that imports the app's
sources, so `pnpm run typecheck`, `pnpm run lint`, `pnpm test` or `pnpm run dev` after a pull or a branch switch that
changed a `.proto` file materializes current outputs first (`test_proto.py` requires those scripts).
Generated files import `@bufbuild/protobuf`, which Node, TypeScript, vitest and
wrangler's esbuild resolve through the runtime package's explicit catalog dependency: one pnpm store version for every app, no `paths`,
`dedupe` or alias settings. ```ts
import { create } from '@ziyixi/proto/protobuf';
import { CanaryResultSchema, CanaryResult_State } from '@ziyixi/proto/ops/v1/ops_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';

const { message, unrecognized } = fromWire(CanaryResultSchema, JSON.parse(text)); // an output: lenient
if (message.state === CanaryResult_State.OK) { /* ... */ }
```

Across a Workers service binding (not gRPC), `WireService<typeof OpsService>` turns a generated service
into the entrypoint's methods (`setGuard(input: WireObject): Promise<WireObject>`): the caller declares its
binding with it, the implementation `implements` it, and both sides keep plain JSON objects on the wire (a package
in `WIRE_PACKAGES`, `tasks.inbox.v1` say, also gets a typed interface, `TaskInboxService`).
`wireEnum(GuardLevelSchema, GuardLevel)` gives one enum's wire names and back for code that stores or shows them
outside a message (a D1 column, an owner API), and `WireName<typeof GuardLevel>` is the union of those names as a type
(`'normal' | 'shed'`): an app's internal records can derive from it, so a new enum value fails its typecheck
until it maps it. Python has `wire_name(member)` and `wire_member(cls, name)`.

### Python

Python consumers declare `ziyixi-proto` through the root uv workspace as a non-editable local source.
The stdlib build backend invokes the same Bazel materializer on the host. Its uv cache keys include the IDL,
Bazel definitions, locked toolchains and ignored manifest. The wheel contains runtime modules and selected generated
Python packages; test-only `prototest` modules are excluded. `bazel build //proto:python_wheel` builds the same
package directly from Bazel providers for release images.

```python
from ziyixi_proto.ops.v1 import ops_pb as pb
from ziyixi_proto.wire_json import from_wire, to_wire

read = from_wire(pb.SetGuardInput, json.loads(text), strict=True)  # an input: strict
```

The source is not editable on purpose: todofy-core imports the package, so it is in Todofy's
`[project] dependencies`, and `pywrangler sync` vendors it into `python_modules/` from this same source
(`pylock.toml` lists it as a directory). pywrangler builds that wheel inside Pyodide, which cannot start
processes; the backend then only verifies the stamp (which `uv sync` on the host already made current, so
`uv sync` runs first) and copies files. pywrangler re-syncs only when `pyproject.toml` or `pylock.toml`
change, so Todofy's runtime test harness compares the vendored copy with the installed one and forces a
sync when they differ (after running `ensure.mjs`); for `pywrangler dev` by hand after an IDL
change, run `uv run pywrangler sync --force`. If Pyodide's build still reports that the generated code is
not current, run `pnpm run ensure` here and retry.

### Editors

After the app's install, VS Code resolves every import: TypeScript through the linked package
(the generated `.ts` files are real files under `proto/ts`), Python through the installed package in
`todofy/.venv` (select that interpreter). The files of `proto/` itself resolve too, since the app's
install put this folder's whole lockfile (vitest, Node and Workers types) in `proto/node_modules`.

### Offline

Bazel's first build fetches pinned tools and dependencies. Later builds can reuse its repository
and action caches. The source-tree materializer uses those outputs; it does not maintain another tool cache.

## Common tasks

```sh
bazel test //proto:check                              # lint, types, codecs, schemas and negative guards
bazel build //proto/ts:pkg //proto:python_wheel         # canonical TypeScript package and stdlib Python wheel
node proto/tools/ensure.mjs                           # materialize outputs for pnpm/uv source consumers
bazel run //proto:write_schemas                        # update published schemas from generated outputs
bazel run //proto:breaking -- "$(git merge-base HEAD origin/main)"
```

Package-scoped targets such as `//proto/tasks/inbox/v1:ts` and `:python` follow their IDL import closures.
The full `//proto/ts:pkg` is used only when a consumer needs the full package, including raw development.
`wire-json.ts` and `wire_json.py` remain handwritten runtime sources.

**Adding a contract.**

1. Create `<app>/<service>/v1/<name>.proto` with `package <app>.<service>.v1;` for a contract one app owns
   (`todofy.mail.v1`, `watch.ui.v1`), or `<contract>/v1/<name>.proto` with `package <contract>.v1;` for a
   contract several apps implement (`ops.v1`: every app's `Ops`), top-level and never under `common/` (which holds
   what contracts share, not contracts). One directory per package; the directory must match the package. Mirror the JSON contract field for field: field numbers in the
   JSON Schema's property order (so field-number order reproduces today's key order), the v1 field names,
   every enum with its AIP-126 prefix and an `_UNSPECIFIED` zero value, `REQUIRED` where the schema
   requires a field. Only the kinds the profile supports: `string`, `bool`, 32-bit integers, `double`, enums
   (top-level or nested in a message), messages, `repeated` fields, maps with `string` keys,
   `google.protobuf.Timestamp` and `google.protobuf.FieldMask`; anything else (64-bit integers, `float`,
   `bytes`, oneofs, nested messages, other well-known types as fields) stops generation with an error (for
   Python, only in the packages of `PYTHON_PACKAGES`; add the package there when a Python app imports it).
2. State its value rules next to its fields ([Value rules](#value-rules)): formats, allowed lists, bounds, sizes,
   a union's cases, `non_null` on every REQUIRED enum or message a producer never writes as null, and `closed` on
   every enum its consumers branch on without a default. A contract other apps call over a service binding gets wire JSON types: add its package to
   `WIRE_PACKAGES` in `tools/gen_wire_ts.py` (and `positional` on a method that takes plain arguments). A contract
   with a published JSON Schema generates it: add a `Target` to `SCHEMAS` in `tools/gen_schema.py` (with `root` for
   the self-contained schema of one message, and `then` for a generator that copies it) and run `pnpm run schema`,
   then what its `then` names, if anything.
3. `pnpm run lint && pnpm run api-lint` until clean, then `pnpm run ensure`.
4. Add the contract's fixtures to `test/` and `test/python/` (round trip byte for byte, a strict read refusing every
   invalid fixture, a lenient read tolerating what its consumers do), and a new kind of field or rule to
   `testdata/wire-profile-cases.json` first.
5. In each consumer, add the workspace dependency and the package-scoped Bazel dependency. Declare imported
   IDL packages in the new `proto_library` and add generated output targets in the language package. Tests and
   release facades inherit those edges; no central application registry needs updating.

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
- a `google.protobuf.FieldMask` is one string of comma-separated snake_case paths (`"send_mode,author.name"`;
  `""` has none), not ProtoJSON's lowerCamelCase: a path is `*` or field names joined by dots
  (`ts/field-mask.ts`, the same rule in Python);
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
  fails. The one `null` a strict read takes is that of a `REQUIRED` field declared `optional`: "always present,
  may be null" (ops-v1's `SetGuardInput.until` for a normal guard), exactly what `toWire` writes for it;
- a map with `(common.wire.v1.field).keep_order` is written in the order its entries were set, and a read keeps
  the wire's order (array-index keys first, as JavaScript orders an object): ops-v1's counters and metrics list
  their names in the order each producer chose;
- a list or map with `(common.wire.v1.field).write_empty` that is not `REQUIRED` is written as `[]` or `{}` when empty,
  and a read still takes its absence: a list every current producer writes but frozen payloads of older producers lack
  (mail.received.v1's `warnings`);
- in Python, a field named like a keyword is the dataclass attribute `<name>_` (`from_`); its wire name, its path in
  errors and `field_rules(cls, "from")` keep the proto name;
- a method with `(common.wire.v1.method).positional` is called over a service binding with its request's fields as
  arguments, in field-number order (`status()`, `canaryDelivery(eventId)`), instead of the request as one wire
  object (`toWireArguments`, `fromWireArguments` in TypeScript).

### Value rules

A contract states its value rules in the IDL, next to its fields, with the options of
[`common/wire/v1/wire.proto`](common/wire/v1/wire.proto): a file's named string formats (`Code`, `Timestamp`: an
anchored regular expression in the subset ECMAScript, with or without the u flag, and Python read alike: no `.`, no
shorthand class but `[\s\S]` for any character, no character above U+FFFF, which ECMAScript without u reads as two
code units; a length, and optionally the JSON Schema
`format` the generated schema states next to the pattern, `json_schema_format`: only `date-time`, an annotation the
codecs do not check), and per field a format, an `allowed` list (an enum-like string, or a subset of an enum), number
bounds, list and map sizes (`max_items`; 0, the default, is no bound), unique items, map key formats and required
keys, `non_null` (a REQUIRED enum or message that is never null: without it the profile writes such a field as null
when it has no value), and, in a union (a message with a `discriminator`), the presence and extra rules
(`CaseRules`: allowed, minimum, maximum, and `empty`, a list or map without items in that case; a flag rather than a
size, so it cannot be confused with the field's `max_items` of 0) of each field per discriminator value; two relations
between fields besides a union's: a field's `present_when` (it has a value whenever the named bool field of its message
is true: mail.received.v1's `original_text_bytes` when `text_truncated`) and a message's `any_match` groups (one of the
group's string fields has a value that matches the group's format: a subject or a text that is not blank), checked
after the message's fields; per enum, `closed` (rule 5). A format's `json_schema_format` is `date-time` or `uuid`. That
is the one source of a contract's validation:

- both codecs check every rule on every read and every write (`ts/wire-rules.ts`; the rule part of
  `wire_json.py`, from the tables `tools/gen_py.py` writes): a message that breaks one is refused like a wrong
  type, with a path and the rule's name, never the value, so neither a producer bug nor a bad input crosses the
  wire. A lenient read checks the same rules, with two consumer allowances: a field's cases are skipped when
  the reader does not know the discriminator's value, and an `open` allowed list (codes that may grow within the
  major version, ops-v1's `reason` and `waiting_code`) accepts any value of the field's format. A closed enum and
  `non_null` hold on a lenient read too. A consumer that passes on what it read writes with
  `toWire(..., { lenient: true })` (`to_wire(..., lenient=True)`); it cannot pass on a `non_null` enum whose newer
  value it did not know (that value has no wire name in its build), which is why a contract whose consumers pass
  messages on closes such an enum;
- producers read bounds from the descriptors instead of copying them (`fieldRules(field).maxItems`,
  `field_rules(cls, name).max_items`);
- `tools/wire_rules.py` refuses at generation a rule that cannot mean anything where it is written (an unknown
  format, `allowed` on a number, a presence case on a field that always has a value, a case value the
  discriminator lacks, `non_null` on a field declared `optional` or one a case makes absent, a pattern the two
  engines read differently), for every package; it is also the one definition of which fields a producer may write
  as null (`may_be_null`) for the wire types and the JSON Schema;
- `tools/profile_breaking.py` keeps rules compatible across releases (rule 4);
- `testdata/wire-profile-cases.json` runs every rule in both languages on `prototest/v1/rules.proto`.

What a rule cannot say stays with the contract's code: rules relative to a clock (ops-v1's guard `until` at most
36 h ahead), sizes of a whole message (an 8 KiB report) or in UTF-8 bytes (a 4 KiB subject), allow-lists that depend on
another service (a URL host) and relations between fields other than a union's, `present_when` and `any_match` (a
recommendation's ranks unique and at most its `top_n`, a size before truncation larger than the text's).
A consumer applies the value rules its control flow depends on even on a lenient read.

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
the generated descriptors, so the `.proto` file is the one description of routes, shapes and errors.
recommendation-v1, mail-received-v1 and every app's UI API follow the same pattern (ops-v1 is a service-binding contract, not an HTTP API: `ops/v1`).

**Conventions** (what api-linter does not already enforce):

- Package `<app>.ui.v1` in `<app>/ui/v1/`, one service `<App>UiService`, resources in their own files and the
  service with its request and response messages in `<app>_ui_service.proto`. Java options as AIP-191 asks. An app
  whose hand-written owner API already was `/api/v1` starts at major version 2 (AIP-185: its paths and shapes break
  the old ones): `mailhero.ui.v2` in `mailhero/ui/v2/`, served under `/api/v2/`, with the old `/api/v1` paths
  answering 410 `reload_required` for one release.
- Errors (AIP-193): an `ErrorInfo.reason` is a value name without its prefix, of
  `common.errors.v1.CommonReason` (`common/errors/v1/errors.proto`: what the shared transcoder, `edge-auth` and
  any handler answer, `BAD_REQUEST`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `INTERNAL`, `UNAVAILABLE`,
  `UNAUTHORIZED`, `CSRF_FAILED`, `ACCESS_NOT_CONFIGURED`, `NOT_CONFIGURED`) or of the app's own `ErrorReason`
  in its `errors.proto`, which lists only its domain reasons and never reuses a common name. Only a failed
  dependency (D1, a Durable Object, the identity provider's keys) is `UNAVAILABLE`, which a client may repeat
  with the same `request_id`: the app wraps exactly those calls. Anything else unexpected is a bug,
  `INTERNAL` (the transcoder's default), which a client never repeats by itself.
- Paths under `/api/v1/` (`/api/v1/{name=watches/*}:pause`; `/api/v2/` for a v2 package): `/api` stays the prefix
  that separates an app's API from its static UI on the one host, and the version is in the path. An app's other HTTP surface (the
  CSRF token at `GET /api/csrf`, `/health`) is transport and stays outside the service. An app whose host
  root belongs to something else keeps everything of its own under one reserved segment instead: the links app's
  host answers every `/<key>`, so its UI and API live under `/_/` (`/_/api/v1/...`, `/_/api/csrf`), with a
  file-wide `core::0122::camel-case-uris` exception for that `_`.
- Resource-oriented design (AIP-121/122/123): `google.api.resource` with a pattern on every resource,
  `resource_reference` on every field that names one, singletons for per-owner state (`settings`); standard
  methods where they fit (AIP-131/132/133/134/135) and custom methods (AIP-136, `:verb`) for actions.
  `(google.api.field_behavior)` on every field: `REQUIRED`/`OPTIONAL` on inputs, `OUTPUT_ONLY` on what the
  server computes, `IDENTIFIER` on `name`. One exception: an API whose answers are pre-encoded wire JSON
  (`PreEncoded`, as `dashboard.ui.v1`'s views) marks an output field its producer always writes, null
  included, `REQUIRED`, because under the profile only `REQUIRED` writes a null (and makes the client refuse
  its absence), so only then does the profile write the producer's bytes back unchanged; those files carry a
  file-wide `core::0216::state-field-output-only` exception for their fields of a `State` enum, and the
  fields written only when set stay `OUTPUT_ONLY`. A mutation takes an AIP-155 `request_id` with
  `(google.api.field_info).format = UUID4`. An app without a request log (where a log row would cost a D1 write on
  every mutation) takes it on its creates only, where it becomes the new resource's ID so a repeat finds it, and makes
  every other mutation set a state; its service header says so, with the api-linter exceptions next to each element.
- `IMMUTABLE` fields (AIP-203) may appear in an update's body or mask only with their stored value; another value is
  `INVALID_ARGUMENT`, never silently dropped. Without a mask, a field left at its default was not given. A repeated
  field's empty value never selects a method's broadest action: such an action takes its own `bool`.
- `page_size` (AIP-158): 0 is the default, a value above the maximum is read as the maximum, a negative one is
  `INVALID_ARGUMENT`; every repeated field of a page counts against its bound, not only the main one.
- Resource IDs have no `/` (AIP-122). An ID whose natural key has one (`team/item`) writes it as `~`
  (`items/team~item`), and a Create's `<resource>_id` takes
  exactly that form (AIP-133: the answer's name is `<collection>/<the given id>`); an ID with `/` (also sent
  as `%2F`) is `INVALID_ARGUMENT`.
- Create answers the resource; a Delete of a resource that does not exist is `NOT_FOUND` (AIP-135), whatever
  else exists under the same key, except the replay of a `request_id` whose first request deleted it.
- Update (AIP-134) is `PATCH` with the resource as the body and an optional `google.protobuf.FieldMask
  update_mask` (a query parameter): the fields it names are replaced, and an absent, empty or `*` mask
  replaces every field the client may set. An API may require an explicit mask instead (absent, empty or `*` is
  `INVALID_ARGUMENT`) where replacing every field could change behaviour by accident; the field's comment says so and
  why (Mail Hero's `UpdateSettings` and `UpdateEndpoint`: a client that leaves a field out would resume sending or
  switch a retention period off). The transcoder enforces the resource's `REQUIRED` fields only
  where the mask names them, refuses unknown paths and ignores `OUTPUT_ONLY` ones; the client sends only the
  masked fields. `method_signature = "<resource>,update_mask"`. Store each field so that an update writes
  only its masked fields (two tabs changing different fields both keep their change).
- Concurrency (AIP-154): a resource whose mutations must not cross carries `string etag` (`OUTPUT_ONLY`,
  opaque), and those mutations take `string etag` (`REQUIRED`); a stale one is `ABORTED` with the current
  state as a detail. An ordered `version` may sit next to it when clients must order two states; it is
  never a precondition.
- Lists (AIP-158): `page_size` (0 is the default; larger values are read as the maximum), `page_token` and
  `next_page_token` from `ts/page-token.ts` (opaque, bound to every list parameter but `page_size`: a token of
  another filter is `INVALID_ARGUMENT`). A `filter` is AIP-160 in the subset `ts/filter.ts` parses
  (literals, quoted strings, `AND`; anything else is `INVALID_ARGUMENT`, never read with another meaning);
  a search box sends its text as one quoted literal (`quoteLiteral`). An API whose lists also restrict fields
  (`state = FAILED`, `receive_time >= "..."`) keeps a parser of that larger subset, held to the same corpus
  (`testdata/filter-cases.json`: the same literals and refusals, a comparison aside, and every quoted search read
  back): Mail Hero's `mail-hero/cloudflare/src/native/api-filter.ts`. Its IDL lists each filter's fields, comparators
  and values; any other is `INVALID_ARGUMENT`.
- Counts end in `_count` (AIP-141: `card_count`, `created_task_count`, `liked_last_week_count`).
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
the query (`a.b=1`, repeated keys; form encoding, so `+` is a space; a malformed or non-UTF-8 escape is
`INVALID_ARGUMENT`, as in a path or a body, never read as U+FFFD), applies an AIP-134 `update_mask` (above),
checks UUID4 fields and clears `OUTPUT_ONLY` input fields (AIP-203), calls the typed handler and writes the
answer (`no-store`, `nosniff`). A handler may answer `new PreEncoded(body, headers)` instead of a message: wire JSON
it already holds, as text or as its UTF-8 bytes, written as it is with extra headers (an ETag), or `PreEncoded(null)`
for 304 Not Modified to a GET whose validator still matches. The dashboard's views use it (a Durable Object
serializes each view once and the Worker passes the bytes through within Free's 10 ms of CPU); the transcoder never
decodes the text, so the app's tests prove it is exactly what `toWire` writes (`dashboard/worker/test/wire-conformance.test.ts`). Anything a handler throws that is not an `RpcError`, and an answer the
profile refuses to write, is `INTERNAL` unless the app's `onUnexpected` says otherwise. A
path no binding has returns null, for the app's other routes; another method on a known path is 405 with
`Allow`; `OPTIONS` is 204 with `Allow` and no CORS headers (same-origin only); `HEAD` is `GET` without the
body. Handlers throw `RpcError(code, reason, message, {details})`; the body is a google.rpc.Status in Google's
HTTP form (`{"error": {"code": <HTTP status>, "message", "status": <code name>, "details": [ErrorInfo,
LocalizedMessage, RequestInfo, typed details]}}`, `ts/rpc-status.ts`). Messages are fixed English; nothing
from the request is echoed. Path templates (`ts/http-path.ts`) follow http.proto (`*`, `**`,
`{field.path=...}`, `:verb`, its percent-decoding rules), with the precise choices written at the top of the
file (a raw `:` in the last segment is a verb; literals beat `*` beat `**`). The constructor builds the route
table and reads what the codec needs from each method's input and output (`prepareWire`: REQUIRED fields, value
rules, field orders, enum names), so a Worker that constructs its transcoder at global scope reads the options during
startup, and an unsupported binding (`custom`, `response_body`, a body on GET or DELETE, a non-message body field)
fails the Worker's startup, which is its deploy, instead of a request.

**The client** (`ts/http-client.ts`, `createHttpClient(Service, send)`): one typed method per rpc
(`client.getWatch({ name: 'watches/w1' })` resolves to a `Watch`), laid out by the rpc's primary binding;
`send` is the app's transport (credentials, CSRF header, retries). A request it cannot lay out throws
`HttpEncodeError` before anything is sent: a path value that does not fit its template, or that has a `.` or
`..` segment (fetch would resolve it to another path, which the server cannot see), and a value the profile
cannot write; the same input fails the same way, so a transport never retries it. An update with a mask
sends only the masked fields. A non-2xx answer throws `RpcStatusError` with the parsed Status (`reason`,
`localizedMessage`, `requestId`, `readDetail(status, Schema)`), or `HttpResponseError` when the body is not
one (a proxy page, an expired Access session).

List sizes and serialization work are bounded by each application's CPU and bundle checks. Lists use indexed
keyset pagination and read only their page's rows. A repeated field in any page counts against that page's bound.
Applications that need startup warm-up use synthetic inputs at global scope; production handlers keep the same
validation and authentication path. Current budgets and acceptance tests belong to the application.

**Adding a UI API.**

1. Write `<app>/ui/v1/*.proto` by the conventions above; `pnpm run lint && pnpm run api-lint` until clean.
2. Add the app's UI package (its `web/`) as a TypeScript user: `"@ziyixi/proto": "workspace:*"` in
   `dependencies`, the `postinstall` and the pre-scripts (Rules); the Worker is one already if it uses proto.
3. Worker: `new HttpTranscoder(<App>UiService, handlers, { domain, maxBodyBytes, authorize, localize })` after
   authentication; keep the app's error copy as `localize` (for its own reasons and `CommonReason`), wrap each
   call to a dependency so that its failure is `UNAVAILABLE`, and leave everything else to the default
   `INTERNAL`. UI: `createHttpClient` with a transport that adds credentials and the CSRF header; read errors
   by `status.reason`, and retry only network failures and `UNAVAILABLE`.
4. Move the old routes off: an old UI tab calls the old paths until it reloads, so either keep them for one
   release as `additional_bindings` (when the old request and answer shapes still decode) or answer them
   with a "reload" error in the old envelope; remove that after one release. Check what the deployed old client
   does with that answer: a client that shows any code's message gets `reload_required`; the dashboard's shows the message only for its known codes, so it sends `not_found`
   (`dashboard/worker/test/http.test.ts` runs that client's error handling on the answer).
5. Budget what the runtime costs ([Cost](#http-apis)): the Worker's and the UI's bundles against
   budgets with `tools/bundle-size` (a ratchet of about 1.2 times the measured size, raised only on purpose), and
   the heaviest requests' CPU, the isolate's first API request included, with `tools/workerd-cpu` (bounds in
   milliseconds of its reference machine, scaled by the calibration). Lists of hundreds of items need page sizes
   from that test and the startup warm-up (Large lists, above).

Python: Todofy's backend is a Python Durable Object behind a TypeScript gateway, so the gateway transcodes and
the object reads and writes the generated Python messages ("What todofy.ui.v1 costs" above). A Python Worker
that serves HTTP itself would need a transcoder of its own that runs `testdata/http-cases.json`; the profile's
Python twin already supports every kind these APIs use.

Newsletter (`newsletter.ui.v1`) is the second Python producer behind a TypeScript Worker, a VPS service rather
than a Durable Object. Its console Worker routes and checks each request with the transcoder and forwards it;
Newsletter decodes it again with the shared `http_routes` ([Personal-cloud Python
runtime](#personal-cloud-python-runtime): GET bindings whose query parameters are integers or strings, which is why
its usage summary takes a number of days rather than an enum) and answers wire JSON that the Worker passes through
as `PreEncoded` without parsing it. The bytes are what `toWire` writes because Newsletter writes every answer with
`to_wire` and compact `json.dumps(..., ensure_ascii=False, separators=(",", ":"))`, never writes null (every output
field is `OUTPUT_ONLY`, so the `REQUIRED` exception above is not needed), and keeps its doubles to whole numbers and
seconds to the millisecond, which both codecs spell alike. Newsletter's reader writes the contract's golden answers
(`contracts/newsletter-ui-v1/fixtures`, `newsletter/scripts/console_fixtures.py`) and `test/newsletter-ui.test.ts` reads each
back and writes it again byte for byte.

## CI

Public `:check` roots expose native test closures. Target Determinator compares the candidate and baseline
Bazel graphs and selects affected test leaves and tagged release facades in one comparison. IDL imports,
generator inputs and runtime libraries participate through their declared dependencies; there is no separate
proto-to-application registry. Publication and reconcile remain in Actions.

`//proto:check` covers Buf formatting/lint, the Go api-linter and its annotation compatibility check, real TypeScript
compilation, both codecs and frozen wire fixtures, published Schema bytes, the original synthetic lint/breaking
mutation cases, and two canonical generator runs compared byte for byte. `//proto:breaking` adds the baseline
comparison, retirement rules and wire profile rules. Repository audit tests check one runtime version, package
wiring, ignored generated paths and each `proto_library`'s source/import metadata. The native graph integration
fixture verifies source, unconsumed-document and release-only changes with the pinned Target Determinator binary.

## Personal-cloud Python runtime

`platform/runtime/v1` is the bounded observation and deployment API of the independent `platform` VPS package. Its
`NodeStatus` and configured `WorkloadStatus` observations embed one shared `ReleaseStatus` with distinct
verified desired/actual identities. `fleet/telemetry/v1` embeds this `NodeStatus` directly in its bounded
signed host receipt; it does not copy release fields. Both packages are shipped in the shared Python package,
and both have generated TypeScript wire types. Contract and privacy/evidence semantics are in
[platform-runtime-v1](../contracts/platform-runtime-v1/README.md).

The VPS package depends on `ziyixi-proto` through the root uv workspace, like the Python
Worker. Its independently released OCI image includes generated code, the shared stdlib codec runtime
and locked application libraries. Kubernetes runs the daemon and a five-minute observer CronJob; the
production host needs no application Python packages, standalone executable, Node.js or `.proto` compiler.
The Linux amd64 image supplies Python 3.14; its build runs this pinned toolchain first. A code/image change
is separate from Newsletter's image/release.

Python HTTP services get a generated `HTTP_BINDINGS` table in each `*_service_pb` module. Entries contain
RPC identity, verb/path template and generated request/response classes. Shared `http_routes` matches and
strictly decodes bounded GET and generated body/query mutation bindings; `decode_json_body` refuses
duplicate JSON keys before the typed decoder. The server authenticates/rates/bounds its transport and dispatches
the typed request. Shared `rpc_status` emits the same fixed Google HTTP JSON errors as the TypeScript
runtime. This metadata and error transport are shared machinery, not application-maintained routes or
DTOs. Profile tests pin generated routes, bounds/null behavior and both runtimes' Google error tables.

Production dependency checks follow `.proto` import closure as well as direct generated-module imports:
embedding a shared descriptor compiles its dependencies into the bundle. Changing platform runtime can
therefore reach Fleet even when its source imports only `HostReport` or `FleetStatus`.

### Internal Model Router changes

`modelrouter.inference.v1` is an internal monorepo API. Its callers and owner console are updated together.
The owner explicitly permits deleting unused fields without reserved tags; the compatibility gate excludes only
this package and runtime test fixtures. Other APIs and frozen payloads keep their normal compatibility rules.
A breaking Router rollout uses its existing maintenance mode while the coordinated callers are published.
