-- Owner-resolved exceptions (a failed event later delivered, or every
-- undelivered event cancelled by the owner) get one global, longer retention
-- period; route-class blocks recheck automatically a bounded number of times.
-- Additive: the previous Worker keeps running between this migration and the deploy.
ALTER TABLE app_settings ADD COLUMN resolved_retention_days INTEGER DEFAULT 60 CHECK(resolved_retention_days IS NULL OR resolved_retention_days BETWEEN 1 AND 3650);
-- Never shorter than the existing content period; none while content is kept forever.
UPDATE app_settings SET resolved_retention_days=CASE WHEN content_retention_days IS NULL THEN NULL
 ELSE max(resolved_retention_days,content_retention_days) END WHERE id=1;
-- When the lifecycle saw the message resolved (an owner retry or cancel, or
-- leaving the resolved state, resets it); the floor of its clock anchor.
ALTER TABLE messages ADD COLUMN resolved_at TEXT;
-- Automatic cooldown rechecks used by the current route-class block episode.
ALTER TABLE endpoint_revisions ADD COLUMN blocked_rechecks INTEGER NOT NULL DEFAULT 0;
