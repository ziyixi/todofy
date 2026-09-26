-- Full body remains in R2; only the first 16 KiB enters the searchable D1 index.
ALTER TABLE messages ADD COLUMN search_index_truncated INTEGER NOT NULL DEFAULT 0;
