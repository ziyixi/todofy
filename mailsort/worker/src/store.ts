/**
 * MailsortState's SQLite storage (../../docs/design.md §6): labels, rules, the pending queue, decisions, the review
 * queue, examples with their embeddings, the ledger of Gmail writes, the daily usage, the feedback queue and the AIP-155
 * request log, in the Durable Object's own database. No D1, no R2, no KV. Synchronous (the Durable Object's SQL API),
 * so the writes of one `transactionSync` are atomic: the history cursor advances in the same transaction that queues
 * the mails it covers.
 *
 * Every table is bounded (limits.ts): LABELS_MAX labels, RULES_MAX rules, EXAMPLES_MAX examples; decisions and the
 * ledger for DECISIONS_KEPT_MS, their content (subject, sender, summary, the exact sender keys) and the review queue for
 * CONTENT_KEPT_MS; request IDs for a day. `prune` runs once per UTC day.
 *
 * Nothing here logs. Rows hold the owner's personal data (subjects, senders, rule values); they leave the object only
 * through the owner API behind Access, and the masked text only to Workers AI.
 */
import { newEtag } from './ids.ts';
import { CONTENT_KEPT_MS, DAY, DECISIONS_KEPT_MS, ERRORS_KEPT, REQUEST_ID_TTL_MS } from './limits.ts';

export const SCHEMA_VERSION = 1;

const SCHEMA_V1 = [
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
    undo_time INTEGER
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
  live: number;
  trust: number;
  threshold: number;
  gmail_id: string | null;
  gmail_state: 'pending' | 'linked' | 'missing';
  desc_version: number;
  live_since: number | null;
  create_time: number;
  update_time: number;
  etag: string;
}

export interface RuleRow extends Record<string, SqlStorageValue> {
  id: string;
  kind: 'sender_address' | 'sender_domain' | 'list_id' | 'delivered_to';
  value: string;
  label_id: string;
  state: 'proposed' | 'active' | 'disabled';
  correction_count: number;
  match_count: number;
  create_time: number;
  update_time: number;
}

export interface DecisionRow extends Record<string, SqlStorageValue> {
  message_id: string;
  thread_id: string;
  received_at: number;
  decided_at: number;
  outcome: 'applied' | 'suggested' | 'unsure' | 'skipped';
  label_id: string | null;
  top_label: string | null;
  decider: string;
  unsure_reason: string;
  probabilities: string;
  suspicious: number | null;
  bulk: number | null;
  model: string;
  versions: string;
  dmarc: number;
  sender_address: string | null;
  sender_domain: string | null;
  list_id: string | null;
  delivered_to: string | null;
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

  migrate(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const version = Number(this.getMeta('schema_version') ?? 0);
    if (version < 1) for (const statement of SCHEMA_V1) this.sql.exec(statement);
    if (version !== SCHEMA_VERSION) this.setMeta('schema_version', String(SCHEMA_VERSION));
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

  // ---- rules ------------------------------------------------------------------------------------------------------------

  rule(id: string): RuleRow | undefined {
    return this.one<RuleRow>(`SELECT * FROM rules WHERE id = ?`, id);
  }

  /** The active rules a mail's keys match (each key through rules_match). */
  matchingRules(keys: { senderAddress: string; senderDomain: string; listId: string; deliveredTo: string }): RuleRow[] {
    const domains = domainSuffixes(keys.senderDomain);
    const out: RuleRow[] = [];
    if (keys.senderAddress !== '') out.push(...this.all<RuleRow>(`SELECT * FROM rules WHERE state = 'active' AND kind = 'sender_address' AND value = ?`, keys.senderAddress));
    for (const domain of domains) out.push(...this.all<RuleRow>(`SELECT * FROM rules WHERE state = 'active' AND kind = 'sender_domain' AND value = ?`, domain));
    if (keys.listId !== '') out.push(...this.all<RuleRow>(`SELECT * FROM rules WHERE state = 'active' AND kind = 'list_id' AND value = ?`, keys.listId));
    if (keys.deliveredTo !== '') out.push(...this.all<RuleRow>(`SELECT * FROM rules WHERE state = 'active' AND kind = 'delivered_to' AND value = ?`, keys.deliveredTo));
    return out;
  }

  // ---- pending ----------------------------------------------------------------------------------------------------------

  enqueue(messageId: string, now: number): void {
    this.run(`INSERT OR IGNORE INTO pending (message_id, added_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM decisions WHERE message_id = ?)`, messageId, now, messageId);
  }

  due(now: number, limit: number): { message_id: string; attempts: number }[] {
    return this.all<{ message_id: string; attempts: number }>(`SELECT message_id, attempts FROM pending WHERE not_before <= ? ORDER BY not_before, added_at LIMIT ?`, now, limit);
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
      `UPDATE decisions SET subject = NULL, sender = NULL, summary = NULL, sender_address = NULL, sender_domain = NULL, list_id = NULL, delivered_to = NULL, content_cleared = 1
       WHERE content_cleared = 0 AND decided_at < ?`,
      content,
    );
    this.run(`DELETE FROM review WHERE create_time < ?`, content);
    const records = now - DECISIONS_KEPT_MS;
    this.run(`DELETE FROM decisions WHERE decided_at < ?`, records);
    this.run(`DELETE FROM ledger WHERE create_time < ? AND state IN ('applied', 'failed', 'undone')`, records);
    this.run(`DELETE FROM usage WHERE day < ?`, utcDay(now - 400 * DAY));
    this.run(`DELETE FROM requests WHERE at < ?`, now - REQUEST_ID_TTL_MS);
  }
}

/** `a.b.example.com` -> [a.b.example.com, b.example.com, example.com] (a domain rule matches subdomains). */
export function domainSuffixes(domain: string): string[] {
  const parts = domain.split('.').filter((part) => part !== '');
  const out: string[] = [];
  for (let i = 0; i + 2 <= parts.length && out.length < 6; i++) out.push(parts.slice(i).join('.'));
  return out;
}
