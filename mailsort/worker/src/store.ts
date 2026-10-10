/**
 * MailsortState's SQLite storage (../../docs/design.md §6): labels and their trusted domains, the pending queue,
 * decisions, the review queue, examples with their embeddings, the ledger of Gmail writes, the daily usage, the feedback
 * queue, the replay evaluation and the AIP-155 request log, in the Durable Object's own database. No D1, no R2, no KV.
 * Synchronous (the Durable Object's SQL API), so the writes of one `transactionSync` are atomic: the history cursor
 * advances in the same transaction that queues the mails it covers.
 *
 * Every table is bounded (limits.ts): LABELS_MAX labels, TRUSTED_DOMAINS_PER_LABEL_MAX domains each, EXAMPLES_MAX
 * examples; decisions and the ledger for DECISIONS_KEPT_MS, their content (subject, sender, summary, the sender's
 * domain) and the review queue for CONTENT_KEPT_MS; the replay for REPLAY_KEPT_MS; the daily usage and flow counters
 * for FLOW_KEPT_DAYS; request IDs for a day. `prune` runs once per UTC day in every mode, off included (pipeline.ts
 * retain). Examples (masked summaries) and trusted domains are what the app learned: they are kept until deleted,
 * never pruned. The sender of a decision is kept only as a keyed hash (mask.ts senderHash), never as its address.
 *
 * Nothing here logs. Rows hold the owner's personal data (subjects, senders, domains); they leave the object only
 * through the owner API behind Access, and the masked text only to Workers AI.
 */
import { newEtag } from './ids.ts';
import { CONTENT_KEPT_MS, DAY, DECISIONS_KEPT_MS, ERRORS_KEPT, FLOW_KEPT_DAYS, REPLAY_KEPT_MS, REQUEST_ID_TTL_MS, TRUSTED_DOMAINS_PER_LABEL_MAX } from './limits.ts';
import { senderHash } from './mask.ts';

export const SCHEMA_VERSION = 5;

