# `task-intent-v1`: another app proposes Todoist tasks to Todofy

Todofy is the only app that writes to Todoist. When another app in the account wants tasks created
(Lab: "send today's liked papers to Todoist"; the watch app: its daily digest and urgent changes), it sends Todofy a **task intent**: a parent
title and up to 30 items, under an idempotency key the proposer chooses. Todofy records it in its own
D1 ledger, creates the tasks with its existing Todoist client and answers with counts. The proposer
never sees a Todoist token, and a repeated or retried proposal never creates a task twice.

Status: contract written 2026-09-30 with Lab's design (`lab/docs/design.md` §9). Both sides are
implemented (not released): Lab in `lab/worker/src/intent.ts` and `owner.ts`; Todofy in
`todofy/worker/todofy/core/intents.py` (validation, canonical form, task text, state machine, results),
`core/sql/intents.py`, `runtime/intents.py`, `todofy/gateway/src/ops.ts` and migration
`todofy/migrations/0005_task_intents.sql`.

| File | Purpose |
| --- | --- |
| `task-intent-v1.schema.json` | JSON Schema 2020-12: `TaskIntent`, `TaskIntentRef`, `TaskIntentResult` (inside the keyword subset of `../ops-v1/validate.mjs`). The published wire description, value rules included |
| `task-intent-v1.ts` | The value rules the IDL cannot express: `TASK_INTENT_VERSION`, the URL host allow-list, the bounds (dependency-free, erasable-only, imported by relative path) |
| `fixtures/<Def>/*.json` | Valid examples (synthetic papers only); `fixtures/invalid/<Def>/*.json` must fail |
| [`../../proto/todofy/taskintent/v1/task_intent.proto`](../../proto/todofy/taskintent/v1/task_intent.proto) | The IDL: messages, enums (`Source`, `Mode`, `State`, `ErrorCode`) and `TaskIntentService`. Both apps use the generated code and the wire JSON profile codecs ([`proto/README.md`](../../proto/README.md)); generated, never committed |

## Transport

Two methods on Todofy's existing named entrypoint `Ops` (`todofy/gateway/src/ops.ts`, the class the
dashboard already binds for ops-v1). The proposer binds it with a service binding; there is no public
route and no Access policy (same trust boundary as ops-v1: only a Worker deployed in this account can
create the binding).

```toml
# lab/wrangler.toml
[[services]]
binding = "TODOFY"
service = "todofy"
entrypoint = "Ops"
```

The same two methods are also on Todofy's least-privilege entrypoint `Intents` (the same file), which has
nothing else and takes only the source its binding names in `props`. The watch app binds it (it parses
untrusted pages, so it gets neither Todofy's ops-v1 methods nor another source's allow-list and daily quota):

```toml
# watch/wrangler.toml
[[services]]
binding = "TODOFY"
service = "todofy"
entrypoint = "Intents"
props = { source = "watch" }
```

Through `Intents`, an input whose `source` is not the binding's (or a binding without that prop) rejects
`invalid_input` before the core wakes; everything else is as through `Ops`. A new proposer binds `Intents`;
moving Lab over is a later change of its own.

```ts
import type { TaskIntentService } from '@ziyixi/proto/todofy/taskintent/v1/task_intent_pb';
import type { WireService } from '@ziyixi/proto/wire-json';
interface TodofyIntentEntrypoint extends Rpc.WorkerEntrypointBranded, WireService<typeof TaskIntentService> {}
interface Env { TODOFY: Service<TodofyIntentEntrypoint> }
```

Each method takes and returns the message as its wire JSON object (a structured clone of exactly the JSON
below): the proposer writes the input with `toWire` and reads the answer with `fromWire` (lenient: an
output), Todofy reads the input strictly and writes the result with `to_wire`.

The gateway forwards each call to one new `TodofyCore` RPC method (`task_intent_propose(json)`,
`task_intent_status(json)`) that answers `{ok}` or `{error}`, exactly like the ops-v1 methods.

