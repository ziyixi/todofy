-- task-intent-v1 (contracts/task-intent-v1): another app (today only Lab) proposes Todoist tasks;
-- Todofy records each intent once and creates its tasks in the alarm (runtime/intents.py).
-- Additive: the previous release never reads or writes these tables, so its SQL keeps working
-- between this migration and the deploy, and after a code rollback (recorded intents then simply
-- wait until a release that knows them is live again).
-- Numbering: first written as 0004 on 2026-09-30 and renumbered 0005 when it was rebased onto the
-- GTD ledger's 0004_gtd.sql (merged first). The two are independent: neither touches the other's
-- tables, so only the order of application changed, never the content.
-- State columns carry CHECKs that mirror worker/todofy/core/intents.py; error-code columns stay
-- free text, as in 0001_init.sql. Times are Unix seconds (UTC).

-- One row per (source, intent_id): the idempotency ledger. payload_json is the intent's canonical
-- JSON, kept only while its tasks still need it (dropped once every task exists, and 30 days after
-- the intent failed); the row itself is kept 400 days after its last change (retention.py).
CREATE TABLE task_intents (
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 32 AND source NOT GLOB '*[^a-z0-9-]*'),
  intent_id TEXT NOT NULL CHECK (length(intent_id) BETWEEN 1 AND 64),
  payload_sha256 TEXT NOT NULL
    CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  mode TEXT NOT NULL CHECK (mode IN ('subtasks', 'separate')),
  tasks_total INTEGER NOT NULL CHECK (tasks_total BETWEEN 1 AND 31),
  tasks_created INTEGER NOT NULL DEFAULT 0 CHECK (tasks_created BETWEEN 0 AND tasks_total),
  state TEXT NOT NULL CHECK (state IN ('pending', 'created', 'failed')),
  error_code TEXT NOT NULL DEFAULT '',
  payload_json TEXT CHECK (payload_json IS NULL OR length(payload_json) <= 65536),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source, intent_id),
  -- Task text must not outlive the work that needs it.
  CHECK (payload_json IS NULL OR state <> 'created'),
  CHECK (state <> 'created' OR tasks_created = tasks_total)
);
-- The alarm's next due intent and its wake-up time.
CREATE INDEX task_intents_due ON task_intents (state, next_attempt_at);
-- Retention (failed payloads after 30 days, rows after 400) and status() counters.
CREATE INDEX task_intents_updated ON task_intents (state, updated_at);
-- The per-source daily limit on new intents.
CREATE INDEX task_intents_created ON task_intents (source, created_at);

-- One row per Todoist task of an intent: n = 0 is the parent (subtasks mode), n = 1..30 the items
-- in order. request_id is frozen when the intent is recorded and sent as X-Request-Id on every
-- attempt of that task; todoist_id is set once the task exists.
CREATE TABLE task_intent_tasks (
  source TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n BETWEEN 0 AND 30),
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'unknown', 'recheck', 'created', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  todoist_id TEXT CHECK (todoist_id IS NULL OR length(todoist_id) BETWEEN 1 AND 64),
  error_code TEXT NOT NULL DEFAULT '',
  -- Start of the automatic retry window (48 attempts or 7 days); reset when the proposer retries.
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source, intent_id, n),
  CHECK ((state = 'created') = (todoist_id IS NOT NULL))
);