export const SCHEMA_V1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS labels (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    display_name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0,
    live INTEGER NOT NULL DEFAULT 0,
    trust INTEGER NOT NULL DEFAULT 0,
    threshold REAL NOT NULL DEFAULT 0,
    gmail_id TEXT,
    gmail_state TEXT NOT NULL CHECK (gmail_state IN ('pending', 'linked', 'missing')),
    desc_version INTEGER NOT NULL DEFAULT 1,
    live_since INTEGER,
    create_time INTEGER NOT NULL,
    update_time INTEGER NOT NULL,
    etag TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('sender_address', 'sender_domain', 'list_id', 'delivered_to')),
    value TEXT NOT NULL,
    label_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('proposed', 'active', 'disabled')),
    correction_count INTEGER NOT NULL DEFAULT 0,
    match_count INTEGER NOT NULL DEFAULT 0,
    create_time INTEGER NOT NULL,
    update_time INTEGER NOT NULL,
    UNIQUE (kind, value, label_id)
  )`,
  `CREATE INDEX IF NOT EXISTS rules_match ON rules (state, kind, value)`,
  // New INBOX mails waiting for a decision; `not_before` holds a mail deferred for the model's quota.
  `CREATE TABLE IF NOT EXISTS pending (
    message_id TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL,
    not_before INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS pending_due ON pending (not_before, added_at)`,
  // One row per mail seen. The content columns are cleared after CONTENT_KEPT_MS (content_cleared).
  `CREATE TABLE IF NOT EXISTS decisions (
    message_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    decided_at INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'suggested', 'unsure', 'skipped')),
    label_id TEXT,
    top_label TEXT,
    decider TEXT NOT NULL,
    unsure_reason TEXT NOT NULL DEFAULT '',
    probabilities TEXT NOT NULL DEFAULT '{}',
    suspicious REAL,
    bulk REAL,
    model TEXT NOT NULL DEFAULT '',
    versions TEXT NOT NULL DEFAULT '{}',
    dmarc INTEGER NOT NULL DEFAULT 0,
    sender_address TEXT,
    sender_domain TEXT,
    list_id TEXT,
    delivered_to TEXT,
    subject TEXT,
    sender TEXT,
    summary TEXT,
    content_cleared INTEGER NOT NULL DEFAULT 0,
    current_labels TEXT NOT NULL DEFAULT '[]',
    verdict TEXT CHECK (verdict IN ('confirmed', 'corrected', 'weak')),
    verdict_label TEXT,
    verdict_source TEXT,
    verdict_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS decisions_thread ON decisions (thread_id)`,
  `CREATE INDEX IF NOT EXISTS decisions_time ON decisions (decided_at)`,
  `CREATE INDEX IF NOT EXISTS decisions_sender ON decisions (sender_address, verdict_label)`,
  `CREATE INDEX IF NOT EXISTS decisions_list ON decisions (list_id, verdict_label)`,
  `CREATE TABLE IF NOT EXISTS review (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('suggestion', 'unsure', 'audit')),
    state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'corrected', 'skipped')),
    suggested_label TEXT,
    candidates TEXT NOT NULL DEFAULT '[]',
    decider TEXT NOT NULL,
    unsure_reason TEXT NOT NULL DEFAULT '',
    resolved_label TEXT,
    subject TEXT NOT NULL,
    sender TEXT NOT NULL,
    receive_time INTEGER NOT NULL,
    create_time INTEGER NOT NULL,
    resolve_time INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS review_state ON review (state, id)`,
  `CREATE INDEX IF NOT EXISTS review_message ON review (message_id)`,
  `CREATE TABLE IF NOT EXISTS examples (
    id TEXT PRIMARY KEY,
    label_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('correction', 'confirmation', 'weak_accept')),
    message_id TEXT UNIQUE,
    embedding BLOB,
    create_time INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS examples_label ON examples (label_id, id)`,
  `CREATE INDEX IF NOT EXISTS examples_unembedded ON examples (id) WHERE embedding IS NULL`,
  `CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    label_id TEXT NOT NULL,
    gmail_label_id TEXT,
    archived INTEGER NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('auto', 'owner')),
    state TEXT NOT NULL CHECK (state IN ('intended', 'applied', 'failed', 'undo_intended', 'undone')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_code TEXT,
    superseded INTEGER NOT NULL DEFAULT 0,
    create_time INTEGER NOT NULL,
    apply_time INTEGER,
    undo_time INTEGER,
    -- The mail's user labels (Label_*) when the intent was recorded: a retry in a later pass checks that the owner has
    -- not filed the mail since (writes.ts mailChanged).
    base_labels TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS ledger_message ON ledger (message_id)`,
  `CREATE INDEX IF NOT EXISTS ledger_state ON ledger (state, id)`,
  `CREATE INDEX IF NOT EXISTS ledger_time ON ledger (create_time)`,
  `CREATE TABLE IF NOT EXISTS usage (
    day TEXT PRIMARY KEY,
    gmail_calls INTEGER NOT NULL DEFAULT 0,
    ai_calls INTEGER NOT NULL DEFAULT 0,
    neurons REAL NOT NULL DEFAULT 0,
    decided INTEGER NOT NULL DEFAULT 0,
    applied INTEGER NOT NULL DEFAULT 0,
    unsure INTEGER NOT NULL DEFAULT 0,
    quota_exhausted INTEGER NOT NULL DEFAULT 0
  )`,
  // Label changes from Gmail's history on mails mailsort decided, waiting to be read as feedback.
  `CREATE TABLE IF NOT EXISTS feedback (
    key TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    change TEXT NOT NULL CHECK (change IN ('added', 'removed')),
    gmail_label_id TEXT NOT NULL,
    seq INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS requests (request_id TEXT PRIMARY KEY, rpc TEXT NOT NULL, resource TEXT NOT NULL, response TEXT NOT NULL, at INTEGER NOT NULL)`,
];

/**
 * Version 2 (2026-10-06, round 2): labels may keep their mail in the inbox and be sensitive; rules gain subject
 * conditions, their own keep-in-inbox and DMARC switches, the owner's evidence and notes, and the import entry they
 * came from (the unique key now includes the subject conditions, so one sender may have a carve-out and a plain rule
 * to the same label: SQLite cannot change a table's constraint, so the table is rebuilt); pending mail remembers a
 * deferral (counted once in the flow); decisions remember a rule's keep-in-inbox; deleted label IDs are retired; and
 * the daily flow counters (flow.ts).
 */
export const SCHEMA_V2: readonly string[] = [
  `ALTER TABLE labels ADD COLUMN keep_in_inbox INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE labels ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE rules_v2 (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('sender_address', 'sender_domain', 'list_id', 'delivered_to')),
    value TEXT NOT NULL,
    label_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('proposed', 'active', 'disabled')),
    correction_count INTEGER NOT NULL DEFAULT 0,
    match_count INTEGER NOT NULL DEFAULT 0,
    create_time INTEGER NOT NULL,
    update_time INTEGER NOT NULL,
    -- JSON arrays of lower-case words (rules.ts subjectMatches).
    subject_includes TEXT NOT NULL DEFAULT '[]',
    subject_excludes TEXT NOT NULL DEFAULT '[]',
    keep_in_inbox INTEGER NOT NULL DEFAULT 0,
    require_dmarc INTEGER NOT NULL DEFAULT 0,
    evidence TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    import_id TEXT NOT NULL DEFAULT '',
    UNIQUE (kind, value, label_id, subject_includes, subject_excludes)
  )`,
  `INSERT INTO rules_v2 (id, kind, value, label_id, state, correction_count, match_count, create_time, update_time)
   SELECT id, kind, value, label_id, state, correction_count, match_count, create_time, update_time FROM rules`,
  `DROP TABLE rules`,
  `ALTER TABLE rules_v2 RENAME TO rules`,
  `CREATE INDEX IF NOT EXISTS rules_match ON rules (state, kind, value)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS rules_import ON rules (import_id) WHERE import_id != ''`,
  // The time (ms) a mail was first deferred for the model's budget, 0 if never: the flow counts it as waiting until
  // it is decided or skipped, then moves it (pipeline.ts finishPending).
  `ALTER TABLE pending ADD COLUMN deferred INTEGER NOT NULL DEFAULT 0`,
  // 1: the deciding rule kept the mail in the inbox (its own keep_in_inbox), so the owner's confirmation keeps it too.
  `ALTER TABLE decisions ADD COLUMN keep_in_inbox INTEGER NOT NULL DEFAULT 0`,
  // IDs of deleted labels: decisions, review items, the ledger and the flow counters still name them, so a new label
  // never gets one (paths.ts labelIdFor; Store.takenLabelIds). Pruned once nothing that names them is kept.
  `CREATE TABLE IF NOT EXISTS retired_labels (id TEXT PRIMARY KEY, retire_time INTEGER NOT NULL)`,
  // One counter per UTC day, stage, outcome and label (flow.ts): a few hundred rows a day at most.
  `CREATE TABLE IF NOT EXISTS flow (
    day TEXT NOT NULL,
    stage TEXT NOT NULL,
    outcome TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, stage, outcome, label)
  ) WITHOUT ROWID`,
];

/**
 * Schema version 3 (QA round 2): the Gmail IDs of the parent labels this app created to nest a label (`新闻` above
 * `新闻/周报`; writes.ts ensureGmailParents), so a label later linked to one is the app's own, never adopted. A
 * handful of rows; a row goes when Gmail no longer has the label or the owner adds it as a label by hand.
 */
export const SCHEMA_V3: readonly string[] = [`CREATE TABLE IF NOT EXISTS gmail_parents (gmail_id TEXT PRIMARY KEY, create_time INTEGER NOT NULL)`];

/**
 * Schema version 4 (2026-10-07, labels at Gmail's top level, without the `分拣/` prefix): two flags of a label's Gmail
 * state. `gmail_adopted`: 1 when a linked label was adopted, a user label of exactly its path that Gmail already had
 * and mailsort did not create, linked by the owner's 从 Gmail 同步 (api.ts syncLabels). `gmail_name_taken`: 1 while a
 * pending label's path is the name of a Gmail label that is not its own (writes.ts ensureGmailLabel), so nothing is
 * created or written with it. Existing rows read 0 for both. Nothing else changes: a label's row holds its path without
 * the prefix (every entry point stripped it, and no path may start with `分拣`), and rules name their label by ID.
 */
export const SCHEMA_V4: readonly string[] = [
  `ALTER TABLE labels ADD COLUMN gmail_adopted INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE labels ADD COLUMN gmail_name_taken INTEGER NOT NULL DEFAULT 0`,
];

/**
 * Schema version 5 (2026-10-10, the model decides every mail; ../../docs/design.md §3.4). In one transaction:
 *
 * 1. trusted domains, seeded from the active rules of trust labels and the active rules with `require_dmarc`: the
 *    domain of a sender address rule, or a sender domain rule's own (list and delivered-to rules name no sender);
 * 2. the rules (proposals included) dropped, and what only they used: a decision's exact sender address, List-Id,
 *    delivered-to address and its rule's keep-in-inbox, with their indexes;
 * 3. decisions rebuilt (SQLite cannot change a CHECK): the outcome `none` (confident that no label fits), the sender
 *    as a keyed hash (filled from the addresses still kept: senderHashesToBackfill), the second view's probabilities,
 *    p(needs_action), the combined probability and whether the mail was shown in the review queue;
 * 4. labels rebuilt without live mode per label (`live`, `live_since`) and the owner's thresholds: a label writes
 *    in live mode when it is enabled;
 * 5. the review queue keeps only uncertain mail: pending shadow suggestions and audit samples go (resolved items stay
 *    for the replay evaluation);
 * 6. the replay evaluation's table.
 *
 * Every statement is safe to run again (IF EXISTS, IF NOT EXISTS, OR IGNORE), and Store.migrate runs them inside the
 * object's transaction, under blockConcurrencyWhile, so a migration cut short leaves version 4 as it was.
 */
export const SCHEMA_V5: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS trusted_domains (
    label_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('seed', 'owner')),
    create_time INTEGER NOT NULL,
    PRIMARY KEY (label_id, domain)
  ) WITHOUT ROWID`,
  `INSERT OR IGNORE INTO trusted_domains (label_id, domain, origin, create_time)
   SELECT r.label_id, CASE r.kind WHEN 'sender_address' THEN substr(r.value, instr(r.value, '@') + 1) ELSE r.value END, 'seed', r.create_time
   FROM rules r JOIN labels l ON l.id = r.label_id
   WHERE r.state = 'active' AND r.kind IN ('sender_address', 'sender_domain') AND (l.trust = 1 OR r.require_dmarc = 1)
     AND (r.kind = 'sender_domain' OR instr(r.value, '@') > 1)`,
  `DROP TABLE IF EXISTS rules`,
  `DROP TABLE IF EXISTS decisions_v5`,
  `CREATE TABLE decisions_v5 (
    message_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    decided_at INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'suggested', 'none', 'unsure', 'skipped')),
    label_id TEXT,
    top_label TEXT,
    decider TEXT NOT NULL,
    unsure_reason TEXT NOT NULL DEFAULT '',
    probabilities TEXT NOT NULL DEFAULT '{}',
    probabilities2 TEXT NOT NULL DEFAULT '{}',
    suspicious REAL,
    bulk REAL,
    needs_action REAL,
    confidence REAL,
    shown INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT '',
    versions TEXT NOT NULL DEFAULT '{}',
    dmarc INTEGER NOT NULL DEFAULT 0,
    sender_hash TEXT,
    sender_domain TEXT,
    subject TEXT,
    sender TEXT,
    summary TEXT,
    content_cleared INTEGER NOT NULL DEFAULT 0,
    current_labels TEXT NOT NULL DEFAULT '[]',
    verdict TEXT CHECK (verdict IN ('confirmed', 'corrected', 'weak')),
    verdict_label TEXT,
    verdict_source TEXT,
    verdict_at INTEGER
  )`,
  // A decision in the review queue then was shown there.
  `INSERT INTO decisions_v5 (message_id, thread_id, received_at, decided_at, outcome, label_id, top_label, decider, unsure_reason, probabilities, suspicious,
     bulk, shown, model, versions, dmarc, sender_domain, subject, sender, summary, content_cleared, current_labels, verdict, verdict_label, verdict_source, verdict_at)
   SELECT message_id, thread_id, received_at, decided_at, outcome, label_id, top_label, decider, unsure_reason, probabilities, suspicious,
     bulk, EXISTS (SELECT 1 FROM review r WHERE r.message_id = decisions.message_id), model, versions, dmarc, sender_domain, subject, sender, summary,
     content_cleared, current_labels, verdict, verdict_label, verdict_source, verdict_at
   FROM decisions`,
  `DROP TABLE decisions`,
  `ALTER TABLE decisions_v5 RENAME TO decisions`,
  `CREATE INDEX IF NOT EXISTS decisions_thread ON decisions (thread_id)`,
  `CREATE INDEX IF NOT EXISTS decisions_time ON decisions (decided_at)`,
  `CREATE INDEX IF NOT EXISTS decisions_sender ON decisions (sender_hash, decided_at)`,
  `DROP TABLE IF EXISTS labels_v5`,
  `CREATE TABLE labels_v5 (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    display_name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0,
    trust INTEGER NOT NULL DEFAULT 0,
    gmail_id TEXT,
    gmail_state TEXT NOT NULL CHECK (gmail_state IN ('pending', 'linked', 'missing')),
    desc_version INTEGER NOT NULL DEFAULT 1,
    create_time INTEGER NOT NULL,
    update_time INTEGER NOT NULL,
    etag TEXT NOT NULL,
    keep_in_inbox INTEGER NOT NULL DEFAULT 0,
    sensitive INTEGER NOT NULL DEFAULT 0,
    gmail_adopted INTEGER NOT NULL DEFAULT 0,
    gmail_name_taken INTEGER NOT NULL DEFAULT 0
  )`,
  `INSERT INTO labels_v5 (id, seq, display_name, description, enabled, trust, gmail_id, gmail_state, desc_version, create_time, update_time, etag, keep_in_inbox,
     sensitive, gmail_adopted, gmail_name_taken)
   SELECT id, seq, display_name, description, enabled, trust, gmail_id, gmail_state, desc_version, create_time, update_time, etag, keep_in_inbox,
     sensitive, gmail_adopted, gmail_name_taken
   FROM labels`,
  `DROP TABLE labels`,
  `ALTER TABLE labels_v5 RENAME TO labels`,
  `DELETE FROM review WHERE state = 'pending' AND kind != 'unsure'`,
  // The replay evaluation (replay.ts): one row for the job itself (message_id ''), one per mail it decides again.
  `CREATE TABLE IF NOT EXISTS replay (
    job_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'pending', 'evaluated', 'skipped')),
    owner_label TEXT,
    as_of INTEGER NOT NULL DEFAULT 0,
    outcome TEXT,
    label TEXT,
    reason TEXT NOT NULL DEFAULT '',
    shown INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    create_time INTEGER NOT NULL,
    done_time INTEGER,
    PRIMARY KEY (job_id, message_id)
  ) WITHOUT ROWID`,
  `DELETE FROM meta WHERE key = 'revoked_at'`,
];

