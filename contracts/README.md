# Cross-app contracts

The only files the apps (`mail-hero/`, `todofy/`, `dashboard/`, `lab/`) share. No app imports another; each reads
these files.

The protobuf IDL of these contracts lives in [`../proto/`](../proto/README.md): `ops-v1`, `task-intent-v1` and
`mail-received-v1` (`proto/mailhero/webhook/v1`), whose sides all run on the generated code. It does not change the
wire: the fixtures here stay the published wire description, and their bytes round-trip through the generated codecs.
`ops-v1`'s and `mail-received-v1`'s JSON Schemas are generated from their IDL; `task-intent-v1`'s is still
hand-written, checked against the codec on every fixture.

| Directory | Between | Owner |
| --- | --- | --- |
| `mail-received-v1/` | Mail Hero → its webhook consumer (Todofy) | Mail Hero |
| `ops-v1/` | each app ↔ the ops dashboard `home` in [`dashboard/`](../dashboard/) (`Ops` entrypoints, canary, guard, digest) | Mail Hero, Todofy and Lab (`status()`/`setGuard()` only); see [`ops-v1/README.md`](ops-v1/README.md) |
| `task-intent-v1/` | a proposing app (Lab) → Todofy's `Ops` entrypoint: "create these Todoist tasks", idempotent per intent | Todofy; see [`task-intent-v1/README.md`](task-intent-v1/README.md) |

## `mail-received-v1/`

The webhook Mail Hero POSTs to its consumer. Mail Hero owns it.

| File | Purpose |
| --- | --- |
| `mail-received-v1.md` | Semantics: identity, retries, delivery status, content limits (Chinese) |
| `mail-received-v1.schema.json` | The single JSON Schema, generated from [`proto/mailhero/webhook/v1/mail_received.proto`](../proto/mailhero/webhook/v1/mail_received.proto) (`npm run schema` in `proto/`; `npm run check:schema` fails when it is stale): a consumer's schema, self-contained, every object open. Todofy's OpenAPI (`todofy/api/owner-api-v1.openapi.yaml`) and tests reference it by relative path; there is no copy |
| `legacy/mail-received-v1.schema.json` | The hand-written schema it replaced, frozen: Todofy's `test_mail_received_schema_legacy.py` gives it and the generated one the same verdict on every fixture and about 9,000 mutations (formats asserted), Mail Hero's `contract-schema-dialect.test.mjs` pins the one ECMAScript difference the IDL states |
| `fixtures/*.json` | Golden webhook bodies, exact bytes, written by Mail Hero's real `parseMail` + `buildPayload` from synthetic mail (`mail-hero/cloudflare/test/contract-fixtures.mjs`) |
| `fixtures/legacy/*.json` | Frozen bodies from older builders. Retries resend frozen bytes, so consumers keep accepting them; nothing regenerates them. Each file's SHA-256 is pinned in both apps' contract tests, so any byte change fails CI; adding a legacy file means adding its hash on both sides |

