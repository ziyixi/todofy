-- Todofy writes no task any more (2026-10-21): Tasks converts mail itself through the Mail entry, Home and Watch
-- create their own tasks, and Tasks keeps GTD. The guard comes first, so a row the removed code would still have
-- had to finish stops this migration, and with it the deploy, before any table is dropped: its CHECK refuses a
-- count above 0. It does not depend on the file running as one transaction (IF NOT EXISTS lets a rerun start over).
CREATE TABLE IF NOT EXISTS _release_guard (n INTEGER NOT NULL CHECK (n = 0));
-- A summarised mail whose task was still to be created, in flight, unknown or not yet recorded.
INSERT INTO _release_guard SELECT count(*) FROM mail_events
  WHERE state IN ('summarized', 'todo_sending', 'todo_unknown', 'todo_created');
-- A task intent still being created, or one of its tasks.
INSERT INTO _release_guard SELECT count(*) FROM task_intents WHERE state = 'pending';
INSERT INTO _release_guard SELECT count(*) FROM task_intent_tasks WHERE state NOT IN ('created', 'failed');
DROP TABLE _release_guard;
-- Watch's proposals now go to Tasks' TaskInbox.
DROP TABLE task_intent_tasks;
DROP TABLE task_intents;
-- The daily task snapshot: 14-day metadata whose one reader, the brief's carryover, now reads pending mail. Not
-- copied. gtd_daily and gtd_reviews stay until Tasks' one-time import has copied them.
DROP TABLE gtd_snapshot_tasks;
DROP TABLE gtd_snapshots;
-- Unused: retention never deletes a summary, and the Mail entry reads by event ID and summaries_pending.
DROP INDEX summaries_expiring;
DROP INDEX summaries_task;
