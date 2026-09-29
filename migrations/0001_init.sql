-- Todofy ledger (docs/cloudflare-migration-plan.md §5.2, docs/implementation-order.md S3).
-- Times are Unix seconds (UTC). State columns carry CHECKs that mirror
-- worker/todofy/core/vocab.py; error-code columns stay free text because SQLite
-- can only change a CHECK by rebuilding the table. Every hot query is listed,
-- with the index it must use, in tests/unit/test_schema_sql.py.

-- One row per Mail Hero event, kept forever as the webhook dedupe ledger.
CREATE TABLE mail_events (
  source_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  payload TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'summarizing', 'summarized', 'todo_sending',
    'todo_unknown', 'todo_created', 'complete', 'ignored', 'failed_summary')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  summary TEXT NOT NULL DEFAULT '',
  summary_model TEXT NOT NULL DEFAULT '',
  todo_body TEXT NOT NULL DEFAULT '',
  todoist_request_id TEXT NOT NULL DEFAULT '',
  task_id TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  crashes INTEGER NOT NULL DEFAULT 0 CHECK (crashes >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT NOT NULL DEFAULT '',
  imported INTEGER NOT NULL DEFAULT 0 CHECK (imported IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, event_id),
  -- Mail content must not outlive the work that needs it.
  CHECK (payload IS NULL OR state NOT IN ('complete', 'ignored'))
);
CREATE INDEX mail_events_due ON mail_events (state, next_attempt_at, created_at);
CREATE INDEX mail_events_recent ON mail_events (source_id, created_at, event_id);
CREATE INDEX mail_events_by_state ON mail_events (source_id, state, created_at, event_id);
-- Active means not terminal. Queries spell it as this exact IN list: SQLite
-- only uses a partial index whose WHERE text the query repeats, and with a
-- NOT IN it may pick mail_events_by_state and walk every terminal row.
CREATE INDEX mail_events_active ON mail_events (source_id, created_at, event_id)
  WHERE state IN ('pending', 'summarizing', 'summarized', 'todo_sending',
    'todo_unknown', 'todo_created', 'failed_summary');

CREATE TABLE event_transitions (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  -- NULL for the transition that records the event's arrival.
  from_state TEXT CHECK (from_state IN ('pending', 'summarizing', 'summarized', 'todo_sending',
    'todo_unknown', 'todo_created', 'complete', 'ignored', 'failed_summary')),
  to_state TEXT NOT NULL CHECK (to_state IN ('pending', 'summarizing', 'summarized', 'todo_sending',
    'todo_unknown', 'todo_created', 'complete', 'ignored', 'failed_summary')),
  error_code TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL CHECK (actor IN ('worker', 'owner'))
);
CREATE INDEX event_transitions_event ON event_transitions (event_id, at);

-- At most one owner reminder task per UTC day, claimed before Todoist is called.
CREATE TABLE mail_reminders (
  day TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  state TEXT NOT NULL CHECK (state IN ('sending', 'created', 'unknown', 'failed')),
  task_id TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  attention_count INTEGER NOT NULL CHECK (attention_count >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT NOT NULL DEFAULT '',
  imported INTEGER NOT NULL DEFAULT 0 CHECK (imported IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX mail_reminders_sending ON mail_reminders (day) WHERE state = 'sending';

-- Daily-report input. Imported rows use event_id 'legacy:<hash>' when no ledger
-- event matches, and are never removed by the 90-day cleanup.
CREATE TABLE summaries (
  event_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  subject TEXT NOT NULL,
  summary TEXT NOT NULL,
  model TEXT NOT NULL,
  task_id TEXT NOT NULL DEFAULT '',
  imported INTEGER NOT NULL DEFAULT 0 CHECK (imported IN (0, 1))
);
CREATE INDEX summaries_created ON summaries (created_at);
CREATE INDEX summaries_expiring ON summaries (created_at) WHERE imported = 0;

-- Precomputed newsletter responses; the summary kind has top_n = 0. 'stale' is
-- only ever added when an old row is served, so it is never stored.
CREATE TABLE daily_reports (
  kind TEXT NOT NULL CHECK (kind IN ('summary', 'recommendation')),
  top_n INTEGER NOT NULL CHECK (top_n BETWEEN 0 AND 10),
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('ok', 'empty_window', 'model_output_invalid')),
  payload_json TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  task_count INTEGER NOT NULL CHECK (task_count >= 0),
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  error_code TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (kind, top_n, day),
  CHECK ((kind = 'summary') = (top_n = 0))
);
CREATE INDEX daily_reports_day ON daily_reports (day);

-- Owner mutation idempotency: a replayed action_request_id with the same
-- request_hash gets the stored outcome, a different hash gets 409.
CREATE TABLE owner_actions (
  owner TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_id TEXT,
  request_hash TEXT NOT NULL,
  result_ref TEXT,
  http_status INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner, action_request_id)
);
CREATE INDEX owner_actions_created ON owner_actions (created_at);

-- Newsletter Basic-auth failures per UTC hour ('YYYY-MM-DDTHH'), for the lockout.
CREATE TABLE auth_failures (
  hour TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0)
);

-- Full mail text imported from the retired Go cache (todofy.db).
CREATE TABLE legacy_mail_text (
  event_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  text TEXT NOT NULL,
  -- NULL keeps the text forever.
  expires_at INTEGER
);
CREATE INDEX legacy_mail_text_expires ON legacy_mail_text (expires_at) WHERE expires_at IS NOT NULL;