Checks, all run by the `Contracts` CI job (and by each app's own tests):

- Mail Hero, `mail-hero/cloudflare`: `node --test test/contract-fixtures.test.mjs` rebuilds every case (a generated message written by the wire codec) and fails if a fixture differs by one byte, or if a fixture has no case; `test/native-runtime.test.mjs` retries an event frozen by an older builder with its exact bytes.
- Todofy, `todofy`: `uv run pytest tests/unit/test_mail_hero_compat.py` validates every fixture (current and legacy) against the schema and parses and renders it with `todofy.core.contract.parse_mail_event` (the generated Python codec); `test_mail_received_parser_legacy.py` gives every fixture and mutation the verdict of the parser before the IDL; `tests/runtime/test_scenarios_webhook.py` posts each one to a real workerd gateway.
- `proto/`: `test/mail-received.test.ts` and `test/python/test_mail_received.py` read every fixture with each codec and write the current ones back byte for byte; `test/cross-language.test.ts` pipes them through both.

Changing the builder on purpose: in `mail-hero/cloudflare` run `npm run contract:update`, review the fixture diff, run Todofy's tests, and commit both in the same change. An incompatible change then fails `Contracts` before it can merge. The fixture files have no trailing newline; `.gitattributes` keeps git from rewriting them.

`fixtures/canary_event.json` is the ops-v1 end-to-end canary: the optional top-level `canary` marker
tells consumers not to cause external side effects (`mail-received-v1.md`, `ops-v1/README.md`).

Every fixture, current or legacy, has its own `event_id` and `message.id` (both apps' contract tests
check it): consumers deduplicate by `event_id`, and Todofy's runtime suite posts every fixture to one
Worker, so a reused ID would be answered 409 `event_conflict`. The generator's case numbers set the IDs;
`legacy/pre_storage_v1.json` holds number 16, so the canary is 17.

## `ops-v1/`

The IDL is [`proto/ops/v1/ops.proto`](../proto/ops/v1/ops.proto): services, messages, enums and every value
rule (`common.wire.v1` options). Every app and the dashboard read and write ops-v1 with the generated code and the
wire JSON codec, which checks the rules on every read and write. Here: the JSON Schema generated from the IDL
(`ops-v1.schema.json`, `npm run check:schema` in `proto/` fails when stale), `OPS_LIMITS` (`ops-v1.ts`: the
rules relative to a clock or a whole message), the frozen pre-IDL schema (`legacy/`), fixtures, the contract
text (`README.md`) and the per-app plan (`IMPLEMENTATION.md`). Checks:

- `Proto checks` (also on a change here alone: `PROTO_READS`): every valid fixture round-trips byte for byte
  through the TypeScript and Python codecs, every invalid one is refused by a strict read, both languages agree
  (`proto/test/ops.test.ts`, `test/python/test_ops.py`, `test/cross-language.test.ts`); the generated schema is
  fresh; `profile_breaking.py` refuses a changed rule of an output, a tightened rule of an input and a new value of
  a closed enum (every enum ops-v1 writes).
- `Contracts`: the generated schema is fresh; `todofy` `tests/unit/test_ops_contract.py` gives every fixture the
  verdict of the reference validator (Python `jsonschema` Draft 2020-12) and the codec's, and the generated
  and legacy schemas the same verdict on about 22,000 mutations of the valid fixtures. Golden tests pin the
  exact bytes each side answers, sends and keeps for fixed synthetic state, written before the move onto the
  IDL, and check every answer against the legacy schema the dashboards deployed before it validate with:
  `mail-hero/cloudflare/test/ops-golden.test.mjs`, `lab/worker/test/ops-golden.test.ts`,
  `todofy/tests/unit/test_ops_golden.py`, `dashboard/worker/test/ops-golden.test.ts`.
- Each app's own `Ops` code, on the host (also in `Contracts`): `test/native-ops.test.mjs` (Mail Hero: guard,
  status, canary delivery, input checks), `tests/unit/test_ops_core.py` (Todofy core rules) and
  `gateway/test/ops.test.ts` (Todofy's entrypoint forwarding); every value they produce is read back strictly.
- The caller, on the host: `dashboard/worker` `test/ops-client.test.ts` (the dashboard calls only the methods of
  each app's generated services and handles every `ErrorCode`, timeouts and invalid output) and
  `test/guard.test.ts`, `canary.test.ts`, `digest.test.ts` (every `SetGuardInput`, `StartCanaryInput` and
  `OpsReport` it builds passes the contract's rules).

The real-binding tests (`mail-hero/cloudflare/test/native-ops-runtime.test.mjs`,
`todofy/tests/runtime/test_ops.py`) call each app's `Ops` over a service binding in workerd, the way the
dashboard does; they run in each app's check job, which `contracts/` and `proto/ops/` changes also trigger. The
dashboard's own runtime suite (`dashboard/worker/test/runtime/`, in `Dashboard checks`) runs its real
`HomeState` against stub apps that answer with these fixtures. Lab's `Ops` is checked in workerd by
`lab/worker/test/runtime/ops.test.ts` (in `Lab checks`): every status and guard state is read back strictly.

## `task-intent-v1/`

Schema, the value rules the IDL cannot express (`task-intent-v1.ts`) and fixtures for
`proposeTasks`/`taskIntentStatus` on Todofy's `Ops` entrypoint (the types are generated from
`proto/todofy/taskintent/v1/task_intent.proto`):
another app (Lab) proposes up to 30 Todoist tasks under its own idempotency key and Todofy, the only
Todoist writer, creates them from its ledger. Fixtures are checked with `ops-v1/validate.mjs` by
`lab/worker/test/task-intent-contract.test.ts` and by Todofy's `tests/unit/test_task_intent_contract.py`
(Python `jsonschema`), both in the `Contracts` job, which also check that each language's generated types and
wire JSON codec agree with the schema on every fixture; Lab's `intent.test.ts` checks every intent it builds and
maps every result fixture, and its workerd suite sends real intents to a stub Todofy that validates them.
