# `task-intent-v1`: another app proposes Todoist tasks to Todofy

Todofy is the only app that writes to Todoist. When another app in the account wants tasks created
(today only Lab: "send today's liked papers to Todoist"), it sends Todofy a **task intent**: a parent
title and up to 30 items, under an idempotency key the proposer chooses. Todofy records it in its own
D1 ledger, creates the tasks with its existing Todoist client and answers with counts. The proposer
never sees a Todoist token, and a repeated or retried proposal never creates a task twice.

Status: contract written 2026-09-30 with Lab's design (`lab/docs/design.md` §9). Both sides are
implemented (not released): Lab in `lab/worker/src/intent.ts` and `owner.ts`; Todofy in
`todofy/worker/todofy/core/intents.py` (validation, canonical form, task text, state machine, results),
`core/sql/intents.py`, `runtime/intents.py`, `todofy/gateway/src/ops.ts` and migration
`todofy/migrations/0004_task_intents.sql`.

| File | Purpose |
| --- | --- |
| `task-intent-v1.schema.json` | JSON Schema 2020-12: `TaskIntent`, `TaskIntentRef`, `TaskIntentResult` (inside the keyword subset of `../ops-v1/validate.mjs`) |
| `task-intent-v1.ts` | Dependency-free TypeScript types, constants and bounds (erasable-only, imported by relative path) |
| `fixtures/<Def>/*.json` | Valid examples (synthetic papers only); `fixtures/invalid/<Def>/*.json` must fail |

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

```ts
import type { TaskIntentOps } from '<relative path>/contracts/task-intent-v1/task-intent-v1.ts';
interface TodofyIntentEntrypoint extends Rpc.WorkerEntrypointBranded, TaskIntentOps {}
interface Env { TODOFY: Service<TodofyIntentEntrypoint> }
```

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

- `source` is a closed list (`lab`). Each source has a URL host allow-list (`TASK_INTENT_URL_HOSTS`,
  lab: `arxiv.org`); any other host is `rejected`/`url_not_allowed`. Todofy never fetches a URL.
- `intent_id` is the idempotency key, unique per source **for ever** (the ledger row is kept, content
  removed, see Retention). Lab uses `deck-<day>-g<generation>`.
- `mode`: `subtasks` = one parent task plus one subtask per item (default in Lab); `separate` = one
  top-level task per item, no parent task.
- `items`: 1–30, distinct, created in the given order. Titles are single-line plain text; descriptions
  plain text with newlines. No due dates, labels, priorities or projects: tasks go to Todofy's
  `TODOIST_DEFAULT_PROJECT_ID` like mail tasks.

**Freezing.** The first proposal Todofy records freezes the intent. Todofy stores the SHA-256 of its
canonical form (the validated fields re-serialised in schema order, compact, without absent optionals).
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
  ops-v1), then in this order: (1) an existing row for `(source, intent_id)` → replay, answered before
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
  (`../ops-v1/validate.mjs` over every fixture, constants of `task-intent-v1.ts` against the schema) and
  `todofy/tests/unit/test_task_intent_contract.py` (Python `jsonschema` on the
  same fixtures, same verdicts). Both run in the `Contracts` CI job.
- Todofy: unit tests of validation, canonical hash, rendering and the state machine; runtime tests over a
  real service binding (fake Todoist): replay, conflict, pause, unknown + lookup, partial failure retry,
  48-attempt cap, and that mail processing is unchanged with and without intents.
- Lab: its client maps every state and error code, and every result it stores passes the schema.

Changing the contract: additive changes (a new source, a new error code) update the schema, the TS
constants, fixtures and both sides in one change. Anything else is `task-intent-v2`.
