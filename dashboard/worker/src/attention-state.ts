/** Home-owned reminder dispositions. These never change a source's health or business ledger. */
import type { Attention, AttentionItem, Badges, Target } from './api-types.ts';
import { rollupAttention } from './attention-rollup.ts';
import { iso } from './time.ts';
import type { AttentionOccurrence } from '@ziyixi/proto/dashboard/mcp/v1/home_service_wire';

export const ATTENTION_ROW_LIMIT = 256;
export const ATTENTION_SCHEMA = `CREATE TABLE IF NOT EXISTS attention_occurrences (
  key TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, source TEXT NOT NULL, code TEXT NOT NULL,
  target TEXT NOT NULL, signature TEXT NOT NULL, etag TEXT NOT NULL, dismissed_at INTEGER,
  occurrence_seq INTEGER NOT NULL DEFAULT 0
)`;

/** Existing episodes receive their first sequence on the next projection, in the same bounded pass. */
export function migrateAttentionSequence(storage: DurableObjectStorage): void {
  const columns = storage.sql.exec<{ name: string }>('PRAGMA table_info(attention_occurrences)').toArray();
  if (!columns.some((column) => column.name === 'occurrence_seq')) {
    storage.sql.exec('ALTER TABLE attention_occurrences ADD COLUMN occurrence_seq INTEGER NOT NULL DEFAULT 0');
  }
}

interface OccurrenceRow extends Record<string, SqlStorageValue> {
  key: string; name: string; source: string; code: string; target: string;
  signature: string; etag: string; dismissed_at: number | null; occurrence_seq: number;
}
export interface AttentionCondition { readonly source: string; readonly code: string; readonly target: Target }
type ReadRows = <T extends Record<string, SqlStorageValue>>(query: string, ...values: SqlStorageValue[]) => T[];

/** Include the stable target so two scripts with the same code are distinct conditions. */
export function attentionKey(item: AttentionCondition): string {
  const target = item.target;
  return JSON.stringify([item.source, item.code, target.view, target.flow ?? '', target.stage ?? '', target.entry ?? '', target.script ?? '']);
}
export function attentionName(item: AttentionCondition): string {
  const bytes = new TextEncoder().encode(attentionKey(item));
  const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (encoded.length > 512) throw new Error('attention_identity_limit');
  return `attentionItems/${encoded}`;
}

/** Duration/usage metrics fluctuate inside an episode. Only an explicit semantic count changes it. */
const CONDITION_METRICS: Readonly<Record<string, readonly string[]>> = {
  newsletter_unknown: ['unknown_count'], newsletter_side_effect_unknown: ['count'],
  parse_failed: ['count'], delivery_failed: ['count'], policy_error: ['count'],
  notify_unsettled: ['open', 'failed'], watches_broken: ['count'],
};
/** Newsletter record batches: a new revision means new records, a lower count alone does not. */
export const NEWSLETTER_BATCH_CODES: readonly string[] = ['newsletter_unknown', 'newsletter_side_effect_unknown'];
function signature(item: AttentionItem): string {
  const fields = Object.hasOwn(CONDITION_METRICS, item.code) ? CONDITION_METRICS[item.code] ?? [] : [];
  const counts = NEWSLETTER_BATCH_CODES.includes(item.code) && item.metrics.unknown_revision !== undefined
    ? [item.metrics.unknown_revision] : fields.map((key) => item.metrics[key] ?? null);
  const completedRun = (item.code.startsWith('canary_') || item.code === 'newsletter_delivery_rejected' || item.source === 'notion-publish') ? item.since : null;
  return JSON.stringify([item.severity, item.observed ?? null, counts, completedRun]);
}

export class AttentionState {
  private rows = new Map<string, OccurrenceRow>();
  private current = new Map<string, AttentionItem>();
  private readonly storage: DurableObjectStorage;
  private readonly readRows: ReadRows;
  constructor(storage: DurableObjectStorage, readRows: ReadRows) { this.storage = storage; this.readRows = readRows; }

