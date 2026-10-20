-- Planning facts are task properties, like kind and effort (0003). Todofy no longer keeps them.
-- Rows are never hard-deleted, so the weekly backup's rowid ranges stay stable.
ALTER TABLE tasks ADD COLUMN stage TEXT NOT NULL DEFAULT 'none'
  CHECK(stage IN ('none','quarterly','monthly','weekly','committed'));
-- The Monday a commitment is for. A commitment for an ended week reads as weekly: the rollover is a read rule.
ALTER TABLE tasks ADD COLUMN committed_week TEXT NOT NULL DEFAULT '' CHECK(committed_week='' OR length(committed_week)=10);
ALTER TABLE tasks ADD COLUMN area TEXT NOT NULL DEFAULT 'unassigned' CHECK(area IN ('unassigned','work','personal'));
ALTER TABLE tasks ADD COLUMN lead_days INTEGER NOT NULL DEFAULT 0 CHECK(lead_days BETWEEN 0 AND 365);
-- JSON array like label_ids: task (standalone action), quick, active, waiting, onhold, routine, parked.
ALTER TABLE tasks ADD COLUMN planning_flags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(planning_flags));
CREATE INDEX tasks_committed ON tasks(committed_week) WHERE stage='committed' AND deleted_at IS NULL;
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL, prerequisite_id TEXT NOT NULL CHECK(prerequisite_id<>task_id),
  -- The prerequisite's completed_count when linked: a recurring prerequisite is done after its next completion.
  baseline_count INTEGER NOT NULL DEFAULT 0 CHECK(baseline_count>=0),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  PRIMARY KEY(task_id, prerequisite_id)
);
CREATE INDEX task_dependencies_prerequisite ON task_dependencies(prerequisite_id) WHERE deleted_at IS NULL;
CREATE TABLE weekly_bets (
  week_start TEXT NOT NULL CHECK(length(week_start)=10), area TEXT NOT NULL CHECK(area IN ('work','personal')),
  text TEXT NOT NULL CHECK(length(text)<=160), revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(week_start, area)
);
-- The Review lanes the owner arranged: one document, as Todofy's 'board' setting was, because a task is in one lane.
-- created_at stays 0 until the one-time planning import (tools/planning-import.ts) records when it ran.
CREATE TABLE plan_board (
  id TEXT PRIMARY KEY CHECK(id='board'), lanes TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(lanes)),
  revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO plan_board(id) VALUES('board');
