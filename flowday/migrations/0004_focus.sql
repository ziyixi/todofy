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
-- Old incremental tokens do not report unchanged hierarchy/deadline fields. Only the new Worker consumes this.
INSERT INTO settings (key, value)
SELECT 'todoist_hierarchy_refresh', '1'
WHERE EXISTS (SELECT 1 FROM settings WHERE key IN ('todoist_sync_token', 'todoist_sync_pending'))
   OR EXISTS (SELECT 1 FROM tasks WHERE todoist_id IS NOT NULL)
ON CONFLICT(key) DO UPDATE SET value = '1';
