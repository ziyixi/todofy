-- Weekly Task membership is retained after stage changes and later commitments. Classification uses current tasks.
CREATE TABLE gtd_week_commitments (
  week_start TEXT NOT NULL CHECK(length(week_start)=10), task_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(week_start,task_id)
);
CREATE TABLE gtd_reporting (
  id TEXT PRIMARY KEY CHECK(id='report'), started_at INTEGER NOT NULL
);
INSERT INTO gtd_reporting(id,started_at) VALUES('report',unixepoch()*1000);
-- Seed only the memberships still known. The first partial week remains explicitly incomplete in reports.
INSERT INTO gtd_week_commitments(week_start,task_id,created_at)
SELECT committed_week,id,unixepoch()*1000 FROM tasks
WHERE stage='committed' AND committed_week<>'' AND deleted_at IS NULL;
CREATE INDEX completions_report_time ON completions(completed_at,task_id);
CREATE INDEX completions_task_time ON completions(task_id,completed_at);
