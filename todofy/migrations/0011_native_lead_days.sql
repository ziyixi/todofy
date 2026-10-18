-- Preserve planning identity and revisions while accepting a calendar-day start window.
CREATE TABLE plan_task_state_custom_lead (
  task_id INTEGER PRIMARY KEY,
  stage TEXT NOT NULL DEFAULT 'none' CHECK (stage IN ('none', 'quarterly', 'monthly', 'weekly', 'committed')),
  area TEXT NOT NULL DEFAULT 'unassigned' CHECK (area IN ('unassigned', 'work', 'personal')),
  lead_days INTEGER NOT NULL DEFAULT 0 CHECK (lead_days BETWEEN 0 AND 365),
  quick INTEGER NOT NULL DEFAULT 0 CHECK (quick IN (0,1)),
  waiting INTEGER NOT NULL DEFAULT 0 CHECK (waiting IN (0,1)),
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0,1)),
  parked INTEGER NOT NULL DEFAULT 0 CHECK (parked IN (0,1)),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  onhold INTEGER NOT NULL DEFAULT 0 CHECK (onhold IN (0,1)),
  routine INTEGER NOT NULL DEFAULT 0 CHECK (routine IN (0,1)),
  task INTEGER NOT NULL DEFAULT 0 CHECK (task IN (0,1)),
  rev INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 100),
  updated_at INTEGER NOT NULL
);

INSERT INTO plan_task_state_custom_lead SELECT * FROM plan_task_state;
DROP TABLE plan_task_state;
ALTER TABLE plan_task_state_custom_lead RENAME TO plan_task_state;
