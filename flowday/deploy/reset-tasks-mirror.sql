-- After any restore of Tasks' D1 (a backup or Time Travel, tasks/docs/backup.md): the restored change feed starts
-- again at 1, so FlowDay forgets its Tasks cursor and catalog and hides every mirrored task. The next Sync replays
-- the feed from the start and brings back each task the restored database holds; a task deleted in FlowDay stays
-- deleted, and queues, timers and work records keep their task IDs. From flowday/worker:
--   npx wrangler d1 execute DB --remote --config ../wrangler.toml --file ../deploy/reset-tasks-mirror.sql
UPDATE tasks SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), deleted_source = 'sync'
  WHERE todoist_id IS NOT NULL AND deleted_at IS NULL;
DELETE FROM settings WHERE key IN ('tasks_sync_cursor', 'tasks_sync_catalog_v2', 'tasks_sync_pending');
