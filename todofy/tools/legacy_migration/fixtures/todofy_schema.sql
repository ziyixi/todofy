-- Legacy summary cache (todofy.db): GORM AutoMigrate of DatabaseEntry
-- (database/database.go:42-51 @ 6c46ed4). Captured verbatim from `.schema` of a
-- database created by gorm.io/gorm v1.31.1 + gorm.io/driver/sqlite v1.6.0 (the
-- go.mod versions); timestamps are mattn/go-sqlite3 text such as
-- '2026-09-23 16:00:00.123456789+00:00'.
CREATE TABLE `database_entries` (`id` integer PRIMARY KEY AUTOINCREMENT,`created_at` datetime,`updated_at` datetime,`deleted_at` datetime,`model_family` integer,`llm_model` integer,`prompt` text,`max_tokens` integer,`text` text,`summary` text,`hash_id` text);
CREATE INDEX `idx_database_entries_hash_id` ON `database_entries`(`hash_id`);
CREATE INDEX `idx_database_entries_deleted_at` ON `database_entries`(`deleted_at`);
