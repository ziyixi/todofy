-- The outbox of the optional alert webhook (0006, ALERT_WEBHOOK_URL). The Worker stopped writing, delivering and
-- purging it on 2026-10-21: active alerts reach the owner as ops-v1 signals in Home's daily digest task in Tasks.
-- That Worker is the one serving while this migration runs, so dropping the table is backward compatible; its two
-- indexes go with it. alerts and its last_event_day stay (the Worker still upserts them).
DROP TABLE alert_notifications;
