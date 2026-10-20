-- Tasks owns Focus: day queues, the one timer and time records. Nothing is imported from FlowDay.
-- Rows are never hard-deleted, so the weekly backup's rowid ranges stay stable.
CREATE TABLE day_steps (
  day TEXT NOT NULL CHECK(length(day)=10), task_id TEXT NOT NULL, position REAL NOT NULL,
  done_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  PRIMARY KEY(day, task_id)
);
CREATE INDEX day_steps_task ON day_steps(task_id, day);
CREATE TABLE focus_entries (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, day TEXT NOT NULL CHECK(length(day)=10),
  -- Whole sessions or added minutes: at least one minute, at most a day.
  seconds INTEGER NOT NULL CHECK(seconds BETWEEN 60 AND 86400), started_at INTEGER,
  source TEXT NOT NULL CHECK(source IN ('timer','manual')),
  -- The Work/Personal area shown when the time was logged: a frozen record attribute, like a completion's
  -- title. Todofy keeps every task's current area.
  area TEXT NOT NULL DEFAULT '' CHECK(area IN ('','work','personal')),
  revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX focus_entries_day ON focus_entries(day, deleted_at);
CREATE TABLE focus_timer (
  id TEXT PRIMARY KEY CHECK(id='timer'),
  state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','running','paused')),
  task_id TEXT NOT NULL DEFAULT '', day TEXT NOT NULL DEFAULT '',
  area TEXT NOT NULL DEFAULT '' CHECK(area IN ('','work','personal')),
  target_seconds INTEGER CHECK(target_seconds IS NULL OR target_seconds BETWEEN 60 AND 14400),
  started_at INTEGER, segment_start INTEGER, saved_seconds INTEGER NOT NULL DEFAULT 0,
  finished_task_id TEXT NOT NULL DEFAULT '', finished_seconds INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);
INSERT INTO focus_timer(id) VALUES('timer');
