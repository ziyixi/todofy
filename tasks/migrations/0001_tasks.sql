-- Tasks owns task content. Imported Todoist IDs stay unchanged, preserving external references.
PRAGMA foreign_keys = ON;
CREATE TABLE projects (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, parent_id TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, inbox INTEGER NOT NULL DEFAULT 0, sort_order REAL NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX projects_parent ON projects(parent_id, deleted_at, sort_order, id);
CREATE TABLE sections (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, sort_order REAL NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX sections_project ON sections(project_id, deleted_at, sort_order, id);
CREATE TABLE labels (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, color TEXT NOT NULL DEFAULT '', favorite INTEGER NOT NULL DEFAULT 0, sort_order REAL NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE UNIQUE INDEX labels_title_live ON labels(title COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE TABLE filters (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, query TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, sort_order REAL NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '',
  section_id TEXT NOT NULL DEFAULT '', parent_id TEXT NOT NULL DEFAULT '', label_ids TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 4 CHECK(priority BETWEEN 1 AND 4), sort_order REAL NOT NULL DEFAULT 0,
  due_date TEXT NOT NULL DEFAULT '', due_datetime TEXT NOT NULL DEFAULT '', due_timezone TEXT NOT NULL DEFAULT '',
  deadline TEXT NOT NULL DEFAULT '', duration_minutes INTEGER NOT NULL DEFAULT 0, recurrence TEXT NOT NULL DEFAULT '',
  completed INTEGER NOT NULL DEFAULT 0, completed_at INTEGER, project_archived INTEGER NOT NULL DEFAULT 0, completed_base_count INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX tasks_live_order ON tasks(deleted_at, completed, sort_order, id);
CREATE INDEX tasks_project ON tasks(project_id, parent_id, deleted_at, completed, sort_order, id);
CREATE INDEX tasks_parent ON tasks(parent_id, deleted_at, sort_order, id);
CREATE INDEX tasks_date ON tasks(deleted_at, completed, due_date, sort_order, id);
CREATE INDEX tasks_deadline ON tasks(deleted_at, completed, deadline, id);
CREATE TABLE task_labels (task_id TEXT NOT NULL, label_id TEXT NOT NULL, PRIMARY KEY(task_id, label_id));
CREATE INDEX task_labels_label ON task_labels(label_id, task_id);
CREATE TABLE completions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, title TEXT NOT NULL,
  completed_at INTEGER NOT NULL, due_date TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL DEFAULT '', task_created_at INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0 CHECK(imported IN (0,1))
);
CREATE INDEX completions_task ON completions(task_id, sequence DESC);
CREATE TABLE changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, resource TEXT NOT NULL, resource_id TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, changed_at INTEGER NOT NULL
);
CREATE TABLE requests (
  id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL,
  revision_guard INTEGER NOT NULL CHECK(revision_guard = 1)
);

CREATE TRIGGER tasks_insert AFTER INSERT ON tasks BEGIN
  INSERT INTO changes(resource,resource_id,deleted,changed_at) VALUES('tasks',NEW.id,NEW.deleted_at IS NOT NULL,NEW.updated_at);
END;

CREATE TRIGGER tasks_update AFTER UPDATE ON tasks BEGIN
  INSERT INTO changes(resource,resource_id,deleted,changed_at) VALUES('tasks',NEW.id,NEW.deleted_at IS NOT NULL,NEW.updated_at);
END;

CREATE TRIGGER projects_insert AFTER INSERT ON projects BEGIN
  INSERT INTO changes(resource,resource_id,deleted,changed_at) VALUES('projects',NEW.id,NEW.deleted_at IS NOT NULL,NEW.updated_at);
END;

CREATE TRIGGER projects_update AFTER UPDATE ON projects BEGIN
  INSERT INTO changes(resource,resource_id,deleted,changed_at) VALUES('projects',NEW.id,NEW.deleted_at IS NOT NULL,NEW.updated_at);
END;

CREATE TRIGGER sections_insert AFTER INSERT ON sections BEGIN
  INSERT INTO changes(resource,resource_id,deleted,changed_at) VALUES('sections',NEW.id,NEW.deleted_at IS NOT NULL,NEW.updated_at);
END;

CREATE TRIGGER sections_update AFTER UPDATE ON sections BEGIN
  INSERT INTO changes(resource,resource_id,deleted,changed_at) VALUES('sections',NEW.id,NEW.deleted_at IS NOT NULL,NEW.updated_at);
END;

CREATE TRIGGER labels_insert AFTER INSERT ON labels BEGIN
  INSERT INTO changes(resource,resource_id,deleted,changed_at) VALUES('labels',NEW.id,NEW.deleted_at IS NOT NULL,NEW.updated_at);
END;

CREATE TRIGGER labels_update AFTER UPDATE ON labels BEGIN
  INSERT INTO changes(resource,resource_id,deleted,changed_at) VALUES('labels',NEW.id,NEW.deleted_at IS NOT NULL,NEW.updated_at);
END;

CREATE TRIGGER filters_insert AFTER INSERT ON filters BEGIN
  INSERT INTO changes(resource,resource_id,deleted,changed_at) VALUES('filters',NEW.id,NEW.deleted_at IS NOT NULL,NEW.updated_at);
END;

CREATE TRIGGER filters_update AFTER UPDATE ON filters BEGIN
  INSERT INTO changes(resource,resource_id,deleted,changed_at) VALUES('filters',NEW.id,NEW.deleted_at IS NOT NULL,NEW.updated_at);
END;

CREATE TRIGGER task_labels_insert AFTER INSERT ON tasks BEGIN
  INSERT INTO task_labels(task_id,label_id) SELECT NEW.id,value FROM json_each(NEW.label_ids);
END;
CREATE TRIGGER task_labels_update AFTER UPDATE OF label_ids ON tasks BEGIN
  DELETE FROM task_labels WHERE task_id=NEW.id;
  INSERT INTO task_labels(task_id,label_id) SELECT NEW.id,value FROM json_each(NEW.label_ids);
END;

CREATE TRIGGER project_visibility AFTER UPDATE OF archived,parent_id ON projects BEGIN
  UPDATE tasks SET project_archived=(EXISTS(SELECT 1 FROM sections s WHERE s.id=tasks.section_id AND s.archived=1 AND s.deleted_at IS NULL) OR (WITH RECURSIVE ancestors(id,parent_id,archived) AS (SELECT id,parent_id,archived FROM projects WHERE id=tasks.project_id UNION ALL SELECT p.id,p.parent_id,p.archived FROM projects p JOIN ancestors a ON p.id=a.parent_id) SELECT EXISTS(SELECT 1 FROM ancestors WHERE archived=1))),revision=revision+1,updated_at=NEW.updated_at
  WHERE deleted_at IS NULL AND project_id IN (WITH RECURSIVE descendants(id) AS (SELECT NEW.id UNION ALL SELECT p.id FROM projects p JOIN descendants d ON p.parent_id=d.id) SELECT id FROM descendants)
  AND project_archived<>(EXISTS(SELECT 1 FROM sections s WHERE s.id=tasks.section_id AND s.archived=1 AND s.deleted_at IS NULL) OR (WITH RECURSIVE ancestors(id,parent_id,archived) AS (SELECT id,parent_id,archived FROM projects WHERE id=tasks.project_id UNION ALL SELECT p.id,p.parent_id,p.archived FROM projects p JOIN ancestors a ON p.id=a.parent_id) SELECT EXISTS(SELECT 1 FROM ancestors WHERE archived=1)));
END;
CREATE TRIGGER label_name_changed AFTER UPDATE OF title ON labels WHEN OLD.title<>NEW.title BEGIN
  INSERT INTO changes(resource,resource_id,deleted,changed_at) SELECT 'tasks',task_id,0,NEW.updated_at FROM task_labels WHERE label_id=NEW.id;
END;

CREATE TRIGGER task_references_insert BEFORE INSERT ON tasks WHEN NEW.deleted_at IS NULL BEGIN
  SELECT CASE WHEN NEW.project_id<>'' AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND deleted_at IS NULL) THEN RAISE(ABORT,'task_reference_invalid') END;
  SELECT CASE WHEN NEW.section_id<>'' AND NOT EXISTS(SELECT 1 FROM sections WHERE id=NEW.section_id AND project_id=NEW.project_id AND deleted_at IS NULL) THEN RAISE(ABORT,'task_reference_invalid') END;
  SELECT CASE WHEN NEW.parent_id<>'' AND NOT EXISTS(SELECT 1 FROM tasks WHERE id=NEW.parent_id AND project_id=NEW.project_id AND deleted_at IS NULL) THEN RAISE(ABORT,'task_reference_invalid') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.label_ids) j WHERE NOT EXISTS(SELECT 1 FROM labels l WHERE l.id=j.value AND l.deleted_at IS NULL)) THEN RAISE(ABORT,'task_reference_invalid') END;
  SELECT CASE WHEN EXISTS(WITH RECURSIVE ancestors(id,parent_id) AS (SELECT id,parent_id FROM tasks WHERE id=NEW.parent_id UNION SELECT t.id,t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.parent_id) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE(ABORT,'task_hierarchy_invalid') END;
END;
CREATE TRIGGER project_references_insert BEFORE INSERT ON projects WHEN NEW.deleted_at IS NULL BEGIN
  SELECT CASE WHEN NEW.parent_id<>'' AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.parent_id AND deleted_at IS NULL) THEN RAISE(ABORT,'task_reference_invalid') END;
  SELECT CASE WHEN EXISTS(WITH RECURSIVE ancestors(id,parent_id) AS (SELECT id,parent_id FROM projects WHERE id=NEW.parent_id UNION SELECT p.id,p.parent_id FROM projects p JOIN ancestors a ON p.id=a.parent_id) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE(ABORT,'task_hierarchy_invalid') END;
END;

CREATE TRIGGER task_references_update BEFORE UPDATE ON tasks WHEN NEW.deleted_at IS NULL BEGIN
  SELECT CASE WHEN NEW.project_id<>'' AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND deleted_at IS NULL) THEN RAISE(ABORT,'task_reference_invalid') END;
  SELECT CASE WHEN NEW.section_id<>'' AND NOT EXISTS(SELECT 1 FROM sections WHERE id=NEW.section_id AND project_id=NEW.project_id AND deleted_at IS NULL) THEN RAISE(ABORT,'task_reference_invalid') END;
  SELECT CASE WHEN NEW.parent_id<>'' AND NOT EXISTS(SELECT 1 FROM tasks WHERE id=NEW.parent_id AND project_id=NEW.project_id AND deleted_at IS NULL) THEN RAISE(ABORT,'task_reference_invalid') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.label_ids) j WHERE NOT EXISTS(SELECT 1 FROM labels l WHERE l.id=j.value AND l.deleted_at IS NULL)) THEN RAISE(ABORT,'task_reference_invalid') END;
  SELECT CASE WHEN EXISTS(WITH RECURSIVE ancestors(id,parent_id) AS (SELECT id,parent_id FROM tasks WHERE id=NEW.parent_id UNION SELECT t.id,t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.parent_id) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE(ABORT,'task_hierarchy_invalid') END;
END;
CREATE TRIGGER project_references_update BEFORE UPDATE ON projects WHEN NEW.deleted_at IS NULL BEGIN
  SELECT CASE WHEN NEW.parent_id<>'' AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.parent_id AND deleted_at IS NULL) THEN RAISE(ABORT,'task_reference_invalid') END;
  SELECT CASE WHEN EXISTS(WITH RECURSIVE ancestors(id,parent_id) AS (SELECT id,parent_id FROM projects WHERE id=NEW.parent_id UNION SELECT p.id,p.parent_id FROM projects p JOIN ancestors a ON p.id=a.parent_id) SELECT 1 FROM ancestors WHERE id=NEW.id) THEN RAISE(ABORT,'task_hierarchy_invalid') END;
