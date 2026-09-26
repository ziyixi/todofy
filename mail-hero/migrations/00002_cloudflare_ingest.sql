-- +goose Up
ALTER TABLE messages DROP CONSTRAINT messages_origin_check;
ALTER TABLE messages ADD CONSTRAINT messages_origin_check
    CHECK (origin IN ('smtp', 'cloudflare', 'synthetic_test'));

CREATE TABLE ingest_receipts (
    source text NOT NULL CHECK (source = 'cloudflare'),
    external_id uuid NOT NULL,
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    ingest_key bytea NOT NULL CHECK (octet_length(ingest_key) = 32),
    received_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, external_id)
);
CREATE INDEX ingest_receipts_message_idx ON ingest_receipts (message_id);

DROP INDEX messages_received_idx;
CREATE INDEX messages_received_idx ON messages (received_at DESC, id DESC)
    WHERE origin IN ('smtp', 'cloudflare');

-- +goose Down
DROP INDEX messages_received_idx;
DROP TABLE ingest_receipts;
-- This intentionally fails while Cloudflare messages exist; a downgrade must
-- not silently discard or reclassify received mail.
ALTER TABLE messages DROP CONSTRAINT messages_origin_check;
ALTER TABLE messages ADD CONSTRAINT messages_origin_check
    CHECK (origin IN ('smtp', 'synthetic_test'));
CREATE INDEX messages_received_idx ON messages (received_at DESC, id DESC)
    WHERE origin = 'smtp';
