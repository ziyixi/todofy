-- Cloudflare-native schema. D1 stores metadata; all large content lives in R2.
PRAGMA foreign_keys = ON;

CREATE TABLE webhook_endpoints (
 id TEXT PRIMARY KEY, label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
 current_revision_id TEXT, paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN(0,1)),
 paused_reason TEXT, rate_per_minute INTEGER NOT NULL DEFAULT 2 CHECK(rate_per_minute BETWEEN 1 AND 60),
 next_send_at TEXT, version INTEGER NOT NULL DEFAULT 1, archived_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE endpoint_revisions (
 id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id),
 revision INTEGER NOT NULL CHECK(revision > 0), url TEXT NOT NULL,
 auth_type TEXT NOT NULL CHECK(auth_type IN('none','bearer','basic')),
 credential_ciphertext TEXT, credential_key_version INTEGER, credential_key_id TEXT,
 timeout_ms INTEGER NOT NULL DEFAULT 20000 CHECK(timeout_ms BETWEEN 1000 AND 120000),
 blocked_reason TEXT, created_at TEXT NOT NULL,
 UNIQUE(endpoint_id,revision), UNIQUE(endpoint_id,id),
 CHECK((auth_type='none')=(credential_ciphertext IS NULL))
);
CREATE TABLE app_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 mode TEXT NOT NULL DEFAULT 'archive' CHECK(mode IN('archive','forward')),
 current_endpoint_id TEXT REFERENCES webhook_endpoints(id),
 send_paused INTEGER NOT NULL DEFAULT 0 CHECK(send_paused IN(0,1)), next_send_at TEXT,
 retention_days INTEGER CHECK(retention_days IS NULL OR retention_days BETWEEN 1 AND 3650),
 logical_bytes INTEGER NOT NULL DEFAULT 0 CHECK(logical_bytes>=0),
 logical_limit_bytes INTEGER NOT NULL DEFAULT 5368709120 CHECK(logical_limit_bytes>0),
 version INTEGER NOT NULL DEFAULT 1, last_backup_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK(mode!='forward' OR current_endpoint_id IS NOT NULL)
);
INSERT INTO app_settings(id,created_at,updated_at) VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE messages (
 id TEXT PRIMARY KEY, ingest_key TEXT UNIQUE,
 origin TEXT NOT NULL DEFAULT 'cloudflare' CHECK(origin IN('cloudflare','synthetic_test')),
 received_at TEXT NOT NULL, last_received_at TEXT NOT NULL, arrival_count INTEGER NOT NULL DEFAULT 1,
 envelope_from TEXT NOT NULL, envelope_recipient TEXT NOT NULL,
 raw_key TEXT, raw_sha256 TEXT, size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
 receive_mode TEXT NOT NULL CHECK(receive_mode IN('archive','forward')),
 endpoint_revision_id TEXT REFERENCES endpoint_revisions(id),
 policy_error TEXT,
 parse_state TEXT NOT NULL DEFAULT 'pending' CHECK(parse_state IN('pending','parsing','ready','failed')),
 parsed_key TEXT, parsed_size_bytes INTEGER NOT NULL DEFAULT 0,
 content_bytes INTEGER NOT NULL DEFAULT 0 CHECK(content_bytes>=0),
 parser_version TEXT, version INTEGER NOT NULL DEFAULT 1,
 subject TEXT, from_text TEXT, search_text TEXT, has_attachment INTEGER NOT NULL DEFAULT 0,
 read_at TEXT, content_deleted_at TEXT, parse_error TEXT, claim_token TEXT, lease_until TEXT,
 CHECK(receive_mode!='forward' OR endpoint_revision_id IS NOT NULL)
);
CREATE INDEX messages_received_idx ON messages(received_at DESC,id DESC);
CREATE INDEX messages_parse_idx ON messages(parse_state,lease_until,received_at);
CREATE TABLE message_search (
 message_id TEXT NOT NULL REFERENCES messages(id), chunk_no INTEGER NOT NULL,
 body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=160000),
 PRIMARY KEY(message_id,chunk_no)
);
CREATE TABLE deliveries (
 event_id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id),
 endpoint_revision_id TEXT NOT NULL REFERENCES endpoint_revisions(id),
 generation INTEGER NOT NULL CHECK(generation>0), replay_of_event_id TEXT REFERENCES deliveries(event_id),
 action_request_id TEXT UNIQUE, payload_key TEXT, payload_sha256 TEXT NOT NULL,
 payload_size_bytes INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','sending','retry_wait','delivered','failed','cancelled')),
 retry_mode TEXT NOT NULL DEFAULT 'auto' CHECK(retry_mode IN('auto','once')),
 attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
 created_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT, claim_token TEXT, lease_until TEXT,
 UNIQUE(message_id,generation)
);
CREATE INDEX deliveries_due_idx ON deliveries(state,next_attempt_at);
CREATE INDEX deliveries_message_idx ON deliveries(message_id,created_at DESC);
CREATE TABLE delivery_attempts (
 id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES deliveries(event_id),
 attempt_no INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
 http_status INTEGER, duration_ms INTEGER, outcome TEXT, error_code TEXT,
 response_preview TEXT, credential_key_id TEXT, UNIQUE(event_id,attempt_no)
);
CREATE TABLE ui_actions (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, action_request_id TEXT NOT NULL,
 operation TEXT NOT NULL, resource_id TEXT, request_hash TEXT NOT NULL,
 result_ref TEXT, http_status INTEGER, created_at TEXT NOT NULL,
 UNIQUE(owner,action_request_id)
);
CREATE TABLE audit_log (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, action TEXT NOT NULL,
 resource_type TEXT NOT NULL, resource_id TEXT, summary TEXT NOT NULL DEFAULT '{}',
 request_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE maintenance (
 id TEXT PRIMARY KEY, value TEXT NOT NULL
);
