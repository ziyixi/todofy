-- Tasks' planning API replaced the Todoist Plus extension: no connection token or Sync-command receipt is read or
-- written any more (the receipts live in the core's Durable Object).
DROP TABLE plus_connections;
DROP TABLE plus_actions;
