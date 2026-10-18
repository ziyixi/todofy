-- Imported tasks stay tasks, including existing dates and estimates.
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'
  CHECK(kind IN ('task','step')) CHECK(kind<>'step' OR parent_id<>'');
ALTER TABLE tasks ADD COLUMN effort TEXT NOT NULL DEFAULT '' CHECK(effort IN ('','deep','shallow'));
