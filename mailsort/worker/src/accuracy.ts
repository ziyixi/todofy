/**
 * Per-label accuracy (../../docs/design.md §6.4): the precision of confident decisions, from the owner's verdicts. A
 * confirmation (review queue, audit, or the owner adding the suggested label in Gmail) counts 1, a weak accept (an
 * applied label untouched for 3 days) WEAK_ACCEPT_WEIGHT, a correction 1 against. The Wilson 95 % lower bound of that
 * precision gates live mode: the dashboard shows it, the owner turns `live` on per label, and the daily pass turns a
 * live label back to shadow when its bound drops below the target.
 */
import { DAY, WEAK_ACCEPT_WEIGHT } from './limits.ts';
import type { Store } from './store.ts';

const Z = 1.96;

/** The Wilson score interval's lower bound for `successes` of `n` (fractional counts allowed); 0 when n is 0. */
export function wilsonLowerBound(successes: number, n: number): number {
  if (n <= 0) return 0;
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = Z * Z;
  const centre = p + z2 / (2 * n);
  const margin = Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

export interface LabelStats {
  readonly label: string;
  readonly confirmed: number;
  readonly corrected: number;
  readonly weak: number;
  readonly lowerBound: number;
  readonly decided7d: number;
  readonly applied7d: number;
}

/** Every label's verdict counts and bound (one grouped read of the decisions with a verdict, one of the last week). */
export function labelStats(store: Store, labelIds: readonly string[], now: number): Map<string, LabelStats> {
  const verdicts = new Map<string, { confirmed: number; corrected: number; weak: number }>();
  for (const row of store.all<{ label_id: string; verdict: string; n: number }>(
    `SELECT label_id, verdict, count(*) AS n FROM decisions WHERE label_id IS NOT NULL AND verdict IS NOT NULL GROUP BY label_id, verdict`,
  )) {
    const entry = verdicts.get(row.label_id) ?? { confirmed: 0, corrected: 0, weak: 0 };
    if (row.verdict === 'confirmed') entry.confirmed += row.n;
    else if (row.verdict === 'corrected') entry.corrected += row.n;
    else if (row.verdict === 'weak') entry.weak += row.n;
    verdicts.set(row.label_id, entry);
  }
  const recent = new Map<string, { decided: number; applied: number }>();
  for (const row of store.all<{ label_id: string; outcome: string; n: number }>(
    `SELECT label_id, outcome, count(*) AS n FROM decisions WHERE decided_at >= ? AND label_id IS NOT NULL GROUP BY label_id, outcome`,
    now - 7 * DAY,
  )) {
    const entry = recent.get(row.label_id) ?? { decided: 0, applied: 0 };
    entry.decided += row.n;
    if (row.outcome === 'applied') entry.applied += row.n;
    recent.set(row.label_id, entry);
  }
  const out = new Map<string, LabelStats>();
  for (const label of labelIds) {
    const v = verdicts.get(label) ?? { confirmed: 0, corrected: 0, weak: 0 };
    const r = recent.get(label) ?? { decided: 0, applied: 0 };
    const successes = v.confirmed + WEAK_ACCEPT_WEIGHT * v.weak;
    const n = successes + v.corrected;
    out.set(label, { label, confirmed: v.confirmed, corrected: v.corrected, weak: v.weak, lowerBound: wilsonLowerBound(successes, n), decided7d: r.decided, applied7d: r.applied });
  }
  return out;
}