| Method | Input | Output | Writes |
| --- | --- | --- | --- |
| `proposeTasks(intent)` | `TaskIntent` | `TaskIntentResult` | at most one ledger row + its items (D1), then the alarm creates the tasks |
| `taskIntentStatus(ref)` | `TaskIntentRef` | `TaskIntentResult` | none |

**Errors.** As in ops-v1, a method rejects only with `new Error(code)`: `invalid_input` (the input fails
the schema, or its compact JSON is over 64 KiB; do not retry unchanged), `busy`, `unavailable`. A caller
treats any other rejection (binding error, deploy in progress, an older Todofy without these methods)
like `unavailable` and **does not know** whether the intent was recorded: it retries later with the
same `intent_id` and the same content. Every expected outcome is a value.

## Intent

```json
{"version": "task-intent-v1", "source": "lab", "intent_id": "deck-2026-09-30-g1", "mode": "subtasks",
 "parent": {"title": "论文雷达 2026-09-30 · 3 篇", "description": "…"},
 "items": [{"title": "…", "url": "https://arxiv.org/abs/2609.00001", "description": "…"}]}
```

- `source` is a closed list (`lab`, `watch`). Each source has a URL host allow-list (`TASK_INTENT_URL_HOSTS`,
  lab: `arxiv.org`; watch: `watch.ziyixi.science`, so a watch task links to the change in the app and never to a
  watched page); any other host is `rejected`/`url_not_allowed`. Todofy never fetches a URL.
  `SOURCE_WATCH` was added on 2026-10-01 (an additive value: `buf breaking` and the profile rules pass, Lab keeps
  writing `lab` only, Todofy accepts both).
- The watch app (`watch/worker/src/todofy.ts`) sends at most one digest a UTC day (`digest-<day>`, subtasks: one
  item per watch with only the owner's name for it, the trigger type and a count, linking to
  `https://watch.ziyixi.science/watches/<id>`; never page text, a watched URL or a summary) and urgent changes at
  once (`urgent-<change id>`, separate mode). Because Todofy counts the 10 per source by the day it records an
  intent, the app freezes an urgent intent only while its open intents (of any day) plus those recorded today plus
  one slot for a digest not yet frozen stay below 10, folds open intents Todofy surely never recorded into the next
  digest, and proposes the digest first, so a pause across midnight cannot crowd out a day's digest. It polls an
  intent Todofy holds and proposes a `failed` one again with the same bytes (the state table below).
- `intent_id` is the idempotency key, unique per source **for ever** (the ledger row is kept, content
  removed, see Retention). Lab uses `deck-<day>-g<generation>`; the watch app `digest-<day>` and
  `urgent-<change id>`.
- `mode`: `subtasks` = one parent task plus one subtask per item (default in Lab); `separate` = one
  top-level task per item, no parent task.
- `items`: 1–30, distinct, created in the given order. Titles are single-line plain text; descriptions
  plain text with newlines. No due dates, labels, priorities or projects: tasks go to Todofy's
  `TODOIST_DEFAULT_PROJECT_ID` like mail tasks.

