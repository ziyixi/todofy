-- Annual goals are independent of task execution. Rows stay available for links and backup rowid ranges.
CREATE TABLE objectives (
  id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 300),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=2000),
  year INTEGER NOT NULL CHECK(year BETWEEN 2000 AND 2199),
  source_url TEXT NOT NULL DEFAULT '' CHECK(length(source_url)<=2000),
  sort_order REAL NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX objectives_year ON objectives(year,sort_order,id) WHERE deleted_at IS NULL;
CREATE TABLE key_results (
  id TEXT PRIMARY KEY, objective_id TEXT NOT NULL REFERENCES objectives(id),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 300),
  floor_text TEXT NOT NULL DEFAULT '' CHECK(length(floor_text)<=2000),
  target_text TEXT NOT NULL DEFAULT '' CHECK(length(target_text)<=2000),
  notes TEXT NOT NULL DEFAULT '' CHECK(length(notes)<=8000),
  kind TEXT NOT NULL DEFAULT 'outcome' CHECK(kind IN ('outcome','routine','exploration')),
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),
  milestones TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(milestones) AND json_array_length(milestones)<=20),
  focus_start_month TEXT NOT NULL DEFAULT '', focus_end_month TEXT NOT NULL DEFAULT '',
  focus_text TEXT NOT NULL DEFAULT '' CHECK(length(focus_text)<=1000),
  source_url TEXT NOT NULL DEFAULT '' CHECK(length(source_url)<=2000),
  sort_order REAL NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  CHECK((focus_start_month='' AND focus_end_month='' AND focus_text='') OR
    (length(focus_start_month)=7 AND length(focus_end_month)=7 AND focus_start_month<=focus_end_month))
);
CREATE INDEX key_results_objective ON key_results(objective_id,sort_order,id) WHERE deleted_at IS NULL;
CREATE TABLE goal_progress (
  id TEXT PRIMARY KEY, key_result_id TEXT NOT NULL REFERENCES key_results(id),
  note TEXT NOT NULL CHECK(length(note) BETWEEN 1 AND 4000),
  evidence_url TEXT NOT NULL DEFAULT '' CHECK(length(evidence_url)<=2000),
  revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX goal_progress_result ON goal_progress(key_result_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;

ALTER TABLE tasks ADD COLUMN key_result_id TEXT NOT NULL DEFAULT '';
CREATE INDEX tasks_key_result ON tasks(key_result_id,sort_order,id) WHERE deleted_at IS NULL AND kind='task';
ALTER TABLE weekly_bets ADD COLUMN key_result_id TEXT NOT NULL DEFAULT '';
