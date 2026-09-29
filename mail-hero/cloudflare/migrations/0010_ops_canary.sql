-- contracts/ops-v1. Additive: the previous Worker keeps running between this migration and the deploy.
-- Canary messages (origin 'synthetic_test') carry the dashboard's run id; the previous Worker never sets it.
ALTER TABLE messages ADD COLUMN canary_run_id TEXT CHECK(canary_run_id IS NULL OR length(canary_run_id) BETWEEN 1 AND 64);
-- Canary content cleanup walks live canary messages by age only.
CREATE INDEX messages_canary_idx ON messages(received_at,id) WHERE canary_run_id IS NOT NULL AND content_deleted_at IS NULL;
-- Start of the current activation of an alert (first_seen_at is the first activation ever).
-- The previous Worker's upsert leaves it unchanged, which only makes one episode's `since` absent or early.
ALTER TABLE alerts ADD COLUMN active_since TEXT;
