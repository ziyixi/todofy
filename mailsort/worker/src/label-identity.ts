/** Canonical views of merged labels. Original predictions, probabilities and write ledgers remain unchanged. */
import type { DecisionRow, LedgerRow, ReviewRow, Store } from './store.ts';
function mapped(id: string | null, aliases: ReadonlyMap<string, string>): string | null {
  return id === null ? null : aliases.get(id) ?? id;
}

function probabilities(json: string, aliases: ReadonlyMap<string, string>): string {
  const totals: Record<string, number> = {};
  for (const [id, value] of Object.entries(JSON.parse(json) as Record<string, number>)) {
    const target = aliases.get(id) ?? id;
    totals[target] = (totals[target] ?? 0) + value;
  }
  return JSON.stringify(totals);
}

export function canonicalDecision(store: Store, row: DecisionRow): DecisionRow {
  const aliases = store.labelAliases();
  if (aliases.size === 0) {
    return row;
  }
  return {
    ...row,
    label_id: mapped(row.label_id, aliases),
    top_label: mapped(row.top_label, aliases),
    verdict_label: mapped(row.verdict_label, aliases),
    current_labels: JSON.stringify([...new Set((JSON.parse(row.current_labels) as string[]).map((id) => aliases.get(id) ?? id))]),
    probabilities: probabilities(row.probabilities, aliases),
    probabilities2: probabilities(row.probabilities2, aliases)
  };
}

export function canonicalReview(store: Store, row: ReviewRow): ReviewRow {
  const aliases = store.labelAliases();
  if (aliases.size === 0) {
    return row;
  }
  const raw = JSON.parse(row.candidates) as {
    label: string;
    probability: number;
  }[];
  const candidates = new Map<string, number>();
  for (const item of raw) {
    const id = aliases.get(item.label) ?? item.label;
    candidates.set(id, (candidates.get(id) ?? 0) + item.probability);
  }
  return {
    ...row,
    suggested_label: mapped(row.suggested_label, aliases),
    resolved_label: mapped(row.resolved_label, aliases),
    candidates: JSON.stringify([...candidates].map(([label, probability]) => ({ label, probability })))
  };
}

/** Merged source history is read-only. A one-to-one rename keeps its ID and ordinary undo unchanged. */
export function effectiveLedgerRow(store: Store, row: LedgerRow): LedgerRow {
  const original = store.one<LedgerRow>(`SELECT * FROM ledger WHERE id = ?`, row.id) ?? row;
  const canonical = store.canonicalLabelId(original.label_id);
  return canonical === original.label_id ? row : {
    ...row,
    label_id: canonical,
    superseded: 1
  };
}

/** Suppress only matching migration transitions inside their observed history window, never later owner edits. */
export function isMergeFeedback(store: Store, event: {
  message_id: string;
  gmail_label_id: string;
  seq: number | string;
}): boolean {
  const candidates = store.all<{
    history_start: string;
    history_end: string;
  }>(`SELECT history_start, history_end FROM label_merge_items WHERE message_id = ? AND state = 'complete' AND (source_gmail_id = ? OR target_gmail_id = ?) AND history_start IS NOT NULL AND history_end IS NOT NULL`, event.message_id, event.gmail_label_id, event.gmail_label_id);
  return candidates.some((row) => BigInt(event.seq) > BigInt(row.history_start) && BigInt(event.seq) <= BigInt(row.history_end));
}