END;

CREATE TRIGGER section_delete_guard BEFORE UPDATE OF deleted_at ON sections WHEN NEW.deleted_at IS NOT NULL BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM tasks WHERE section_id=NEW.id AND deleted_at IS NULL) THEN RAISE(ABORT,'resource_in_use') END;
END;
CREATE TRIGGER label_delete_guard BEFORE UPDATE OF deleted_at ON labels WHEN NEW.deleted_at IS NOT NULL BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM task_labels tl JOIN tasks t ON t.id=tl.task_id WHERE tl.label_id=NEW.id AND t.deleted_at IS NULL) THEN RAISE(ABORT,'resource_in_use') END;
END;

CREATE UNIQUE INDEX one_live_inbox ON projects(inbox) WHERE inbox=1 AND deleted_at IS NULL;

CREATE TRIGGER section_visibility AFTER UPDATE OF archived ON sections BEGIN
  UPDATE tasks SET project_archived=(EXISTS(SELECT 1 FROM sections s WHERE s.id=tasks.section_id AND s.archived=1 AND s.deleted_at IS NULL) OR (WITH RECURSIVE ancestors(id,parent_id,archived) AS (SELECT id,parent_id,archived FROM projects WHERE id=tasks.project_id UNION ALL SELECT p.id,p.parent_id,p.archived FROM projects p JOIN ancestors a ON p.id=a.parent_id) SELECT EXISTS(SELECT 1 FROM ancestors WHERE archived=1))),revision=revision+1,updated_at=NEW.updated_at
  WHERE section_id=NEW.id AND deleted_at IS NULL;
