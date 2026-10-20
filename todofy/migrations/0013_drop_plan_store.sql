-- Tasks keeps planning since tasks/migrations/0006_planning.sql, and the one-time import of 2026-10-20 copied this
-- store into it (0 left pending). Only the Mail categories stay: plan_categories and plan_settings 'todoist.mail'.
-- No table here has a foreign key or a trigger, and each table's indexes drop with it.
DROP TABLE plan_task_state;
DROP TABLE plan_edges;
DROP TABLE plan_marks;
DROP TABLE plan_notes;
DROP TABLE plan_tasks;
DROP TABLE plus_weeks;
DROP TABLE plus_settings;
DELETE FROM plan_settings WHERE key <> 'todoist.mail';
