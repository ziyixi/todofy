/** SQLite-backed bounded control storage, independent of provider and UI fixtures. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ATTENTION_ROW_LIMIT, ATTENTION_SCHEMA, AttentionState } from '../src/attention-state.ts';
import type { Attention, AttentionItem } from '../src/api-types.ts';

const NOW = Date.parse('2026-10-03T12:00:00Z');
function fixture() {
  const database = new DatabaseSync(':memory:'); database.exec(ATTENTION_SCHEMA);
  const rows = <T extends Record<string, SqlStorageValue>>(query: string, ...values: SqlStorageValue[]): T[] =>
    database.prepare(query).all(...values as SQLInputValue[]) as T[];
  const storage = { sql: { exec: (query: string, ...values: SqlStorageValue[]) => {
    const result = rows(query, ...values); return { toArray: () => result };
  } } } as unknown as DurableObjectStorage;
  return { database, ledger: new AttentionState(storage, rows) };
}
const item = (code: string): AttentionItem => ({ source: 'newsletter', code, severity: 'warning', since: null, metrics: {}, target: { view: 'ops', entry: 'newsletter' } });
const attention = (items: AttentionItem[]): Attention => ({ level: 'warning', items, info: [], held: [] });
function controlled(entry: AttentionItem | undefined): AttentionItem & { name: string; etag: string } {
  if (!entry?.name || !entry.etag) throw new Error('missing synthetic revision');
  return entry as AttentionItem & { name: string; etag: string };
}

describe('bounded reminder dispositions', () => {
  it('does not confuse unknown codes with Object prototype properties', () => {
    const { database, ledger } = fixture();
    try {
      const result = ledger.project(attention([item('constructor'), item('toString')]), NOW, () => false);
      expect(result.attention.items).toHaveLength(2);
      expect(result.attention.items.every((entry) => entry.name && entry.etag)).toBe(true);
    } finally { database.close(); }
  });

  it('retires only absent undismissed rows and keeps an absent owner decision under pressure', () => {
    const { database, ledger } = fixture();
    try {
      const initial = Array.from({ length: ATTENTION_ROW_LIMIT }, (_unused, index) => item(`old_${String(index)}`));
      const result = ledger.project(attention(initial), NOW, () => false);
      const old = controlled(result.attention.items[0]);
      const closed = ledger.change(old.name, old.etag, true, NOW);
      ledger.project(attention([item('new_condition')]), NOW, () => false);
      const returned = ledger.project(attention([old, item('new_condition')]), NOW, () => false);
      expect(returned.attention.dismissed_items?.[0]?.etag).toBe(closed?.etag);
      expect(returned.attention.items.find((entry) => entry.code === 'new_condition')?.etag).toBeDefined();
      expect(database.prepare('SELECT count(*) n FROM attention_occurrences').get()?.n).toBe(ATTENTION_ROW_LIMIT);
    } finally { database.close(); }
  });

  it('the 257th current condition stays visible with explicit control degradation', () => {
    const { database, ledger } = fixture();
    try {
      const initial = Array.from({ length: ATTENTION_ROW_LIMIT }, (_unused, index) => item(`current_${String(index)}`));
      const result = ledger.project(attention(initial), NOW, () => false);
      for (const entry of result.attention.items) { const current = controlled(entry); ledger.change(current.name, current.etag, true, NOW); }
      const overflow = ledger.project(attention([...initial, item('one_more')]), NOW, () => false);
      expect(overflow.attention.items).toMatchObject([{ code: 'one_more' }]);
      expect(overflow.attention.dismissed_items).toHaveLength(ATTENTION_ROW_LIMIT);
      expect(overflow.attention.control_unavailable_count).toBe(1);
      expect(database.prepare('SELECT count(*) n FROM attention_occurrences').get()?.n).toBe(ATTENTION_ROW_LIMIT);
    } finally { database.close(); }
  });
});
