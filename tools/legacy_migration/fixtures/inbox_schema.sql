-- Legacy Mail Hero inbox (inbox.sqlite), copied from mail_inbox.go:239-274 @ 6c46ed4
-- with mailActiveSQL (mail_inbox_worker.go:388) substituted.
-- Synthetic fixtures only; the real file is read-only input to legacy_to_d1.py.
CREATE TABLE IF NOT EXISTS mail_inbox_events (
	source_id TEXT NOT NULL,
	event_id TEXT NOT NULL,
	payload_hash BLOB NOT NULL,
	payload BLOB,
	state TEXT NOT NULL CHECK(state IN (
		'pending','summarizing','summarized','todo_sending','todo_unknown',
		'todo_created','complete','ignored','failed_summary')),
	summary TEXT NOT NULL DEFAULT '',
	summary_model INTEGER NOT NULL DEFAULT 0,
	todo_body TEXT NOT NULL DEFAULT '',
	task_id TEXT NOT NULL DEFAULT '',
	attempt_count INTEGER NOT NULL DEFAULT 0,
	next_attempt_at INTEGER NOT NULL DEFAULT 0,
	last_error_code TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY(source_id,event_id)
);
CREATE INDEX IF NOT EXISTS mail_inbox_due ON mail_inbox_events(state,next_attempt_at,created_at);
CREATE INDEX IF NOT EXISTS mail_inbox_state ON mail_inbox_events(source_id,state);
CREATE INDEX IF NOT EXISTS mail_inbox_active ON mail_inbox_events(source_id,created_at,event_id)
	WHERE state NOT IN ('complete','ignored');
CREATE TABLE IF NOT EXISTS mail_inbox_reminders (
	day TEXT PRIMARY KEY,
	state TEXT NOT NULL CHECK(state IN ('sending','created','unknown','failed')),
	task_id TEXT NOT NULL DEFAULT '',
	subject TEXT NOT NULL DEFAULT '',
	body TEXT NOT NULL DEFAULT '',
	attention_count INTEGER NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at INTEGER NOT NULL DEFAULT 0,
	last_error_code TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
