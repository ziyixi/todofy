-- Planning store v1 (docs/todoist-plus.md, "Planning store"). Additive: the previous release neither reads nor
-- writes these tables or the two new summaries columns, so CI may apply this before the deploy and a code
-- rollback leaves them idle. Never run a down DDL in production: DROP COLUMN rewrites every summaries row.
--
-- What lives here: owner-authored planning facts and Todofy's own task identities. Never task content: no
-- title, description, comment or step text (Todoist is the task store). Todoist label and filter semantics
-- live in one adapter document, plan_settings 'todoist'; no other table names a label or a filter.
-- Conventions as in 0001-0006: Unix seconds (UTC); rowid tables only (the weekly backup pages by rowid); no
-- foreign keys or triggers (restore order must not matter). Closed lifecycles get IN-list CHECKs; growing
-- vocabularies (provider, kind, scheme) only a shape CHECK and are closed in core/plan.py, because SQLite
-- changes a CHECK only by rebuilding the table. Periods: a week is the account-local Monday 'YYYY-MM-DD'
-- (Plan.week_start); a month 'YYYY-MM'; a quarter 'YYYY-Qn'. Each kind uses exactly one granularity
-- (core/plan.py), so periods are compared within one kind.

-- Small JSON documents, one per key, each with one meaning:
--   'account'  {"timezone": "<IANA name>"}                     the owner's calendar, confirmed at setup
--   'week'     {"current": "YYYY-MM-DD"}                        the week in effect; only its finished reset advances it
--   'todoist'  {"enabled": bool, "etag": "<sha256>",            the Todoist adapter's confirmed binding: role -> label
--               "labels": [{"role", "id", "label"}],           ID and name ('candiate' stays a frozen role key), and
--               "triage_priority": bool}                       whether a Mailbox triage sets the mail task's priority
CREATE TABLE plan_settings (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 32 AND key NOT GLOB '*[^a-z_.]*'),
  value TEXT NOT NULL CHECK (json_valid(value) AND length(value) <= 65536),
  updated_at INTEGER NOT NULL
);

-- Todofy's own task identity. A row is created lazily, the first time a task gets a planning fact (a mark or
-- an edge), and is never deleted: an ID handed out never changes meaning (AUTOINCREMENT: never reused).
-- (provider, external_id) is the reference into the task store: 'todoist' and the Todoist task ID today.
-- Ledger columns that already hold Todoist IDs (summaries.task_id, mail_events.task_id, gtd_*, FlowDay) resolve
-- through this pair, so nothing is ever re-keyed. A future system of record adds content beside this row.
CREATE TABLE plan_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 16 AND provider NOT GLOB '*[^a-z]*'),
  external_id TEXT NOT NULL
    CHECK (length(external_id) BETWEEN 1 AND 100 AND external_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  created_at INTEGER NOT NULL,
  -- Set only from a confirmed provider answer (a Plus CompleteTask, or ResolveDependencies' activity read).
  -- 'completed' satisfies the edges that wait for this task. A reopened task shows up in the active list again;
  -- the views trust that list first, so a stale 'completed' only skips the one-time "was deleted" notice.
  closed_at INTEGER,
  closed_as TEXT CHECK (closed_as IN ('completed', 'deleted')),
  CHECK ((closed_at IS NULL) = (closed_as IS NULL)),
  UNIQUE (provider, external_id)
);

-- A task's membership in a period, by kind:
--   committed, bet  an explicit choice, made on a week's last day, for the week in `period`: that week's reset
--                   keeps the task's label of this kind, then deletes the row
--   kept            a someday task kept in the weekly review of `period` (was app.todoist.com localStorage);
--                   the next week's reset deletes the row
CREATE TABLE plan_marks (
  task_id INTEGER NOT NULL,  -- plan_tasks.id
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 24 AND kind NOT GLOB '*[^a-z_]*'),
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    OR period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' OR period GLOB '[0-9][0-9][0-9][0-9]-Q[1-4]'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, kind, period)
);
-- The week's choices (kind IN (...) AND period ...) and the reset's consume.
CREATE INDEX plan_marks_period ON plan_marks (kind, period);

