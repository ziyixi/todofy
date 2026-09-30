-- GTD ledger and the morning brief's carryover (docs/gtd-features.md). Additive: the previous release
-- never reads or writes these tables or the new column, so this migration may run before the deploy and
-- survives a code rollback. No table holds task text: IDs, project IDs, label names, priorities, dates,
-- counts and a keyed content hash only.

-- The Todoist project the day's reminder was sent to, frozen with the claim so a retry sends the same
-- request after TODOIST_OPS_PROJECT_ID changes. '' for rows claimed before this migration (they went to
-- TODOIST_DEFAULT_PROJECT_ID).
ALTER TABLE mail_reminders ADD COLUMN project_id TEXT NOT NULL DEFAULT '' CHECK (length(project_id) <= 64);

-- One read-only snapshot of the active Todoist tasks per UTC day; a rerun the same day replaces it.
-- partial: the page cap (10 pages of 200) was reached; failed: a Todoist call failed or answered garbage.
CREATE TABLE gtd_snapshots (
  day TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('collecting', 'ok', 'partial', 'failed')),
  task_count INTEGER NOT NULL DEFAULT 0 CHECK (task_count >= 0),
  skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  pages INTEGER NOT NULL DEFAULT 0 CHECK (pages >= 0),
  error_code TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- Whitelisted metadata of each active task in a day's snapshot, kept 14 days. content_hmac is
-- HMAC-SHA256(key, content "\0" description) with a key that never leaves the Durable Object.
CREATE TABLE gtd_snapshot_tasks (
  day TEXT NOT NULL,
  task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 64),
  project_id TEXT NOT NULL CHECK (length(project_id) <= 64),
  parent_id TEXT CHECK (parent_id IS NULL OR length(parent_id) <= 64),
  labels TEXT NOT NULL DEFAULT '[]' CHECK (length(labels) <= 2048),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 4),
  due_date TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  due_at INTEGER,
  due_recurring INTEGER NOT NULL DEFAULT 0 CHECK (due_recurring IN (0, 1)),
  deadline_date TEXT CHECK (deadline_date IS NULL OR deadline_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  added_at INTEGER,
  checked INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1)),
  content_hmac TEXT NOT NULL CHECK (length(content_hmac) = 64 AND content_hmac NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (day, task_id)
);

-- Daily aggregates per scope (all projects, and the inbox = TODOIST_DEFAULT_PROJECT_ID), kept 120 days.
-- complete = 0 for a partial snapshot. completed_7d is NULL when Todoist's completed list failed
-- (completed_source 'none'); closed_1d (tasks gone since yesterday's ok snapshot: completions plus
-- deletions) is NULL without both snapshots; mail_open is only set for scope 'all'.
CREATE TABLE gtd_daily (
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  scope TEXT NOT NULL CHECK (scope IN ('all', 'inbox')),
  open INTEGER NOT NULL CHECK (open >= 0),
  age_0_7 INTEGER NOT NULL CHECK (age_0_7 >= 0),
  age_8_14 INTEGER NOT NULL CHECK (age_8_14 >= 0),
  age_15_30 INTEGER NOT NULL CHECK (age_15_30 >= 0),
  age_31_plus INTEGER NOT NULL CHECK (age_31_plus >= 0),
  oldest_days INTEGER NOT NULL CHECK (oldest_days >= 0),
  overdue INTEGER NOT NULL CHECK (overdue >= 0),
  undated INTEGER NOT NULL CHECK (undated >= 0),
  created_7d INTEGER CHECK (created_7d IS NULL OR created_7d >= 0),
  completed_7d INTEGER CHECK (completed_7d IS NULL OR completed_7d >= 0),
  completed_source TEXT NOT NULL CHECK (completed_source IN ('api', 'none')),
  closed_1d INTEGER CHECK (closed_1d IS NULL OR closed_1d >= 0),
  mail_open INTEGER CHECK (mail_open IS NULL OR mail_open >= 0),
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (day, scope)
);

-- At most one weekly review task per ISO week, claimed before Todoist is called; title, body and
-- project are frozen with the claim (the daily reminder's rule: 'unknown' is never resent).
CREATE TABLE gtd_reviews (
  week TEXT PRIMARY KEY CHECK (week GLOB '[0-9][0-9][0-9][0-9]-W[0-9][0-9]'),
  state TEXT NOT NULL CHECK (state IN ('sending', 'created', 'unknown', 'failed')),
  project_id TEXT NOT NULL DEFAULT '' CHECK (length(project_id) <= 64),
  task_id TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT NOT NULL DEFAULT '',
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX gtd_reviews_sending ON gtd_reviews (week) WHERE state = 'sending';
