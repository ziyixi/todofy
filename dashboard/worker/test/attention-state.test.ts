/** SQLite-backed bounded control storage, independent of provider and UI fixtures. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ATTENTION_ROW_LIMIT, ATTENTION_SCHEMA, AttentionState, migrateAttentionSequence } from '../src/attention-state.ts';
import type { Attention, AttentionItem } from '../src/api-types.ts';

const NOW = Date.parse('2026-10-03T12:00:00Z');
function fixture() {
  const database = new DatabaseSync(':memory:'); database.exec(ATTENTION_SCHEMA);
  database.exec('CREATE TABLE state (key TEXT PRIMARY KEY,doc TEXT NOT NULL,updated_at INTEGER NOT NULL)');
  const rows = <T extends Record<string, SqlStorageValue>>(query: string, ...values: SqlStorageValue[]): T[] =>
    database.prepare(query).all(...values as SQLInputValue[]) as T[];
  const storage = { sql: { exec: (query: string, ...values: SqlStorageValue[]) => {
    const result = rows(query, ...values); return { toArray: () => result };
  } } } as unknown as DurableObjectStorage;
  return { database, storage, ledger: new AttentionState(storage, rows), restart: () => new AttentionState(storage, rows) };
}
const item = (code: string): AttentionItem => ({ source: 'newsletter', code, severity: 'warning', since: null, metrics: {}, target: { view: 'ops', entry: 'newsletter' } });
const attention = (items: AttentionItem[]): Attention => ({ level: 'warning', items, info: [], held: [] });
function controlled(entry: AttentionItem | undefined): AttentionItem & { name: string; etag: string } {
  if (!entry?.name || !entry.etag) throw new Error('missing synthetic revision');
  return entry as AttentionItem & { name: string; etag: string };
}

describe('bounded reminder dispositions', () => {
  it('keeps the immutable sequence through owner changes and restart, and advances only for a new episode', () => {
    const { database, ledger, restart } = fixture();
    try {
      const first = controlled(ledger.project(attention([item('delivery_failed')]), NOW, () => false).attention.items[0]);
      const baseline = ledger.poll(0);
      expect(baseline.attention).toHaveLength(1);
      const initialSeq = baseline.head_seq;
      const dismissed = ledger.change(first.name, first.etag, true, NOW);
      expect(ledger.poll(0)).toEqual({ attention: [], head_seq: initialSeq });
      const restored = ledger.change(first.name, dismissed?.etag ?? '', false, NOW + 1);
      expect(restored?.etag).not.toBe(first.etag);
      expect(ledger.poll(initialSeq).attention).toEqual([]);
      const resumed = restart();
      resumed.project(attention([item('delivery_failed')]), NOW + 2, () => false);
      expect(resumed.poll(0).attention[0]?.occurrence_seq).toBe(initialSeq);
      resumed.project(attention([{ ...item('delivery_failed'), metrics: { count: 2 } }]), NOW + 3, () => false);
      const changedSeq = resumed.poll(initialSeq).head_seq;
      expect(changedSeq).toBeGreaterThan(initialSeq);
      resumed.project(attention([]), NOW + 4, () => true);
      expect(resumed.poll(0)).toEqual({ attention: [], head_seq: changedSeq });
      resumed.project(attention([{ ...item('delivery_failed'), metrics: { count: 2 } }]), NOW + 5, () => false);
      expect(resumed.poll(changedSeq).attention[0]?.occurrence_seq).toBeGreaterThan(changedSeq);
      expect(() => resumed.poll(resumed.poll(0).head_seq + 1)).toThrow('invalid_input');
    } finally { database.close(); }
  });

  it('migrates existing controls without changing their owner decision or etag', () => {
    const { database, storage, ledger } = fixture();
    try {
      const first = controlled(ledger.project(attention([item('delivery_failed')]), NOW, () => false).attention.items[0]);
      const dismissed = ledger.change(first.name, first.etag, true, NOW);
      database.exec('ALTER TABLE attention_occurrences DROP COLUMN occurrence_seq');
      database.exec("DELETE FROM state WHERE key='attention_sequence'");
      migrateAttentionSequence(storage);
      const current = ledger.project(attention([item('delivery_failed')]), NOW + 1, () => false);
      expect(current.attention.dismissed_items?.[0]).toMatchObject({ etag: dismissed?.etag });
      expect(ledger.poll(0)).toEqual({ attention: [], head_seq: 1 });
      expect(database.prepare('SELECT occurrence_seq FROM attention_occurrences').get()?.occurrence_seq).toBe(1);
    } finally { database.close(); }
  });

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
      expect(ledger.poll(0)).toEqual({ attention: [], head_seq: ATTENTION_ROW_LIMIT });
      expect(database.prepare('SELECT count(*) n FROM attention_occurrences').get()?.n).toBe(ATTENTION_ROW_LIMIT);
    } finally { database.close(); }
  });
});
