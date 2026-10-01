-- Incremental Todoist sync (docs/design.md "Todoist sync"). Each Todoist task remembers its project, so a renamed
-- or recoloured project updates exactly its own tasks. The column is not indexed: an index would add one D1 row
-- write to every task write that touches it, and the only query by project runs on the rare project change.
-- Additive and nullable, so the container-era code still reads the table (it names its columns).
ALTER TABLE tasks ADD COLUMN todoist_project_id TEXT;