  /** At most one row per condition. Absent data is not resolution: the caller supplies fresh evidence. */
  project(raw: Attention, now: number, resolved: (condition: AttentionCondition) => boolean): { attention: Attention; badges: Badges } {
    this.rows = new Map(this.readRows<OccurrenceRow>('SELECT * FROM attention_occurrences LIMIT ?', ATTENTION_ROW_LIMIT + 1).map((row) => [row.key, row]));
    const present = new Set(raw.items.map(attentionKey));
    for (const [key, row] of this.rows) {
      if (present.has(key) || !resolved({ source: row.source, code: row.code, target: JSON.parse(row.target) as Target })) continue;
      this.storage.sql.exec('DELETE FROM attention_occurrences WHERE key = ?', key);
      this.rows.delete(key);
    }
    this.current = new Map();
    const items: AttentionItem[] = [], dismissed: AttentionItem[] = [];
    let unavailable = 0;
    for (const item of raw.items) {
      const key = attentionKey(item), wanted = signature(item);
      let row = this.rows.get(key);
      if (row === undefined || row.signature !== wanted) {
        if (row === undefined && this.rows.size >= ATTENTION_ROW_LIMIT) {
          const retired = [...this.rows.values()].find((old) => !present.has(old.key) && old.dismissed_at === null);
          if (retired !== undefined) {
            this.storage.sql.exec('DELETE FROM attention_occurrences WHERE key=?', retired.key); this.rows.delete(retired.key);
          } else {
            items.push(item); unavailable++; continue;
          }
        }
        row = { key, name: attentionName(item), source: item.source, code: item.code, target: JSON.stringify(item.target), signature: wanted,
          etag: `a1-${crypto.randomUUID()}`, dismissed_at: null, occurrence_seq: this.nextSequence(now) };
        this.storage.sql.exec(`INSERT INTO attention_occurrences (key,name,source,code,target,signature,etag,dismissed_at,occurrence_seq)
          VALUES(?,?,?,?,?,?,?,NULL,?) ON CONFLICT(key) DO UPDATE SET signature=excluded.signature,
          etag=excluded.etag,dismissed_at=NULL,occurrence_seq=excluded.occurrence_seq`,
          row.key, row.name, row.source, row.code, row.target, row.signature, row.etag, row.occurrence_seq);
        this.rows.set(key, row);
      } else if (row.occurrence_seq === 0) {
        row.occurrence_seq = this.nextSequence(now);
        this.storage.sql.exec('UPDATE attention_occurrences SET occurrence_seq=? WHERE key=?', row.occurrence_seq, key);
      }
      const decorated: AttentionItem = { ...item, name: row.name, etag: row.etag,
        ...(row.dismissed_at === null ? {} : { dismissed_at: iso(row.dismissed_at) }) };
      this.current.set(row.name, decorated);
      (row.dismissed_at === null ? items : dismissed).push(decorated);
    }
    // Nothing to dispose of: the evaluation's level stands (unknown before the first run).
    const level = raw.items.length === 0 ? raw.level : rollupAttention(items);
    const badges: Record<keyof Badges, number> = { home: 0, flows: 0, cloudflare: 0, ops: 0 };
    for (const item of items) badges[item.target.view]++;
    return { attention: { ...raw, level, items, ...(dismissed.length > 0 ? { dismissed_items: dismissed } : {}),
      ...(unavailable > 0 ? { control_unavailable_count: unavailable } : {}) }, badges };
  }

  /** A stale occurrence can never dismiss a new issue. Repeating the same disposition is harmless. */
  change(name: string, etag: string, dismiss: boolean, now: number): AttentionItem | null {
    const item = this.current.get(name);
    if (item === undefined || item.etag !== etag) return null;
    const row = this.rows.get(attentionKey(item));
    if (row === undefined || row.etag !== etag) return null;
    const at = dismiss ? row.dismissed_at ?? now : null;
    if (row.dismissed_at !== at) {
      const nextEtag = `a1-${crypto.randomUUID()}`;
      this.storage.sql.exec('UPDATE attention_occurrences SET dismissed_at=?,etag=? WHERE key=? AND etag=?', at, nextEtag, row.key, etag);
      row.dismissed_at = at;
      row.etag = nextEtag;
    }
    const plain = { ...item }; delete plain.dismissed_at;
    const answer: AttentionItem = { ...plain, etag: row.etag, ...(at === null ? {} : { dismissed_at: iso(at) }) };
    this.current.set(name, answer);
    return answer;
  }

  isDismissed(item: AttentionCondition): boolean {
    return this.rows.get(attentionKey(item))?.dismissed_at != null;
  }

  /** Current projected episodes only; disposition changes never advance the creation cursor. */
  poll(after: number): { attention: AttentionOccurrence[]; head_seq: number } {
    const head = Number(this.readRows<{ doc: string }>("SELECT doc FROM state WHERE key='attention_sequence'")[0]?.doc ?? 0);
    if (!Number.isInteger(after) || after < 0 || after > head) throw new Error('invalid_input');
    const attention = [...this.current.values()].flatMap((item): AttentionOccurrence[] => {
      const row = this.rows.get(attentionKey(item));
      return row !== undefined && row.dismissed_at === null && row.occurrence_seq > after
        ? [{ occurrence_seq: row.occurrence_seq, item }] : [];
    }).sort((left, right) => left.occurrence_seq - right.occurrence_seq);
    return { attention, head_seq: head };
  }

  private nextSequence(now: number): number {
    const result = this.storage.sql.exec<{ doc: string }>(`INSERT INTO state (key,doc,updated_at)
      VALUES('attention_sequence','1',?) ON CONFLICT(key) DO UPDATE SET
      doc=CAST(CAST(doc AS INTEGER)+1 AS TEXT),updated_at=excluded.updated_at RETURNING doc`, now).toArray()[0];
    const sequence = Number(result?.doc);
    if (!Number.isInteger(sequence) || sequence < 1 || sequence > 2_147_483_647) throw new Error('attention_sequence_limit');
    return sequence;
  }
}
