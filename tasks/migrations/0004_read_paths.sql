-- Open root lists (Inbox) and native completion counts stop scanning completed history.
CREATE INDEX tasks_open_roots ON tasks(parent_id, completed, deleted_at, sort_order, id);
CREATE INDEX completions_task_native ON completions(task_id) WHERE imported=0;

-- Renaming or recolouring a section or project no longer bumps, or scans, its tasks. The bodies are unchanged.
DROP TRIGGER section_visibility;
CREATE TRIGGER section_visibility AFTER UPDATE OF archived ON sections WHEN OLD.archived<>NEW.archived BEGIN
  UPDATE tasks SET project_archived=(EXISTS(SELECT 1 FROM sections s WHERE s.id=tasks.section_id AND s.archived=1 AND s.deleted_at IS NULL) OR (WITH RECURSIVE ancestors(id,parent_id,archived) AS (SELECT id,parent_id,archived FROM projects WHERE id=tasks.project_id UNION ALL SELECT p.id,p.parent_id,p.archived FROM projects p JOIN ancestors a ON p.id=a.parent_id) SELECT EXISTS(SELECT 1 FROM ancestors WHERE archived=1))),revision=revision+1,updated_at=NEW.updated_at
  WHERE section_id=NEW.id AND deleted_at IS NULL;
END;
DROP TRIGGER project_visibility;
CREATE TRIGGER project_visibility AFTER UPDATE OF archived,parent_id ON projects
  WHEN OLD.archived<>NEW.archived OR OLD.parent_id<>NEW.parent_id BEGIN
  UPDATE tasks SET project_archived=(EXISTS(SELECT 1 FROM sections s WHERE s.id=tasks.section_id AND s.archived=1 AND s.deleted_at IS NULL) OR (WITH RECURSIVE ancestors(id,parent_id,archived) AS (SELECT id,parent_id,archived FROM projects WHERE id=tasks.project_id UNION ALL SELECT p.id,p.parent_id,p.archived FROM projects p JOIN ancestors a ON p.id=a.parent_id) SELECT EXISTS(SELECT 1 FROM ancestors WHERE archived=1))),revision=revision+1,updated_at=NEW.updated_at
  WHERE deleted_at IS NULL AND project_id IN (WITH RECURSIVE descendants(id) AS (SELECT NEW.id UNION ALL SELECT p.id FROM projects p JOIN descendants d ON p.parent_id=d.id) SELECT id FROM descendants)
  AND project_archived<>(EXISTS(SELECT 1 FROM sections s WHERE s.id=tasks.section_id AND s.archived=1 AND s.deleted_at IS NULL) OR (WITH RECURSIVE ancestors(id,parent_id,archived) AS (SELECT id,parent_id,archived FROM projects WHERE id=tasks.project_id UNION ALL SELECT p.id,p.parent_id,p.archived FROM projects p JOIN ancestors a ON p.id=a.parent_id) SELECT EXISTS(SELECT 1 FROM ancestors WHERE archived=1)));
END;

-- A label rename announces the catalog change before its tasks, so a paged change reader refreshes it first.
DROP TRIGGER label_name_changed;
CREATE TRIGGER label_name_changed AFTER UPDATE OF title ON labels WHEN OLD.title<>NEW.title BEGIN
  INSERT INTO changes(resource,resource_id,deleted,changed_at) VALUES('labels',NEW.id,0,NEW.updated_at);
  INSERT INTO changes(resource,resource_id,deleted,changed_at) SELECT 'tasks',task_id,0,NEW.updated_at FROM task_labels WHERE label_id=NEW.id;
END;