export type Value = string | number | null | ArrayBuffer;

export interface RowMeter {
  read: number;
  written: number;
}

export interface LabelRow extends Record<string, SqlStorageValue> {
  id: string;
  seq: number;
  display_name: string;
  description: string;
  enabled: number;
  trust: number;
  gmail_id: string | null;
  gmail_state: 'pending' | 'linked' | 'missing';
  desc_version: number;
  create_time: number;
  update_time: number;
  etag: string;
  /** 1: the label is added without removing INBOX. */
  keep_in_inbox: number;
  /** 1: no example of it is kept. */
  sensitive: number;
  /** 1: linked to a Gmail label of its path that mailsort did not create (adopted). */
  gmail_adopted: number;
  /** 1: pending, and Gmail has a label of its path that is not its own (the owner's): nothing is written with it. */
  gmail_name_taken: number;
}

export type Outcome = 'applied' | 'suggested' | 'none' | 'unsure' | 'skipped';

export interface DecisionRow extends Record<string, SqlStorageValue> {
  message_id: string;
  thread_id: string;
  received_at: number;
  decided_at: number;
  /** applied: written to Gmail; suggested: a confident label only recorded; none: confident that no label fits. */
  outcome: Outcome;
  /** The confident label (applied or suggested). */
  label_id: string | null;
  /** The decided label, or an uncertain decision's most likely label. */
  top_label: string | null;
  decider: string;
  unsure_reason: string;
  /** JSON: the first view's probabilities by label ID and `none`; the second view's, `{}` when it did not run. */
  probabilities: string;
  probabilities2: string;
  /** The higher of the two views' answers. */
  suspicious: number | null;
  bulk: number | null;
  needs_action: number | null;
  /** The top option's combined probability (decide.ts). */
  confidence: number | null;
  /** 1: the mail was shown in the review queue. */
  shown: number;
  model: string;
  versions: string;
  /** 1: DMARC passed aligned with the From domain (authenticated). */
  dmarc: number;
  /** The From address as a keyed hash (mask.ts senderHash): the sender history, never the address. */
  sender_hash: string | null;
  /** The From domain, kept with the content (14 days): a review choice may make it a trusted domain. */
  sender_domain: string | null;
  subject: string | null;
  sender: string | null;
  summary: string | null;
  content_cleared: number;
  current_labels: string;
  verdict: 'confirmed' | 'corrected' | 'weak' | null;
  verdict_label: string | null;
  verdict_source: string | null;
  verdict_at: number | null;
}

