-- Periodic maintenance reads only due, unsettled or in-flight rows. Additive:
-- the previous Worker keeps running between this migration and the deploy.
-- lifecycle_due_at is healed by code, never backfilled here.
ALTER TABLE messages ADD COLUMN lifecycle_due_at TEXT;
CREATE INDEX messages_lifecycle_due_idx ON messages(lifecycle_due_at,id)
 WHERE origin='cloudflare' AND content_deleted_at IS NULL AND lifecycle_due_at IS NOT NULL;
-- Live mail whose retention clock has not started: in flight, failed, blocked,
-- policy errors, review and pre-lifecycle history.
CREATE INDEX messages_unsettled_idx ON messages(received_at,id)
 WHERE origin='cloudflare' AND content_deleted_at IS NULL AND retention_started_at IS NULL;
-- Normally empty; rows clocked by an older Worker or after a rollback.
CREATE INDEX messages_due_missing_idx ON messages(id)
 WHERE origin='cloudflare' AND content_deleted_at IS NULL AND retention_started_at IS NOT NULL AND lifecycle_due_at IS NULL;
CREATE INDEX messages_pending_delete_idx ON messages(id) WHERE pending_delete_bytes>0;
CREATE INDEX alert_notifications_created_idx ON alert_notifications(created_at);
-- Route-class rejections block a revision only until an automatic recheck.
ALTER TABLE endpoint_revisions ADD COLUMN blocked_until TEXT;
ALTER TABLE deliveries ADD COLUMN blocking_since TEXT;
-- Blocks without a cooldown: normally only auth or policy blocks. The repair
-- phase gives route-class ones written by an older Worker their recheck.
CREATE INDEX endpoint_revisions_uncooled_idx ON endpoint_revisions(id) WHERE blocked_reason IS NOT NULL AND blocked_until IS NULL;
-- Waiting events by age, so ones held past their retry window are found by range.
CREATE INDEX deliveries_waiting_created_idx ON deliveries(created_at) WHERE state IN('pending','retry_wait');

-- Exact overview counts in O(1). Trigger writes are not counted by SQL changes(),
-- so existing `changes()>0` batch chaining is unaffected.
CREATE TABLE app_counters (
 id INTEGER PRIMARY KEY CHECK(id=1),
 messages INTEGER NOT NULL DEFAULT 0,
 deliveries_pending INTEGER NOT NULL DEFAULT 0,
 deliveries_sending INTEGER NOT NULL DEFAULT 0,
 deliveries_retry_wait INTEGER NOT NULL DEFAULT 0,
 deliveries_delivered INTEGER NOT NULL DEFAULT 0,
 deliveries_failed INTEGER NOT NULL DEFAULT 0,
 deliveries_cancelled INTEGER NOT NULL DEFAULT 0
);
INSERT INTO app_counters(id,messages,deliveries_pending,deliveries_sending,deliveries_retry_wait,deliveries_delivered,deliveries_failed,deliveries_cancelled)
 SELECT 1,(SELECT count(*) FROM messages WHERE origin='cloudflare'),
  (SELECT count(*) FROM deliveries WHERE state='pending'),(SELECT count(*) FROM deliveries WHERE state='sending'),
  (SELECT count(*) FROM deliveries WHERE state='retry_wait'),(SELECT count(*) FROM deliveries WHERE state='delivered'),
  (SELECT count(*) FROM deliveries WHERE state='failed'),(SELECT count(*) FROM deliveries WHERE state='cancelled');
CREATE TRIGGER app_counters_message_insert AFTER INSERT ON messages WHEN NEW.origin='cloudflare'
BEGIN
 UPDATE app_counters SET messages=messages+1 WHERE id=1;
END;
CREATE TRIGGER app_counters_message_delete AFTER DELETE ON messages WHEN OLD.origin='cloudflare'
BEGIN
 UPDATE app_counters SET messages=max(0,messages-1) WHERE id=1;
END;
CREATE TRIGGER app_counters_message_origin AFTER UPDATE OF origin ON messages WHEN OLD.origin IS NOT NEW.origin
BEGIN
 UPDATE app_counters SET messages=max(0,messages+(NEW.origin='cloudflare')-(OLD.origin='cloudflare')) WHERE id=1;
END;
CREATE TRIGGER app_counters_delivery_insert AFTER INSERT ON deliveries
BEGIN
 UPDATE app_counters SET deliveries_pending=deliveries_pending+(NEW.state='pending'),deliveries_sending=deliveries_sending+(NEW.state='sending'),
  deliveries_retry_wait=deliveries_retry_wait+(NEW.state='retry_wait'),deliveries_delivered=deliveries_delivered+(NEW.state='delivered'),
  deliveries_failed=deliveries_failed+(NEW.state='failed'),deliveries_cancelled=deliveries_cancelled+(NEW.state='cancelled') WHERE id=1;
END;
CREATE TRIGGER app_counters_delivery_state AFTER UPDATE OF state ON deliveries WHEN OLD.state IS NOT NEW.state
BEGIN
 UPDATE app_counters SET deliveries_pending=max(0,deliveries_pending+(NEW.state='pending')-(OLD.state='pending')),
  deliveries_sending=max(0,deliveries_sending+(NEW.state='sending')-(OLD.state='sending')),
  deliveries_retry_wait=max(0,deliveries_retry_wait+(NEW.state='retry_wait')-(OLD.state='retry_wait')),
  deliveries_delivered=max(0,deliveries_delivered+(NEW.state='delivered')-(OLD.state='delivered')),
  deliveries_failed=max(0,deliveries_failed+(NEW.state='failed')-(OLD.state='failed')),
  deliveries_cancelled=max(0,deliveries_cancelled+(NEW.state='cancelled')-(OLD.state='cancelled')) WHERE id=1;
END;
CREATE TRIGGER app_counters_delivery_delete AFTER DELETE ON deliveries
BEGIN
 UPDATE app_counters SET deliveries_pending=max(0,deliveries_pending-(OLD.state='pending')),deliveries_sending=max(0,deliveries_sending-(OLD.state='sending')),
  deliveries_retry_wait=max(0,deliveries_retry_wait-(OLD.state='retry_wait')),deliveries_delivered=max(0,deliveries_delivered-(OLD.state='delivered')),
  deliveries_failed=max(0,deliveries_failed-(OLD.state='failed')),deliveries_cancelled=max(0,deliveries_cancelled-(OLD.state='cancelled')) WHERE id=1;
END;
