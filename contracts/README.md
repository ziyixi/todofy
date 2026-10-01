# Cross-app contracts

The only files the apps (`mail-hero/`, `todofy/`, `dashboard/`, `lab/`) share. No app imports another; each reads
these files.

The protobuf IDL of these contracts lives in [`../proto/`](../proto/README.md) (today `task-intent-v1` only,
used in tests). It does not change the wire: the schemas and fixtures here stay the contracts.

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
| `mail-received-v1.schema.json` | The single JSON Schema. Todofy's OpenAPI (`todofy/api/owner-api-v1.openapi.yaml`) and tests reference it by relative path; there is no copy |
| `fixtures/*.json` | Golden webhook bodies, exact bytes, written by Mail Hero's real `parseMail` + `buildPayload` from synthetic mail (`mail-hero/cloudflare/test/contract-fixtures.mjs`) |
| `fixtures/legacy/*.json` | Frozen bodies from older builders. Retries resend frozen bytes, so consumers keep accepting them; nothing regenerates them. Each file's SHA-256 is pinned in both apps' contract tests, so any byte change fails CI; adding a legacy file means adding its hash on both sides |

Checks, all run by the `Contracts` CI job (and by each app's own tests):

- Mail Hero, `mail-hero/cloudflare`: `node --test test/contract-fixtures.test.mjs` rebuilds every case and fails if a fixture differs by one byte, or if a fixture has no case.
- Todofy, `todofy`: `uv run pytest tests/unit/test_mail_hero_compat.py` validates every fixture (current and legacy) against the schema and parses and renders it with `todofy.core.contract.parse_mail_event`; `tests/runtime/test_scenarios_webhook.py` posts each one to a real workerd gateway.

Changing the builder on purpose: in `mail-hero/cloudflare` run `npm run contract:update`, review the fixture diff, run Todofy's tests, and commit both in the same change. An incompatible change then fails `Contracts` before it can merge. The fixture files have no trailing newline; `.gitattributes` keeps git from rewriting them.

`fixtures/canary_event.json` is the ops-v1 end-to-end canary: the optional top-level `canary` marker
tells consumers not to cause external side effects (`mail-received-v1.md`, `ops-v1/README.md`).

Every fixture, current or legacy, has its own `event_id` and `message.id` (both apps' contract tests
check it): consumers deduplicate by `event_id`, and Todofy's runtime suite posts every fixture to one
Worker, so a reused ID would be answered 409 `event_conflict`. The generator's case numbers set the IDs;
`legacy/pre_storage_v1.json` holds number 16, so the canary is 17.

## `ops-v1/`

Schema (`ops-v1.schema.json`), TypeScript types (`ops-v1.ts`, imported by relative path), a
dependency-free validator for the TypeScript side (`validate.mjs`), fixtures, the contract text
(`README.md`) and the per-app plan (`IMPLEMENTATION.md`). Checks, all in the `Contracts` CI job:

- Fixtures against the schema, with both validators so their verdicts cannot drift: `node --test
  test/ops-contract.test.mjs` in `mail-hero/cloudflare` (`validate.mjs`, every valid and invalid fixture,
  the `ops-v1.ts` constants) and `uv run pytest tests/unit/test_ops_contract.py` in `todofy` (Python
  `jsonschema` Draft 2020-12 on the same fixtures; the schema stays inside the keyword subset
  `validate.mjs` implements).
- Each app's own `Ops` code, on the host: `test/native-ops.test.mjs` (Mail Hero: guard, status, canary
  delivery, input checks), `tests/unit/test_ops_core.py` (Todofy core rules) and `gateway/test/ops.test.ts`
  (Todofy's entrypoint forwarding); every value they produce is validated against the schema.
- The caller, on the host: `dashboard/worker` `test/ops-client.test.ts` (the dashboard calls only the
  methods `MailHeroOps`/`TodofyOps` declare and handles every `OPS_ERROR_CODES` value, timeouts and
  invalid output) and `test/guard.test.ts`, `canary.test.ts`, `digest.test.ts` (every `SetGuardInput`,
  `StartCanaryInput` and `OpsReport` it builds passes `validate.mjs`).

The real-binding tests (`mail-hero/cloudflare/test/native-ops-runtime.test.mjs`,
`todofy/tests/runtime/test_ops.py`) call each app's `Ops` over a service binding in workerd, the way the
dashboard does; they run in each app's check job, which `contracts/` changes also trigger. The
dashboard's own runtime suite (`dashboard/worker/test/runtime/`, in `Dashboard checks`) runs its real
`HomeState` against stub apps that answer with these fixtures. Lab's `Ops` is checked in workerd by
`lab/worker/test/runtime/ops.test.ts` (in `Lab checks`): every status and guard state passes the schema.

## `task-intent-v1/`

Schema, TypeScript types and fixtures for `proposeTasks`/`taskIntentStatus` on Todofy's `Ops` entrypoint:
another app (Lab) proposes up to 30 Todoist tasks under its own idempotency key and Todofy, the only
Todoist writer, creates them from its ledger. Fixtures are checked with `ops-v1/validate.mjs` by
`lab/worker/test/task-intent-contract.test.ts` and by Todofy's `tests/unit/test_task_intent_contract.py`
(Python `jsonschema`), both in the `Contracts` job; Lab's `intent.test.ts` checks every intent it builds and
maps every result fixture, and its workerd suite sends real intents to a stub Todofy that validates them.
