-- Fewer index entries to write (docs/design.md "Write budget"). D1 counts every index entry a write touches as one
-- more row written, so an index no query reads only costs writes:
-- - tasks.due_date: no query filters or sorts by it (the UI groups tasks by due day in the browser);
-- - tasks.todoist_id: a Todoist task's id is its Todoist id, so the primary key already finds it;
-- - flow_tasks.flow_date and completed_flow_tasks.flow_date: both repeat the leading column of the table's
--   UNIQUE(flow_date, task_id) index, which serves the same lookups and ranges.
-- Dropping an index changes no data, and the container-era code creates its own indexes in its own SQLite file.
DROP INDEX idx_tasks_due_date;
DROP INDEX idx_tasks_todoist_id;
DROP INDEX idx_flow_tasks_flow_date;
DROP INDEX idx_completed_flow_tasks_flow_date;
