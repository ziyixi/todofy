-- Tasks keeps the GTD days, the weekly reviews and the Mail categories since tasks/migrations/0008_mail_gtd_inbox.sql,
-- and its one-time Todofy import copied Todofy's rows into it (its apply run ended with nothing pending). Nothing in
-- Todofy has read or written these tables since 2026-10-21. mail_reminders stays: the legacy host import
-- (tools/legacy_migration) still loads into it. No table here has a foreign key or a trigger (summaries.category_id
-- keeps Tasks' category IDs as plain values), and each table's indexes drop with it.
DROP TABLE gtd_daily;
DROP TABLE gtd_reviews;
DROP TABLE plan_categories;
DROP TABLE plan_settings;
