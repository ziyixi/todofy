-- FlowDay reads Tasks only: the sealed Todoist key, the Todoist sync's own state and the catalog cache of the first
-- Tasks release (tasks_sync_catalog, replaced by tasks_sync_catalog_v2) are never read again.
DELETE FROM settings
WHERE key IN (
  'todoist_api_key',
  'todoist_sync_token',
  'todoist_projects',
  'todoist_sync_pending',
  'todoist_hierarchy_refresh',
  'tasks_sync_catalog'
);
