-- Native Mail belongs to Todofy until the owner converts it to a generic Tasks Inbox task.
-- Existing rows and links are retained; the cutover adopts the owner's unclarified legacy entries separately.
CREATE INDEX summaries_pending ON summaries (created_at, event_id)
  WHERE imported = 0 AND triaged_at IS NULL;
