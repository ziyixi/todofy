-- Todoist hierarchy and a deliberate FlowDay estimate survive incremental sync.
ALTER TABLE tasks ADD COLUMN parent_id TEXT;
ALTER TABLE tasks ADD COLUMN deadline_date TEXT;
ALTER TABLE tasks ADD COLUMN estimate_override INTEGER NOT NULL DEFAULT 0;
-- Preserve existing manually entered estimates; ownership cannot be inferred retrospectively.
UPDATE tasks SET estimate_override = 1 WHERE estimated_mins IS NOT NULL;
ALTER TABLE active_timer_session ADD COLUMN etag TEXT NOT NULL DEFAULT '0';
CREATE TABLE timer_commands (
  request_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
