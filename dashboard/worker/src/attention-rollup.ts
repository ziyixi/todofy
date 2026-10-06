/**
 * The attention strip's order and overall level, in one place for the three that compute them: the evaluation
 * (evaluate.ts), the owner's dispositions (AttentionState.project) and the UI's cache after a dismiss or restore
 * (web/src/api/attention-cache.ts), so the level never changes on a page reload. Pure: the UI bundles it.
 */
import { attentionLevel, type Attention, type AttentionItem } from './api-types.ts';

type Ranked = Pick<AttentionItem, 'severity' | 'observed'>;

/** Strip order: critical, then unknown, then warning. */
const STRIP_RANK = { critical: 0, unknown: 1, warning: 2, info: 3 } as const;

/** Sorts `items` in place into strip order (stable within a level) and returns them. */
export function sortAttention<T extends Ranked>(items: T[]): T[] {
  return items.sort((a, b) => STRIP_RANK[attentionLevel(a)] - STRIP_RANK[attentionLevel(b)]);
}

/**
 * The strip's level over its open items: unknown before anything ran; else critical beats an observed unknown
 * (a view that cannot tell), which beats a warning; info items and an empty strip are ok.
 */
export function rollupAttention(items: readonly Ranked[], neverRan = false): Attention['level'] {
  if (neverRan) return 'unknown';
  if (items.some((item) => item.severity === 'critical')) return 'critical';
  if (items.some((item) => item.observed === 'unknown')) return 'unknown';
  return items.some((item) => item.severity === 'warning') ? 'warning' : 'ok';
}
