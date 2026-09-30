-- D1 "lab": the records the UI reads (docs/design.md §6–§9). LabState is the only writer. Personal rows
-- (decks, decisions, sends, feedback, seeds, settings) never leave this database except through the owner
-- API behind Access and, for a send the owner confirms, the Todoist tasks Todofy creates.

-- Public arXiv metadata. id is 'arxiv:<id>' without version. Rows not liked, seeded or picked are
-- deleted after 90 days (retention job).
CREATE TABLE papers (
  id TEXT PRIMARY KEY CHECK (id LIKE 'arxiv:%' AND length(id) <= 64),
  version INTEGER NOT NULL CHECK (version >= 1),
  title TEXT NOT NULL CHECK (length(title) <= 1000),
  authors TEXT NOT NULL CHECK (length(authors) <= 1000),
  categories TEXT NOT NULL CHECK (json_valid(categories) AND length(categories) <= 1000),
  primary_category TEXT NOT NULL,
  announce_type TEXT NOT NULL CHECK (announce_type IN ('new', 'cross')),
  announced_on TEXT NOT NULL CHECK (length(announced_on) = 10),
  abstract TEXT NOT NULL CHECK (length(abstract) <= 8000),
  license TEXT CHECK (license IS NULL OR length(license) <= 200),
  new_version INTEGER NOT NULL DEFAULT 0 CHECK (new_version IN (0, 1)),
  first_seen_at INTEGER NOT NULL
);
CREATE INDEX papers_by_day ON papers (announced_on);
CREATE INDEX papers_by_first_seen ON papers (first_seen_at);

-- The day's ranked (or, at cold start, explore) cards, DECK_SIZE = 20, each with its 简介 (2-4 Chinese
-- sentences from the abstract; NULL until written, or when refused or skipped by the cap) and the nearest
-- positive paper ("为什么推荐"). Kept 365 days.
CREATE TABLE picks (
  day TEXT NOT NULL CHECK (length(day) = 10),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 20),
  paper_id TEXT NOT NULL,
  score REAL NOT NULL,
  because_id TEXT,
  brief TEXT CHECK (brief IS NULL OR length(brief) <= 400),
  brief_model TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (day, rank)
);
CREATE INDEX picks_by_paper ON picks (paper_id);

-- One deck per announce day (docs/design.md §7). version is bumped by every decision event (compare-and-
-- set for mutations); ready_at is set once the 简介 step is done or stopped.
CREATE TABLE decks (
  deck_id TEXT PRIMARY KEY CHECK (length(deck_id) = 10),
  kind TEXT NOT NULL CHECK (kind IN ('ranked', 'explore')),
  size INTEGER NOT NULL CHECK (size BETWEEN 1 AND 20),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at INTEGER NOT NULL,
  ready_at INTEGER,
  finished_at INTEGER,
  later_at INTEGER,
  -- What the next undo takes back (api-types UndoTarget as JSON), materialised with every decision event.
  undo TEXT CHECK (undo IS NULL OR (json_valid(undo) AND length(undo) <= 300))
);
CREATE INDEX decks_by_ready ON decks (ready_at);

-- The frozen card order and the materialised decision state (the replay of deck_events).
CREATE TABLE deck_cards (
  deck_id TEXT NOT NULL REFERENCES decks (deck_id),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 20),
  paper_id TEXT NOT NULL,
  decision TEXT CHECK (decision IS NULL OR decision IN ('like', 'dislike')),
  decided_seq INTEGER,
  send_excluded INTEGER NOT NULL DEFAULT 0 CHECK (send_excluded IN (0, 1)),
  sent_generation INTEGER CHECK (sent_generation IS NULL OR sent_generation >= 1),
  PRIMARY KEY (deck_id, position),
  UNIQUE (deck_id, paper_id)
);

-- Append-only decision log: decide, undo (target_seq = the event it cancels), restart. At most 400 per deck.
CREATE TABLE deck_events (
  deck_id TEXT NOT NULL REFERENCES decks (deck_id),
  seq INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 400),
  kind TEXT NOT NULL CHECK (kind IN ('decide', 'undo', 'restart')),
  paper_id TEXT,
  decision TEXT CHECK (decision IS NULL OR decision IN ('like', 'dislike')),
  target_seq INTEGER,
  at INTEGER NOT NULL,
  PRIMARY KEY (deck_id, seq),
  CHECK ((kind = 'decide') = (paper_id IS NOT NULL AND decision IS NOT NULL)),
  CHECK ((kind = 'undo') = (target_seq IS NOT NULL))
);

-- Replay store for owner mutations: a repeated op_id returns the stored response. Kept 30 days.
CREATE TABLE owner_ops (
  op_id TEXT PRIMARY KEY CHECK (length(op_id) = 36),
  route TEXT NOT NULL CHECK (length(route) <= 64),
  deck_id TEXT,
  status INTEGER NOT NULL,
  response TEXT NOT NULL CHECK (json_valid(response) AND length(response) <= 16384),
  at INTEGER NOT NULL
);
CREATE INDEX owner_ops_by_at ON owner_ops (at);

-- Sends to Todofy (contracts/task-intent-v1), one row per deck generation. payload is the frozen TaskIntent
-- JSON (NULL 30 days after settling; the hash stays). Kept 400 days.
CREATE TABLE sends (
  deck_id TEXT NOT NULL REFERENCES decks (deck_id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  intent_id TEXT NOT NULL UNIQUE CHECK (length(intent_id) <= 64),
  mode TEXT NOT NULL CHECK (mode IN ('subtasks', 'separate')),
  paper_ids TEXT NOT NULL CHECK (json_valid(paper_ids)),
  payload TEXT CHECK (payload IS NULL OR (json_valid(payload) AND length(payload) <= 65536)),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('sending', 'pending', 'created', 'duplicate', 'paused', 'failed', 'rejected', 'unknown')),
  recorded INTEGER NOT NULL DEFAULT 0 CHECK (recorded IN (0, 1)),
  tasks_total INTEGER NOT NULL DEFAULT 0 CHECK (tasks_total BETWEEN 0 AND 31),
  tasks_created INTEGER NOT NULL DEFAULT 0 CHECK (tasks_created BETWEEN 0 AND 31),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 48),
  next_poll_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (deck_id, generation)
);

-- The effective label per paper that ranking reads: from a deck (recomputed with every decision event) or
-- from the 已喜欢 list. Dislikes are kept 180 days, likes until removed.
CREATE TABLE feedback (
  paper_id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (label IN ('like', 'dislike')),
  source TEXT NOT NULL CHECK (source IN ('deck', 'library')),
  deck_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX feedback_by_label_at ON feedback (label, at);

-- Cold-start seeds the owner enters (at most 50).
CREATE TABLE seeds (
  paper_id TEXT PRIMARY KEY CHECK (paper_id LIKE 'arxiv:%' AND length(paper_id) <= 64),
  added_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'not_found'))
);

-- Owner settings, JSON values.
CREATE TABLE settings (
  key TEXT PRIMARY KEY CHECK (key IN ('categories', 'lambda', 'neuron_cap', 'tldr_model', 'ingest_paused', 'send_mode')),
  value TEXT NOT NULL CHECK (json_valid(value) AND length(value) <= 1000),
  updated_at INTEGER NOT NULL
);