**Freezing.** The first proposal Todofy records freezes the intent. Todofy stores the SHA-256 of its
canonical form (the validated fields re-serialised in schema order, compact, without absent optionals: the
message's wire JSON as the profile writes it).
The same `(source, intent_id)` with the same hash is a replay; with another hash it is
`rejected`/`intent_conflict` and the stored intent is untouched.

## States

| `state` | `recorded` | Meaning | What the proposer does |
| --- | --- | --- | --- |
| `pending` | true | Recorded; Todofy's alarm is creating the tasks (`tasks_created` so far). `error_code` `retry_wait` or `rate_limited` while an attempt waits. | poll `taskIntentStatus` after `retry_after_seconds` (≥ 3 s) |
| `created` | true | Every task exists. From `taskIntentStatus`, or from `proposeTasks` never (creation is asynchronous). | done |
| `duplicate` | true | `proposeTasks` for an intent that was **already** fully created: nothing new was sent. | show "already sent" |
| `paused` | false | Todofy does not accept intents now: `maintenance`, `processing_paused`, `todoist_paused` (`FORCE_PAUSE_TODOIST`), `todoist_blocked` (auth block), `backup_active`. **Nothing was recorded.** | may edit and propose again later (same `intent_id` is fine) |
| `paused` | true | Recorded earlier, creation held for the same reasons; resumes by itself. Also the answer to `proposeTasks` for a **failed** intent while a pause holds: nothing was re-queued, and `taskIntentStatus` keeps answering `failed`. | poll less often; after a retry of a failed intent, show it as still failed and retry after the pause |
| `failed` | true | Todoist refused a task (`todoist_rejected`) or its result stayed unknown after the footer lookup (`todoist_result_unknown`); `tasks_created` < `tasks_total`. | offer retry: `proposeTasks` again with the **same** content re-queues only the unfinished tasks (unknown ones get a lookup first) |
| `rejected` | false | Refused, nothing recorded or sent: `daily_limit`, `url_not_allowed`, `source_not_allowed`. | show the reason |
| `rejected` | true | `intent_conflict`: another content already holds this `intent_id` (counts are that intent's). | a proposer bug: never reuse an id with new content |
| `not_found` | false | `taskIntentStatus` for an id Todofy never recorded. | treat like "not sent" |

`retry_after_seconds` is a hint (null when there is nothing to wait for). Proposers poll no more often
than every `statusMinIntervalSeconds` (3 s) and stop after a few minutes (Lab polls only while the
owner looks at the send screen).

**Content rule.** Results carry codes, counts, booleans, the caller's own IDs and a timestamp: never
task text, Todoist IDs or remote response text. Todofy logs only `source`, `intent_id`, counts and codes.

## Todofy's side (implemented; keeps every existing behaviour identical)

- **Migration** `todofy/migrations/0005_task_intents.sql` (renumbered from 0004 at merge, after the
  GTD ledger's `0004_gtd.sql`; the file is additive and independent of it):
  `task_intents(source, intent_id, payload_sha256, mode, tasks_total, tasks_created, state, error_code,
  payload_json NULL, created_at, updated_at, PK(source, intent_id))` and
  `task_intent_tasks(source, intent_id, n, request_id, state, attempts, next_attempt_at, todoist_id NULL,
  PK(source, intent_id, n))` (n = 0 is the parent in subtasks mode). `request_id` is a UUID frozen at
  record time and reused for every attempt of that task (`X-Request-Id`).
- **Record** (`task_intent_propose`): validate against the schema rules (the core owns validation, like
  ops-v1: a strict wire read of the generated `TaskIntent`, then the value rules), then in this order: (1) an existing row for `(source, intent_id)` → replay, answered before
  any other check (like ops-v1's `startCanary`): another hash → `rejected`/`intent_conflict`; created →
  `duplicate`; `failed` → re-queue the unfinished tasks → `pending`, but while a pause below holds nothing
  is re-queued (no write under a pause) and the answer is `paused` (recorded, the pause's code;
  `taskIntentStatus` still answers `failed`); otherwise its current state, reported as `paused`
  (recorded) while a pause holds; (2) maintenance /
  processing paused / force pause / auth block / backup lease → `paused`, nothing written; (3)
  `daily_limit` (10 new intents per source and UTC day) → `rejected`; (4) insert the intent and its task
  rows in one D1 batch and wake the alarm → `pending`. It never calls Gemini.
- **Create** (alarm): intent work shares the existing `_step` with the mail ledger (when both are due
  they alternate, so mail keeps its cadence); one step creates at most **6** tasks of one intent through
  the existing `todoist.create_task` (≤ 3 attempts each, same frozen bytes and `X-Request-Id`), which
  keeps a step under Workers Free's 50 subrequests per invocation. Every call is counted in the existing
  15-minute Todoist window and gated by the existing `_todoist_wait` (force pause, auth block, window).
  In subtasks mode the parent (n = 0) is created first and its Todoist ID becomes each child's
  `parent_id` (`core/todoist_request.build_task_request` gains an optional `parent_id`; a child sends it
  instead of `project_id`, and a child's frozen body is built only once the parent's ID is known). If the
  parent fails, no child is sent. Verdicts map as for mail: CREATED → task done;
  RETRY_LATER → `retry_wait` with the existing backoff; BLOCKED → the existing 6 h auth block
  (`paused`/`todoist_blocked`); UNKNOWN → a read-only footer lookup (existing `find_footer_tasks`
  generalised to a footer string) before anything is resent; a 4xx refusal → `failed`/`todoist_rejected`.
  Automatic attempts stop after 48 tries or 7 days per task (→ `failed`).
- **Task text** (deterministic, `core/intents.py`: `task_text`, `footer`): content = the title; description = the
  item's description, then its URL on its own line, then a footer line
  `Todofy intent: <source>/<intent_id>#<n>` (the lookup key, like the mail footer). In separate mode the
  parent title is added as a line above the footer (`— 论文雷达 2026-09-30 · 3 篇`). Titles are sent as
  given (no Markdown added).
- **Retention**: `payload_json` is set to NULL once every task exists or the intent is failed for
  30 days; the row (hash, counts, codes, request IDs, Todoist IDs) is kept 400 days for idempotency, then
  deleted with the existing retention tick.
- **Not affected by the ops-v1 guard** (owner-initiated, like real mail), not reported in the reminder,
  not in `status()` beyond two counters (`intents_pending`, `intents_failed_7d`).
- **Gateway**: `Ops.proposeTasks` / `Ops.taskIntentStatus` check only that the input is JSON and at most
  64 KiB, then forward; a failed core call rejects `unavailable`. `Coordinator` in
  `gateway/src/coordinator.ts` gains the two RPC signatures.

## Checks

- Schema/fixtures with both validators: Lab's `lab/worker/test/task-intent-contract.test.ts`
  (`../ops-v1/validate.mjs` over every fixture, the generated enums and the constants of `task-intent-v1.ts`
  against the schema) and `todofy/tests/unit/test_task_intent_contract.py` (Python `jsonschema` on the
  same fixtures, same verdicts). Both run in the `Contracts` CI job.
- The codecs against the schema, on every fixture and in both languages (the same two tests): every valid
  fixture reads (inputs strictly, results leniently) and writes back to its exact compact bytes; of the
  invalid ones, the codec sees every structural fault (a strict read refuses it, a lenient one refuses it or
  lists what it skipped) and the rest break only a value rule, which the schema and each app's own checks
  hold. `proto/test/cross-language.test.ts` pipes the same fixtures and messages built in each language
  through both codecs and requires identical bytes.
- Frozen bytes: Lab's `intent.test.ts` pins the bytes its builder froze before the generated types, and
  Todofy's `test_intents.py` pins the canonical form and SHA-256 of every intent fixture (D1 keeps those
  hashes 400 days; a replay must hash the same).
- Todofy: unit tests of validation, canonical hash, rendering and the state machine; runtime tests over a
  real service binding (fake Todoist): replay, conflict, pause, unknown + lookup, partial failure retry,
  48-attempt cap, and that mail processing is unchanged with and without intents.
- Lab: its client maps every state and error code, and every result it stores passes the schema.

Changing the contract: additive changes (a new source, a new error code) update the `.proto` file, the
schema, fixtures and both sides in one change (`buf breaking` and the profile rules gate the rest; a new
`ErrorCode` value fails Lab's UI typecheck until it has its copy). An older reader takes the default branch
on a value it does not know: an unknown state is an unreadable answer (Lab asks again later), an unknown
error code no reason. Anything else is `task-intent-v2`.