export interface ReviewRow extends Record<string, SqlStorageValue> {
  id: string;
  message_id: string;
  /** Only `unsure` since schema version 5; resolved items of the other kinds stay their 14 days. */
  kind: 'suggestion' | 'unsure' | 'audit';
  state: 'pending' | 'confirmed' | 'corrected' | 'skipped';
  suggested_label: string | null;
  candidates: string;
  decider: string;
  unsure_reason: string;
  resolved_label: string | null;
  subject: string;
  sender: string;
  receive_time: number;
  create_time: number;
  resolve_time: number | null;
}

export interface ExampleRow extends Record<string, SqlStorageValue> {
  id: string;
  label_id: string;
  summary: string;
  origin: 'correction' | 'confirmation' | 'weak_accept';
  message_id: string | null;
  embedding: ArrayBuffer | null;
  create_time: number;
}

export type LedgerState = 'intended' | 'applied' | 'failed' | 'undo_intended' | 'undone';

export interface LedgerRow extends Record<string, SqlStorageValue> {
  id: string;
  message_id: string;
  label_id: string;
  gmail_label_id: string | null;
  archived: number;
  origin: 'auto' | 'owner';
  state: LedgerState;
  attempts: number;
  last_code: string | null;
  superseded: number;
  create_time: number;
  apply_time: number | null;
  undo_time: number | null;
  /** JSON array of the mail's user label IDs when the intent was recorded. */
  base_labels: string;
}

