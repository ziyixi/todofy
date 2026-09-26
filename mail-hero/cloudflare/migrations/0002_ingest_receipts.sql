-- Every R2 ingress identity maps once to a canonical message. This also prevents
-- the repair scan from counting the same raw object as a new arrival.
CREATE TABLE ingest_receipts (
 source TEXT NOT NULL DEFAULT 'cloudflare' CHECK(source='cloudflare'),
 external_id TEXT NOT NULL,
 message_id TEXT NOT NULL REFERENCES messages(id),
 ingest_key TEXT NOT NULL,
 received_at TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(source,external_id)
);
CREATE INDEX ingest_receipts_message_idx ON ingest_receipts(message_id);
