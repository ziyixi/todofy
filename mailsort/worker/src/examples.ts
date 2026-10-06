/**
 * The example store (../../docs/design.md §6.2): the owner's corrected and confirmed mails as short masked summaries
 * with bge-m3 embeddings, in MailsortState's SQLite. Retrieval is brute force: cosine similarity against every embedded
 * example (at most EXAMPLES_MAX, 1024 floats each), which is a few milliseconds of the alarm's 30 s. The vectors are
 * kept in memory between alarms and reloaded when the store's version changes.
 */
import { cosine, fromBlob } from './ai.ts';
import { EXAMPLES_MAX, EXAMPLES_PER_LABEL_MAX } from './limits.ts';
import { timeId } from './ids.ts';
import type { ExampleRow, Store } from './store.ts';

export interface Neighbour {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
  readonly similarity: number;
}

interface Loaded {
  readonly version: string;
  readonly items: readonly { id: string; label: string; summary: string; vector: Float32Array }[];
}

let cache: Loaded | null = null;

/** Bumped by every write to the examples (the in-memory vectors then reload). */
function bump(store: Store): void {
  store.setMeta('examples_version', String(Number(store.getMeta('examples_version') ?? '0') + 1));
}

export function embeddedCount(store: Store): number {
  return store.count(`SELECT count(*) AS n FROM examples WHERE embedding IS NOT NULL`);
}

/** The `k` nearest embedded examples of enabled labels to `vector`, the most similar first. */
export function nearest(store: Store, vector: Float32Array, k: number, labels: ReadonlySet<string>): Neighbour[] {
  const version = store.getMeta('examples_version') ?? '0';
  if (cache?.version !== version) {
    const items = store
      .all<Pick<ExampleRow, 'id' | 'label_id' | 'summary' | 'embedding'>>(`SELECT id, label_id, summary, embedding FROM examples WHERE embedding IS NOT NULL`)
      .flatMap((row) => {
        const v = row.embedding === null ? null : fromBlob(row.embedding);
        return v === null ? [] : [{ id: row.id, label: row.label_id, summary: row.summary, vector: v }];
      });
    cache = { version, items };
  }
  return cache.items
    .filter((item) => labels.has(item.label))
    .map((item) => ({ id: item.id, label: item.label, summary: item.summary, similarity: cosine(vector, item.vector) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

/**
 * Makes (or moves) the example of `messageId`: label `labelId`, the summary kept. An existing one keeps its embedding
 * (it embeds the summary, not the label). Bounded: past EXAMPLES_PER_LABEL_MAX for the label, or EXAMPLES_MAX in all, the
 * oldest weak accept goes first, then the oldest example. A sensitive label keeps none: its mail's summary would
 * otherwise outlive the 14 days of content (an example moved to it is deleted).
 */
export function putExample(store: Store, messageId: string, labelId: string, summary: string, origin: ExampleRow['origin'], now: number): void {
  if (store.label(labelId)?.sensitive === 1) {
    deleteExampleOf(store, messageId);
    return;
  }
  const existing = store.one<{ id: string }>(`SELECT id FROM examples WHERE message_id = ?`, messageId);
  if (existing !== undefined) {
    store.run(`UPDATE examples SET label_id = ?, origin = ? WHERE id = ?`, labelId, origin, existing.id);
  } else {
    store.run(`INSERT INTO examples (id, label_id, summary, origin, message_id, create_time) VALUES (?, ?, ?, ?, ?, ?)`, timeId(now), labelId, summary, origin, messageId, now);
  }
  const trim = (where: string, max: number, ...params: string[]) => {
    const over = store.count(`SELECT count(*) AS n FROM examples ${where}`, ...params) - max;
    if (over > 0) {
      store.run(
        `DELETE FROM examples WHERE id IN (SELECT id FROM examples ${where} ORDER BY origin = 'weak_accept' DESC, id LIMIT ?)`,
        ...params,
        over,
      );
    }
  };
  trim('WHERE label_id = ?', EXAMPLES_PER_LABEL_MAX, labelId);
  trim('', EXAMPLES_MAX);
  bump(store);
}

export function deleteExampleOf(store: Store, messageId: string): void {
  if (store.run(`DELETE FROM examples WHERE message_id = ?`, messageId) > 0) bump(store);
}

export function deleteExample(store: Store, id: string): boolean {
  const deleted = store.run(`DELETE FROM examples WHERE id = ?`, id) > 0;
  if (deleted) bump(store);
  return deleted;
}

export function deleteExamplesOfLabel(store: Store, labelId: string): void {
  if (store.run(`DELETE FROM examples WHERE label_id = ?`, labelId) > 0) bump(store);
}

/** Drops every embedding (RebuildExampleEmbeddings): the alarm embeds them again. */
export function dropEmbeddings(store: Store): number {
  store.run(`UPDATE examples SET embedding = NULL WHERE embedding IS NOT NULL`);
  bump(store);
  return store.count(`SELECT count(*) AS n FROM examples WHERE embedding IS NULL`);
}

export function unembedded(store: Store, limit: number): { id: string; summary: string }[] {
  return store.all<{ id: string; summary: string }>(`SELECT id, summary FROM examples WHERE embedding IS NULL ORDER BY id LIMIT ?`, limit);
}

export function storeEmbedding(store: Store, id: string, blob: ArrayBuffer): void {
  store.run(`UPDATE examples SET embedding = ? WHERE id = ?`, blob, id);
  bump(store);
}
