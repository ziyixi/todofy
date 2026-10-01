-- FlowDay's schema as the container-era SQLite file has it (web/lib/db/index.ts at ziyixi/FlowDay 10a8f43:
-- CREATE TABLE IF NOT EXISTS, then ALTER TABLE ADD COLUMN), so its rows can be imported unchanged (docs/design.md
-- "Data migration"). Column order matters: tasks.description, deleted_at and deleted_source were added by ALTER
-- TABLE on the live file and therefore come last. worker/test/runtime/schema.test.ts pins every table's columns,
-- in order, and every index. No foreign keys, no triggers.

CREATE TABLE time_entries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  flow_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT,
  duration_s INTEGER,
  source TEXT NOT NULL DEFAULT 'timer',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  todoist_id TEXT,
  title TEXT NOT NULL,
  project_name TEXT,
  project_color TEXT,
  priority INTEGER NOT NULL DEFAULT 1,
  labels TEXT DEFAULT '[]',
  estimated_mins INTEGER,
  is_completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  due_date TEXT,
  created_at TEXT,
  synced_at TEXT,
  description TEXT,
  deleted_at TEXT,
  deleted_source TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE flow_tasks (
  id TEXT PRIMARY KEY,
  flow_date TEXT NOT NULL,
  task_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  UNIQUE(flow_date, task_id)
);

CREATE TABLE completed_flow_tasks (
  id TEXT PRIMARY KEY,
  flow_date TEXT NOT NULL,
  task_id TEXT NOT NULL,
  UNIQUE(flow_date, task_id)
);

CREATE TABLE flow_task_notes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  flow_date TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(task_id, flow_date)
);

CREATE TABLE active_timer_session (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  flow_date TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  timer_mode TEXT NOT NULL DEFAULT 'countup',
  pomodoro_target_s INTEGER,
  segment_wall_start TEXT,
  session_saved_s INTEGER NOT NULL DEFAULT 0,
  pomodoro_finished_task_id TEXT,
  pomodoro_finished_flow_date TEXT,
  pomodoro_finished_target_s INTEGER,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_time_entries_task_id ON time_entries(task_id);
CREATE INDEX idx_time_entries_flow_date ON time_entries(flow_date);
CREATE INDEX idx_flow_tasks_flow_date ON flow_tasks(flow_date);
CREATE INDEX idx_flow_tasks_task_id ON flow_tasks(task_id);
CREATE INDEX idx_completed_flow_tasks_flow_date ON completed_flow_tasks(flow_date);
CREATE INDEX idx_completed_flow_tasks_task_id ON completed_flow_tasks(task_id);
CREATE INDEX idx_flow_task_notes_flow_date ON flow_task_notes(flow_date);
CREATE INDEX idx_tasks_due_date ON tasks(due_date);
CREATE INDEX idx_tasks_deleted_at ON tasks(deleted_at);
CREATE INDEX idx_tasks_todoist_id ON tasks(todoist_id);