-- Directed links between tasks, IDs only. kind 'waits_for': task_id should not start before prerequisite_id is
-- done. baseline_count is the prerequisite's completed_count when linked, so a recurring prerequisite is
-- satisfied by its next completion. At most 5 per task and 300 in all, never a cycle (core/plan.py, checked
-- under plus_lock). The waiter's completion deletes its rows; a prerequisite confirmed deleted deletes the rows
-- that wait for it (their waiters get a one-time notice).
CREATE TABLE plan_edges (
  task_id INTEGER NOT NULL,          -- plan_tasks.id: the task that waits
  prerequisite_id INTEGER NOT NULL,  -- plan_tasks.id: the task it waits for
  kind TEXT NOT NULL DEFAULT 'waits_for' CHECK (length(kind) BETWEEN 1 AND 24 AND kind NOT GLOB '*[^a-z_]*'),
  baseline_count INTEGER NOT NULL DEFAULT 0 CHECK (baseline_count >= 0),
  created_at INTEGER NOT NULL,
  CHECK (task_id <> prerequisite_id),
  PRIMARY KEY (task_id, prerequisite_id, kind)
);
-- Who waits for a task: settling a completed or deleted prerequisite.
CREATE INDEX plan_edges_prerequisite ON plan_edges (prerequisite_id);

-- Owner-written text per period and area. kind 'bets': the week's Work and Personal Bets (area 'work' |
-- 'personal'). kind 'review': the week's review progress, area '', a JSON array of ticked step keys (no text).
-- rev is the compare-and-set version a client sends back; resending the stored body is a replay, not a conflict.
CREATE TABLE plan_notes (
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    OR period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' OR period GLOB '[0-9][0-9][0-9][0-9]-Q[1-4]'),
  area TEXT NOT NULL DEFAULT '' CHECK (length(area) <= 24 AND area NOT GLOB '*[^a-z_]*'),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 24 AND kind NOT GLOB '*[^a-z_]*'),
  body TEXT NOT NULL CHECK (length(body) <= 4000),
  rev INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (period, area, kind),
  CHECK (kind <> 'review' OR (area = '' AND json_valid(body)))
);

-- Owner-defined classifications; scheme 'mail' is the Mailbox triage. priority is the domain order, 1 = most
-- urgent (the Todoist adapter writes API priority 5 - priority). Archived, never deleted, so summaries.category_id
-- stays resolvable; an archived name may be used again. At most 20 active per scheme (core/plan.py).
CREATE TABLE plan_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheme TEXT NOT NULL DEFAULT 'mail' CHECK (length(scheme) BETWEEN 1 AND 16 AND scheme NOT GLOB '*[^a-z_]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  priority INTEGER NOT NULL DEFAULT 4 CHECK (priority BETWEEN 1 AND 4),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 999),
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX plan_categories_name ON plan_categories (scheme, name) WHERE archived_at IS NULL;

-- Mailbox: a MailItem is the existing summaries row (subject, summary, mail task, time), so mail text is not
-- copied again. The one-line summary is the summary's first sentence, derived at read time. category_id is
-- deliberately not indexed: a triage writes one row, and lists filter the open set in memory.
ALTER TABLE summaries ADD COLUMN category_id INTEGER CHECK (category_id IS NULL OR category_id > 0);  -- plan_categories.id
ALTER TABLE summaries ADD COLUMN triaged_at INTEGER;  -- the owner's last triage; NULL = not triaged
-- The Mailbox looks up the open mail tasks the client already holds. Partial on both terms: building it writes an
-- entry only for the rows Mail Hero delivered (imported = 0), never for the imported archive, whose size
-- production has not counted; its queries repeat "task_id <> '' AND imported = 0".
CREATE INDEX summaries_task ON summaries (task_id) WHERE task_id <> '' AND imported = 0;
