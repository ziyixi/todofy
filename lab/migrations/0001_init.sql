-- D1 "lab": the records the UI reads (docs/design.md §6). LabState is the only writer. Personal rows
-- (feedback, seeds, settings) never leave this database except through the owner API behind Access.

-- Public arXiv metadata. id is 'arxiv:<id>' without version. Rows not saved, seeded or picked are
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

-- The daily top list (TODAY_LIMIT = 20); tldr for the first 10 only. Kept 365 days.
CREATE TABLE picks (
  day TEXT NOT NULL CHECK (length(day) = 10),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 20),
  paper_id TEXT NOT NULL,
  score REAL NOT NULL,
  tldr TEXT CHECK (tldr IS NULL OR length(tldr) <= 200),
  tldr_model TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (day, rank)
);
CREATE INDEX picks_by_paper ON picks (paper_id);

-- Owner triage. Skips are kept 180 days, saves until undone.
CREATE TABLE feedback (
  paper_id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (label IN ('save', 'skip')),
  at INTEGER NOT NULL
);
CREATE INDEX feedback_by_label_at ON feedback (label, at);

-- Cold-start seeds the owner enters (at most 50).
CREATE TABLE seeds (
  paper_id TEXT PRIMARY KEY CHECK (paper_id LIKE 'arxiv:%' AND length(paper_id) <= 64),
  added_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'not_found'))
);

-- Owner settings (categories, lambda, neuron_cap, tldr_model, ingest_paused), JSON values.
CREATE TABLE settings (
  key TEXT PRIMARY KEY CHECK (key IN ('categories', 'lambda', 'neuron_cap', 'tldr_model', 'ingest_paused')),
  value TEXT NOT NULL CHECK (json_valid(value) AND length(value) <= 1000),
  updated_at INTEGER NOT NULL
);
