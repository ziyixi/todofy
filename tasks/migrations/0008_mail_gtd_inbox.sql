-- Mail conversion, GTD statistics, the weekly review and the TaskInbox entry, which Tasks keeps since Todofy stopped
-- writing tasks. Rows are never hard-deleted, so the weekly backup's rowid ranges stay stable.
-- The Mail category shortcuts: one document of at most 4 {id, label_id, priority}; an ID is never reused.
-- created_at stays 0 until the first save or the one-time Todofy import (tools/todofy-import.ts), which copies once.
CREATE TABLE mail_settings (
  id TEXT PRIMARY KEY CHECK(id='mail'), categories TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(categories)),
  next_category_id INTEGER NOT NULL DEFAULT 1 CHECK(next_category_id>=1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO mail_settings(id) VALUES('mail');
-- One row of counts per account day and scope, written after 06:00 local time (worker/src/gtd.ts); copied days keep
-- Todofy's values. complete=0 only for a copied day whose snapshot stopped at its page cap. Times are milliseconds.
CREATE TABLE gtd_days (
  day TEXT NOT NULL CHECK(length(day)=10), scope TEXT NOT NULL CHECK(scope IN ('all','inbox')),
  open INTEGER NOT NULL, age_0_7 INTEGER NOT NULL, age_8_14 INTEGER NOT NULL, age_15_30 INTEGER NOT NULL,
  age_31_plus INTEGER NOT NULL, oldest_days INTEGER NOT NULL, overdue INTEGER NOT NULL, undated INTEGER NOT NULL,
  created_7d INTEGER, completed_7d INTEGER, closed_1d INTEGER, mail_open INTEGER,
  complete INTEGER NOT NULL DEFAULT 1 CHECK(complete IN (0,1)), computed_at INTEGER NOT NULL,
  PRIMARY KEY(day, scope)
);
-- One review per ISO week (2026-W43). Tasks writes the row and its task in one batch, so its rows are 'created';
-- copied rows keep Todofy's state and completion time. A Tasks review's completion is its task's.
CREATE TABLE weekly_reviews (
  week TEXT PRIMARY KEY CHECK(length(week)=8 AND substr(week,5,2)='-W'),
  state TEXT NOT NULL CHECK(state IN ('created','unknown','failed')), task_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, completed_at INTEGER
);
-- The project TaskInbox (home) and the weekly review put their tasks in; without a row, or once the project is
-- deleted or archived, the Inbox. Watch's tasks always go to the Inbox.
CREATE TABLE task_inbox_routes (
  source TEXT PRIMARY KEY CHECK(source IN ('home','review')), project_id TEXT NOT NULL, updated_at INTEGER NOT NULL
);
-- TaskInbox's tasks per source and UTC day. The named CHECK aborts the 21st create's whole batch.
CREATE TABLE task_inbox_days (
  source TEXT NOT NULL CHECK(source IN ('home','watch')), day TEXT NOT NULL CHECK(length(day)=10),
  requests INTEGER NOT NULL CONSTRAINT task_inbox_daily_limit CHECK(requests BETWEEN 1 AND 20),
  PRIMARY KEY(source, day)
);
