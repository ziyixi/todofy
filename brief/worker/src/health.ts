/**
 * A source's health (../../docs/design.md §3.2): failing (its last polls failed), paused (5 in a row: tried once a day),
 * and stale: a source can answer 200 and bring nothing for weeks (a moved or frozen feed, an ISSN change at Crossref, a
 * filter that rejects everything), so its usual gap is the median gap between its accepted items over the last 60 days,
 * and a source silent for 3 times that (at least 7 days; 30 days for one with fewer than 4 accepted items in 60 days) is
 * stale. Pure functions over the sources' rows.
 */
import { ACCEPT_HISTORY_MS, DAY, STALE_FACTOR, STALE_MIN_MS, STALE_SPARSE_BELOW, STALE_SPARSE_MS } from './limits.ts';
import type { Registry, Source } from './registry.ts';
import { parseJson, type SourceRow, type Store } from './store.ts';

export type HealthState = 'ok' | 'failing' | 'paused' | 'disabled' | 'stale' | 'new';

export interface Health {
  readonly state: HealthState;
  /** The median gap between accepted items (0 with fewer than two). */
  readonly usualGapMs: number;
  /** Accepted items in the last 7 days. */
  readonly recent: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function health(source: Source, row: SourceRow | undefined, now: number): Health {
  if (!source.enabled) return { state: 'disabled', usualGapMs: 0, recent: 0 };
  if (row === undefined || row.last_attempt_ms === null) return { state: 'new', usualGapMs: 0, recent: 0 };
  const accepts = parseJson<number[]>(row.accepts, []).filter((ms) => now - ms < ACCEPT_HISTORY_MS).sort((a, b) => a - b);
  const gaps = accepts.slice(1).map((ms, i) => ms - (accepts[i] ?? ms)).filter((gap) => gap > 0);
  const usualGapMs = median(gaps);
  const recent = accepts.filter((ms) => now - ms < 7 * DAY).length;
  if (row.state === 'paused') return { state: 'paused', usualGapMs, recent };
  if (row.state === 'failing') return { state: 'failing', usualGapMs, recent };
  const threshold = accepts.length < STALE_SPARSE_BELOW ? STALE_SPARSE_MS : Math.max(STALE_MIN_MS, STALE_FACTOR * usualGapMs);
  const since = row.last_item_ms ?? row.first_ms ?? row.last_attempt_ms;
  return { state: now - since > threshold ? 'stale' : 'ok', usualGapMs, recent };
}

export interface HealthCounts {
  ok: number;
  failing: number;
  paused: number;
  stale: number;
}

/**
 * The enabled sources by state. A source never polled yet (`new`, 未抓取 on 来源) is in none of them: `ok` is a source
 * whose last poll worked and that is not stale (ServiceStatus.ok_source_count).
 */
export function healthCounts(store: Store, registry: Registry, now: number): HealthCounts {
  const rows = new Map(store.all<SourceRow>(`SELECT * FROM sources`).map((row) => [row.id, row]));
  const counts: HealthCounts = { ok: 0, failing: 0, paused: 0, stale: 0 };
  for (const source of registry.sources) {
    const state = health(source, rows.get(source.id), now).state;
    if (state === 'ok') counts.ok++;
    else if (state === 'failing') counts.failing++;
    else if (state === 'paused') counts.paused++;
    else if (state === 'stale') counts.stale++;
  }
  return counts;
}
