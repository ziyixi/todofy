-- Todoist remains the task store. These rows contain setup, action identities and week membership.
CREATE TABLE plus_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mapping TEXT NOT NULL,
  timezone TEXT NOT NULL,
  week_start TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE plus_connections (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE plus_actions (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  commands TEXT NOT NULL,
  response TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE plus_weeks (
  task_id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  committed INTEGER NOT NULL,
  bet INTEGER NOT NULL
);
CREATE INDEX plus_weeks_ended ON plus_weeks(week_start, task_id);
