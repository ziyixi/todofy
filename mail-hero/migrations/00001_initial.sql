-- +goose Up
CREATE TABLE webhook_endpoints (
    id uuid PRIMARY KEY,
    label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
    current_revision_id uuid,
    paused boolean NOT NULL DEFAULT false,
    paused_reason text,
    rate_per_minute integer NOT NULL DEFAULT 2 CHECK (rate_per_minute BETWEEN 1 AND 60),
    next_send_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE endpoint_revisions (
    id uuid PRIMARY KEY,
    endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE RESTRICT,
    revision integer NOT NULL CHECK (revision > 0),
    url text NOT NULL,
    auth_type text NOT NULL CHECK (auth_type IN ('none', 'bearer', 'basic')),
    credential_ciphertext bytea,
    credential_key_version integer,
    credential_key_id text,
    timeout_ms integer NOT NULL DEFAULT 20000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
    blocked_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (endpoint_id, revision),
    UNIQUE (endpoint_id, id),
    CHECK ((auth_type = 'none') = (credential_ciphertext IS NULL))
);

ALTER TABLE webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_current_revision_fkey
    FOREIGN KEY (id, current_revision_id)
    REFERENCES endpoint_revisions(endpoint_id, id)
    DEFERRABLE INITIALLY IMMEDIATE;

CREATE TABLE app_settings (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    mode text NOT NULL DEFAULT 'archive' CHECK (mode IN ('archive', 'forward')),
    current_endpoint_id uuid REFERENCES webhook_endpoints(id) ON DELETE RESTRICT,
    send_paused boolean NOT NULL DEFAULT false,
    next_send_at timestamptz,
    retention_days integer CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 3650),
    logical_bytes bigint NOT NULL DEFAULT 0 CHECK (logical_bytes >= 0),
    logical_limit_bytes bigint NOT NULL DEFAULT 10737418240 CHECK (logical_limit_bytes > 0),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    last_backup_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (mode <> 'forward' OR current_endpoint_id IS NOT NULL)
);

INSERT INTO app_settings (id) VALUES (1);

CREATE TABLE messages (
    id uuid PRIMARY KEY,
    ingest_key bytea NOT NULL UNIQUE CHECK (octet_length(ingest_key) = 32),
    origin text NOT NULL DEFAULT 'smtp' CHECK (origin IN ('smtp', 'synthetic_test')),
    received_at timestamptz NOT NULL DEFAULT now(),
    last_received_at timestamptz NOT NULL DEFAULT now(),
    arrival_count integer NOT NULL DEFAULT 1 CHECK (arrival_count > 0),
    envelope_from text NOT NULL,
    envelope_recipient text NOT NULL,
    raw bytea,
    raw_sha256 bytea NOT NULL CHECK (octet_length(raw_sha256) = 32),
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    receive_mode text NOT NULL CHECK (receive_mode IN ('archive', 'forward')),
    endpoint_revision_id uuid REFERENCES endpoint_revisions(id) ON DELETE RESTRICT,
    parse_state text NOT NULL DEFAULT 'pending' CHECK (parse_state IN ('pending', 'parsing', 'ready', 'failed')),
    parsed_json jsonb,
    parser_version text,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    subject text,
    from_text text,
    search_text text,
    has_attachment boolean NOT NULL DEFAULT false,
    read_at timestamptz,
    content_deleted_at timestamptz,
    parse_error text,
    CHECK (receive_mode <> 'forward' OR endpoint_revision_id IS NOT NULL),
    CHECK (content_deleted_at IS NULL OR (raw IS NULL AND parsed_json IS NULL AND subject IS NULL AND from_text IS NULL AND search_text IS NULL)),
    CHECK (raw IS NULL OR octet_length(raw) = size_bytes)
);

CREATE INDEX messages_received_idx ON messages (received_at DESC, id DESC)
    WHERE origin = 'smtp';
CREATE INDEX messages_parse_pending_idx ON messages (received_at, id)
    WHERE parse_state = 'pending' AND content_deleted_at IS NULL;

CREATE TABLE deliveries (
    event_id uuid PRIMARY KEY,
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    endpoint_revision_id uuid NOT NULL REFERENCES endpoint_revisions(id) ON DELETE RESTRICT,
    generation integer NOT NULL CHECK (generation > 0),
    replay_of_event_id uuid REFERENCES deliveries(event_id) ON DELETE RESTRICT,
    action_request_id uuid,
    payload bytea,
    payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'retry_wait', 'delivered', 'failed', 'cancelled')),
    retry_mode text NOT NULL DEFAULT 'auto' CHECK (retry_mode IN ('auto', 'once')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    last_error text,
    UNIQUE (message_id, generation),
    UNIQUE (action_request_id)
);

CREATE INDEX deliveries_due_idx ON deliveries (next_attempt_at, event_id)
    WHERE state IN ('pending', 'retry_wait');
CREATE INDEX deliveries_message_idx ON deliveries (message_id, created_at DESC);

CREATE TABLE delivery_attempts (
    id uuid PRIMARY KEY,
    event_id uuid NOT NULL REFERENCES deliveries(event_id) ON DELETE RESTRICT,
    attempt_no integer NOT NULL CHECK (attempt_no > 0),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
    duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
    outcome text,
    error_code text,
    response_preview text,
    credential_key_id text,
    UNIQUE (event_id, attempt_no)
);

CREATE INDEX delivery_attempts_event_idx ON delivery_attempts (event_id, attempt_no DESC);

CREATE TABLE audit_log (
    id uuid PRIMARY KEY,
    owner text NOT NULL,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id text,
    summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    request_id text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_recent_idx ON audit_log (created_at DESC);

CREATE TABLE ui_actions (
    id uuid PRIMARY KEY,
    owner text NOT NULL,
    action_request_id uuid NOT NULL,
    operation text NOT NULL,
    resource_id text,
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    result_ref text,
    http_status integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner, action_request_id)
);

CREATE INDEX ui_actions_created_idx ON ui_actions (created_at);

-- +goose Down
DROP TABLE ui_actions;
DROP TABLE audit_log;
DROP TABLE delivery_attempts;
DROP TABLE deliveries;
DROP TABLE messages;
DROP TABLE app_settings;
ALTER TABLE webhook_endpoints DROP CONSTRAINT webhook_endpoints_current_revision_fkey;
DROP TABLE endpoint_revisions;
DROP TABLE webhook_endpoints;