END;

CREATE TRIGGER task_visibility_insert AFTER INSERT ON tasks BEGIN
  UPDATE tasks SET project_archived=(EXISTS(SELECT 1 FROM sections s WHERE s.id=tasks.section_id AND s.archived=1 AND s.deleted_at IS NULL) OR (WITH RECURSIVE ancestors(id,parent_id,archived) AS (SELECT id,parent_id,archived FROM projects WHERE id=tasks.project_id UNION ALL SELECT p.id,p.parent_id,p.archived FROM projects p JOIN ancestors a ON p.id=a.parent_id) SELECT EXISTS(SELECT 1 FROM ancestors WHERE archived=1))) WHERE id=NEW.id AND project_archived<>(EXISTS(SELECT 1 FROM sections s WHERE s.id=tasks.section_id AND s.archived=1 AND s.deleted_at IS NULL) OR (WITH RECURSIVE ancestors(id,parent_id,archived) AS (SELECT id,parent_id,archived FROM projects WHERE id=tasks.project_id UNION ALL SELECT p.id,p.parent_id,p.archived FROM projects p JOIN ancestors a ON p.id=a.parent_id) SELECT EXISTS(SELECT 1 FROM ancestors WHERE archived=1)));
END;

CREATE TRIGGER task_visibility_move AFTER UPDATE OF project_id,section_id ON tasks BEGIN
  UPDATE tasks SET project_archived=(EXISTS(SELECT 1 FROM sections s WHERE s.id=tasks.section_id AND s.archived=1 AND s.deleted_at IS NULL) OR (WITH RECURSIVE ancestors(id,parent_id,archived) AS (SELECT id,parent_id,archived FROM projects WHERE id=tasks.project_id UNION ALL SELECT p.id,p.parent_id,p.archived FROM projects p JOIN ancestors a ON p.id=a.parent_id) SELECT EXISTS(SELECT 1 FROM ancestors WHERE archived=1))) WHERE id=NEW.id AND project_archived<>(EXISTS(SELECT 1 FROM sections s WHERE s.id=tasks.section_id AND s.archived=1 AND s.deleted_at IS NULL) OR (WITH RECURSIVE ancestors(id,parent_id,archived) AS (SELECT id,parent_id,archived FROM projects WHERE id=tasks.project_id UNION ALL SELECT p.id,p.parent_id,p.archived FROM projects p JOIN ancestors a ON p.id=a.parent_id) SELECT EXISTS(SELECT 1 FROM ancestors WHERE archived=1)));
END;