export interface UsageRow extends Record<string, SqlStorageValue> {
  day: string;
  gmail_calls: number;
  ai_calls: number;
  neurons: number;
  decided: number;
  applied: number;
  unsure: number;
  quota_exhausted: number;
}

export type UsageField = 'gmail_calls' | 'ai_calls' | 'neurons' | 'decided' | 'applied' | 'unsure' | 'quota_exhausted';

/** The UTC day of `ms`, `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class Store {
  private meter: RowMeter = { read: 0, written: 0 };
  private readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  /**
   * Brings the schema to SCHEMA_VERSION inside `transact` (the object's transactionSync), so a migration cut short
   * changes nothing. `senderHashes` are the hashes version 5 stores for the decisions that still hold an address
   * (senderHashesToBackfill, read before, since hashing is asynchronous).
   */
  migrate(transact: <T>(fn: () => T) => T = (fn) => fn(), senderHashes: ReadonlyMap<string, string> = new Map()): void {
    transact(() => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      const version = this.schemaVersion();
      if (version < 1) for (const statement of SCHEMA_V1) this.sql.exec(statement);
      if (version < 2) for (const statement of SCHEMA_V2) this.sql.exec(statement);
      if (version < 3) for (const statement of SCHEMA_V3) this.sql.exec(statement);
      if (version < 4) for (const statement of SCHEMA_V4) this.sql.exec(statement);
      if (version < 5) {
        for (const statement of SCHEMA_V5) this.sql.exec(statement);
        for (const [messageId, hash] of senderHashes) this.sql.exec(`UPDATE decisions SET sender_hash = ? WHERE message_id = ? AND sender_hash IS NULL`, hash, messageId);
      }
      if (version !== SCHEMA_VERSION) this.setMeta('schema_version', String(SCHEMA_VERSION));
    });
  }

  /** The stored schema version (0 for a new database whose meta table was just created). */
  schemaVersion(): number {
    return Number(this.getMeta('schema_version') ?? 0);
  }

  takeMeter(): RowMeter {
    const taken = this.meter;
    this.meter = { read: 0, written: 0 };
    return taken;
  }

  addMeter(meter: RowMeter): void {
    this.meter.read += meter.read;
    this.meter.written += meter.written;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  private exec<T extends Record<string, SqlStorageValue>>(query: string, params: readonly Value[]): { rows: T[]; written: number } {
    const cursor = this.sql.exec<T>(query, ...params);
    const rows = cursor.toArray();
    this.meter.read += cursor.rowsRead;
    this.meter.written += cursor.rowsWritten;
    return { rows, written: cursor.rowsWritten };
  }

   
  all<T extends Record<string, SqlStorageValue>>(query: string, ...params: Value[]): T[] {
    return this.exec<T>(query, params).rows;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  one<T extends Record<string, SqlStorageValue>>(query: string, ...params: Value[]): T | undefined {
    return this.all<T>(query, ...params)[0];
  }

  run(query: string, ...params: Value[]): number {
    return this.exec(query, params).written;
  }

  count(query: string, ...params: Value[]): number {
    return this.one<{ n: number }>(query, ...params)?.n ?? 0;
  }

  // ---- meta ----------------------------------------------------------------------------------------------------------

  getMeta(key: string): string | null {
    return this.one<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
  }

  deleteMeta(...keys: string[]): void {
    for (const key of keys) this.run(`DELETE FROM meta WHERE key = ?`, key);
  }

  /** The newest few error codes (newest first). */
  errors(): string[] {
    try {
      const value: unknown = JSON.parse(this.getMeta('recent_errors') ?? '[]');
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  pushError(code: string): void {
    const codes = [code, ...this.errors().filter((item) => item !== code)].slice(0, ERRORS_KEPT);
    this.setMeta('recent_errors', JSON.stringify(codes));
  }

  // ---- usage -----------------------------------------------------------------------------------------------------------

  usage(day: string): UsageRow {
    return this.one<UsageRow>(`SELECT * FROM usage WHERE day = ?`, day) ?? { day, gmail_calls: 0, ai_calls: 0, neurons: 0, decided: 0, applied: 0, unsure: 0, quota_exhausted: 0 };
  }

  addUsage(day: string, field: UsageField, amount: number): void {
    this.run(`INSERT INTO usage (day, ${field}) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET ${field} = ${field} + excluded.${field}`, day, amount);
  }

  setQuotaExhausted(day: string): void {
    this.run(`INSERT INTO usage (day, quota_exhausted) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET quota_exhausted = 1`, day);
  }

  // ---- labels -----------------------------------------------------------------------------------------------------------

  labels(): LabelRow[] {
    return this.all<LabelRow>(`SELECT * FROM labels ORDER BY seq`);
  }

  label(id: string): LabelRow | undefined {
    return this.one<LabelRow>(`SELECT * FROM labels WHERE id = ?`, id);
  }

  labelByGmailId(gmailId: string): LabelRow | undefined {
    return this.one<LabelRow>(`SELECT * FROM labels WHERE gmail_id = ? AND gmail_state = 'linked'`, gmailId);
  }

  /** Gmail IDs of the linked labels (the guard's owned set). */
  ownedGmailIds(): Set<string> {
    return new Set(this.all<{ gmail_id: string }>(`SELECT gmail_id FROM labels WHERE gmail_state = 'linked' AND gmail_id IS NOT NULL`).map((row) => row.gmail_id));
  }

  touchLabel(id: string, now: number): void {
    this.run(`UPDATE labels SET update_time = ?, etag = ? WHERE id = ?`, now, newEtag(now), id);
  }

  exampleCounts(): Map<string, number> {
    return new Map(this.all<{ label_id: string; n: number }>(`SELECT label_id, count(*) AS n FROM examples GROUP BY label_id`).map((row) => [row.label_id, row.n]));
  }

  // ---- trusted domains ------------------------------------------------------------------------------------------------

  /** A label's trusted domains, sorted. */
  trustedDomains(labelId: string): string[] {
    return this.all<{ domain: string }>(`SELECT domain FROM trusted_domains WHERE label_id = ? ORDER BY domain`, labelId).map((row) => row.domain);
  }

  /** Every label's trusted domains (one read), each list sorted. */
  allTrustedDomains(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const row of this.all<{ label_id: string; domain: string }>(`SELECT label_id, domain FROM trusted_domains ORDER BY label_id, domain`)) {
      out.set(row.label_id, [...(out.get(row.label_id) ?? []), row.domain]);
    }
    return out;
  }

  /** Whether `domain` is one of the label's trusted domains or a subdomain of one (`a.bank.example.com` of `bank.example.com`). */
  isTrusted(labelId: string, domain: string): boolean {
    const suffixes = domainSuffixes(domain.toLowerCase());
    if (suffixes.length === 0) return false;
    return this.one(`SELECT 1 AS x FROM trusted_domains WHERE label_id = ? AND domain IN (${suffixes.map(() => '?').join(', ')})`, labelId, ...suffixes) !== undefined;
  }

  /**
   * Adds a trusted domain the owner's choice taught (origin `owner`); the label's oldest goes first past
   * TRUSTED_DOMAINS_PER_LABEL_MAX. Answers whether it was new. Run inside a transaction.
   */
  addTrustedDomain(labelId: string, domain: string, now: number): boolean {
    const added = this.run(`INSERT OR IGNORE INTO trusted_domains (label_id, domain, origin, create_time) VALUES (?, ?, 'owner', ?)`, labelId, domain, now) > 0;
    const over = this.count(`SELECT count(*) AS n FROM trusted_domains WHERE label_id = ?`, labelId) - TRUSTED_DOMAINS_PER_LABEL_MAX;
    if (over > 0) this.run(`DELETE FROM trusted_domains WHERE label_id = ? AND domain IN (SELECT domain FROM trusted_domains WHERE label_id = ? ORDER BY create_time, domain LIMIT ?)`, labelId, labelId, over);
    return added;
  }

  // ---- pending ----------------------------------------------------------------------------------------------------------

  enqueue(messageId: string, now: number): void {
    this.run(`INSERT OR IGNORE INTO pending (message_id, added_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM decisions WHERE message_id = ?)`, messageId, now, messageId);
  }

  due(now: number, limit: number): { message_id: string; attempts: number }[] {
    return this.all<{ message_id: string; attempts: number }>(`SELECT message_id, attempts FROM pending WHERE not_before <= ? ORDER BY not_before, added_at LIMIT ?`, now, limit);
  }

  /** IDs a new label may not take: the labels' own and those of deleted labels (retired_labels). */
  takenLabelIds(): Set<string> {
    return new Set(this.all<{ id: string }>(`SELECT id FROM labels UNION SELECT id FROM retired_labels`).map((row) => row.id));
  }

  /** Paths of every label (the tree rule: paths.ts treeConflict). */
  labelPaths(exceptId = ''): string[] {
    return this.all<{ display_name: string }>(`SELECT display_name FROM labels WHERE id != ?`, exceptId).map((row) => row.display_name);
  }

  // ---- decisions ---------------------------------------------------------------------------------------------------------

  decision(messageId: string): DecisionRow | undefined {
    return this.one<DecisionRow>(`SELECT * FROM decisions WHERE message_id = ?`, messageId);
  }

  // ---- review ------------------------------------------------------------------------------------------------------------

  review(id: string): ReviewRow | undefined {
    return this.one<ReviewRow>(`SELECT * FROM review WHERE id = ?`, id);
  }

  pendingReviewOf(messageId: string): ReviewRow | undefined {
    return this.one<ReviewRow>(`SELECT * FROM review WHERE message_id = ? AND state = 'pending' ORDER BY id DESC LIMIT 1`, messageId);
  }

  // ---- ledger ------------------------------------------------------------------------------------------------------------

  ledgerRow(id: string): LedgerRow | undefined {
    return this.one<LedgerRow>(`SELECT * FROM ledger WHERE id = ?`, id);
  }

  /** The newest ledger row that adds `labelId` (a Gmail label ID) to `messageId`. */
  ledgerFor(messageId: string, gmailLabelId: string): LedgerRow | undefined {
    return this.one<LedgerRow>(`SELECT * FROM ledger WHERE message_id = ? AND gmail_label_id = ? ORDER BY create_time DESC, id DESC LIMIT 1`, messageId, gmailLabelId);
  }

  // ---- the request log (AIP-155) -------------------------------------------------------------------------------------------

  request(requestId: string, now: number): { rpc: string; resource: string; response: string } | undefined {
    return this.one<{ rpc: string; resource: string; response: string }>(`SELECT rpc, resource, response FROM requests WHERE request_id = ? AND at > ?`, requestId, now - REQUEST_ID_TTL_MS);
  }

  putRequest(requestId: string, rpc: string, resource: string, response: string, now: number): void {
    this.run(`INSERT OR REPLACE INTO requests (request_id, rpc, resource, response, at) VALUES (?, ?, ?, ?, ?)`, requestId, rpc, resource, response, now);
  }

  // ---- retention -----------------------------------------------------------------------------------------------------------

  /** The daily cleanup: content older than CONTENT_KEPT_MS, records older than DECISIONS_KEPT_MS, old request IDs. */
  prune(now: number): void {
    const content = now - CONTENT_KEPT_MS;
    this.run(
      `UPDATE decisions SET subject = NULL, sender = NULL, summary = NULL, sender_domain = NULL, content_cleared = 1 WHERE content_cleared = 0 AND decided_at < ?`,
      content,
    );
    // A mail queued late (a deferral, a backoff) still loses its content 14 days after it came.
    this.run(`DELETE FROM review WHERE create_time < ? OR receive_time < ?`, content, content);
    const records = now - DECISIONS_KEPT_MS;
    this.run(`DELETE FROM decisions WHERE decided_at < ?`, records);
    this.run(`DELETE FROM ledger WHERE create_time < ? AND state IN ('applied', 'failed', 'undone')`, records);
    this.run(`DELETE FROM usage WHERE day < ?`, utcDay(now - FLOW_KEPT_DAYS * DAY));
    this.run(`DELETE FROM flow WHERE day < ?`, utcDay(now - FLOW_KEPT_DAYS * DAY));
    // A retired ID is free again once neither the decisions nor the flow counters can still name it.
    this.run(`DELETE FROM retired_labels WHERE retire_time < ?`, now - Math.max(DECISIONS_KEPT_MS, (FLOW_KEPT_DAYS + 1) * DAY));
    this.run(`DELETE FROM requests WHERE at < ?`, now - REQUEST_ID_TTL_MS);
    this.run(`DELETE FROM replay WHERE create_time < ?`, now - REPLAY_KEPT_MS);
  }
}

/**
 * Before schema version 5: the sender hashes (mask.ts senderHash) of the decisions whose exact address is still kept
 * (14 days of content), which version 5 stores in place of the addresses, so the sender history and the replay
 * evaluation see the mail of the last two weeks. Empty from version 5 on and for a new database.
 */
export async function senderHashesToBackfill(store: Store): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  store.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const version = store.schemaVersion();
  if (version < 1 || version >= 5) return out;
  const rows = store.all<{ message_id: string; sender_address: string }>(`SELECT message_id, sender_address FROM decisions WHERE sender_address IS NOT NULL AND sender_address != ''`);
  for (const row of rows) out.set(row.message_id, await senderHash(row.sender_address));
  return out;
}

/** `a.b.example.com` -> [a.b.example.com, b.example.com, example.com] (a trusted domain covers its subdomains). */
export function domainSuffixes(domain: string): string[] {
  const parts = domain.split('.').filter((part) => part !== '');
  const out: string[] = [];
  for (let i = 0; i + 2 <= parts.length && out.length < 6; i++) out.push(parts.slice(i).join('.'));
  return out;
}
