-- The links app's D1 database "links" (docs/design.md §5). Times are epoch milliseconds.
--
-- links: one row per key. A redirect reads exactly one row by its primary key and writes nothing. A delete is
-- soft (AIP-164): delete_time and purge_time are set, and the next list or write purges rows whose purge_time has
-- passed (the partial index finds them; it costs a write only for deleted rows). WITHOUT ROWID: the key is the
-- table's own B-tree, so the redirect's lookup is a single search.
CREATE TABLE links (
  key TEXT PRIMARY KEY NOT NULL,
  target TEXT NOT NULL,
  path_mode TEXT NOT NULL CHECK (path_mode IN ('exact', 'append', 'template')),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
  description TEXT NOT NULL DEFAULT '',
  -- A JSON array of tag strings.
  tags TEXT NOT NULL DEFAULT '[]',
  expire_time INTEGER,
  create_time INTEGER NOT NULL,
  update_time INTEGER NOT NULL,
  delete_time INTEGER,
  purge_time INTEGER,
  -- The current revision (link_revisions.revision) and when it was made.
  revision INTEGER NOT NULL,
  revision_time INTEGER NOT NULL,
  -- AIP-154: random, new on every write.
  etag TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX links_purge ON links (purge_time) WHERE purge_time IS NOT NULL;

-- link_revisions: the content of each change of a link (AIP-162), the last 20 per link, for undo and rollback.
-- Purged with its link.
CREATE TABLE link_revisions (
  key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  create_time INTEGER NOT NULL,
  target TEXT NOT NULL,
  path_mode TEXT NOT NULL,
  visibility TEXT NOT NULL,
  description TEXT NOT NULL,
  tags TEXT NOT NULL,
  expire_time INTEGER,
  PRIMARY KEY (key, revision)
) WITHOUT ROWID;

-- request_log: the first response of each mutation sent with a request_id (AIP-155, a UUID4), answered again to a
-- repeat within 24 hours; the next write drops older rows (a scan of a table that holds a day of owner edits). A
-- repeat is answered only when it is the same rpc (method) on the same resource (name: links/<key>, '' for
-- ImportLinks); the ID reused for another request is refused and applies nothing.
CREATE TABLE request_log (
  request_id TEXT PRIMARY KEY NOT NULL CHECK (length(request_id) = 36),
  method TEXT NOT NULL,
  name TEXT NOT NULL,
  response TEXT NOT NULL,
  create_time INTEGER NOT NULL
) WITHOUT ROWID;
