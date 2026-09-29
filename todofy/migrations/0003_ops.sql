-- ops-v1 (contracts/ops-v1). Additive: the previous release keeps running between this
-- migration and the deploy, and after a code rollback (it never reads or writes these columns).
-- Set only for mail.received.v1 events that carry "canary" (the dashboard's end-to-end check);
-- such rows never reach Todoist, the reports, the attention list or the reminder.
ALTER TABLE mail_events ADD COLUMN canary_run_id TEXT
  CHECK (canary_run_id IS NULL OR length(canary_run_id) BETWEEN 1 AND 64);
-- Ops items listed in that day's reminder (the frozen body names them); attention_count keeps
-- counting mail only.
ALTER TABLE mail_reminders ADD COLUMN ops_count INTEGER NOT NULL DEFAULT 0 CHECK (ops_count >= 0);
