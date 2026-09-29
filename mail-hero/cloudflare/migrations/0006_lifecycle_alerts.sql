-- New intake snapshots these defaults. Existing messages deliberately stay NULL.
ALTER TABLE app_settings ADD COLUMN lifecycle_policy_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE app_settings ADD COLUMN raw_retention_days INTEGER DEFAULT 7 CHECK(raw_retention_days IS NULL OR raw_retention_days BETWEEN 1 AND 3650);
ALTER TABLE app_settings ADD COLUMN content_retention_days INTEGER DEFAULT 30 CHECK(content_retention_days IS NULL OR content_retention_days BETWEEN 1 AND 3650);
ALTER TABLE app_settings ADD COLUMN ledger_retention_days INTEGER NOT NULL DEFAULT 180 CHECK(ledger_retention_days BETWEEN 90 AND 3650);
ALTER TABLE messages ADD COLUMN retention_policy_version INTEGER;
ALTER TABLE messages ADD COLUMN raw_retention_days INTEGER;
ALTER TABLE messages ADD COLUMN content_retention_days INTEGER;
ALTER TABLE messages ADD COLUMN ledger_retention_days INTEGER;
ALTER TABLE messages ADD COLUMN retention_started_at TEXT;
ALTER TABLE messages ADD COLUMN raw_expired_at TEXT;
ALTER TABLE messages ADD COLUMN raw_purged_at TEXT;
ALTER TABLE messages ADD COLUMN raw_capacity_pending_key TEXT;
ALTER TABLE messages ADD COLUMN raw_capacity_remaining_bytes INTEGER;
ALTER TABLE messages ADD COLUMN pending_delete_bytes INTEGER NOT NULL DEFAULT 0 CHECK(pending_delete_bytes>=0);
ALTER TABLE messages ADD COLUMN content_purge_pending INTEGER NOT NULL DEFAULT 0 CHECK(content_purge_pending IN(0,1));
UPDATE messages SET content_purge_pending=1 WHERE content_deleted_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM maintenance WHERE id='purged:'||messages.id);
CREATE INDEX messages_content_purge_pending_idx ON messages(id) WHERE content_purge_pending=1;
ALTER TABLE messages ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0 CHECK(needs_review IN(0,1));
CREATE INDEX messages_lifecycle_idx ON messages(retention_started_at,raw_expired_at,content_deleted_at);
CREATE INDEX messages_raw_purge_idx ON messages(raw_expired_at)
 WHERE raw_expired_at IS NOT NULL AND (raw_purged_at IS NULL OR raw_capacity_pending_key IS NOT NULL) AND content_deleted_at IS NULL;
-- Frequent maintenance scans only live content, never the indefinite dedup ledger.
CREATE INDEX messages_live_received_idx ON messages(received_at)
 WHERE origin='cloudflare' AND content_deleted_at IS NULL;
CREATE INDEX messages_live_lifecycle_idx ON messages(parse_state,lease_until,retention_started_at,id)
 WHERE origin='cloudflare' AND content_deleted_at IS NULL;

CREATE TABLE alerts (
 code TEXT PRIMARY KEY, active INTEGER NOT NULL CHECK(active IN(0,1)),
 severity TEXT NOT NULL CHECK(severity IN('info','warning','critical')),
 metrics_json TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
 resolved_at TEXT, last_event_day TEXT NOT NULL
);
CREATE TABLE alert_notifications (
 id TEXT PRIMARY KEY, code TEXT NOT NULL REFERENCES alerts(code),
 transition TEXT NOT NULL CHECK(transition IN('active','resolved')), day TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('disabled','pending','sending','sent','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
 lease_until TEXT, last_error TEXT, created_at TEXT NOT NULL, finished_at TEXT,
 UNIQUE(code,transition,day)
);
CREATE INDEX alert_notifications_due_idx ON alert_notifications(state,next_attempt_at,lease_until);
