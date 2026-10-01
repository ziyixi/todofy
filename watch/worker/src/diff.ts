/**
 * Stage 4 of the noise pipeline (../../docs/design.md §5): a line diff of the notified state against the new text.
 *
 * Myers' O(ND) algorithm (the one jsdiff and git use) on the lines after their common prefix and suffix, which most
 * page changes leave large. It stops after `maxEdits` edits: a page rewritten from top to bottom then gets a plain
 * multiset difference (every line of one side not matched on the other), which has the same counts and lines, only
 * not their order. Both are deterministic, and the work is bounded by O((N + M) * maxEdits).
 */
import { DIFF_MAX_EDITS } from './limits.ts';

export interface DiffResult {
  /** Lines of `after` that `before` does not have, in order. */
  readonly added: string[];
  /** Lines of `before` that `after` does not have, in order. */
  readonly removed: string[];
  /** The edit script, in order (the multiset fallback lists removals first). */
  readonly ops: readonly { readonly kind: 'added' | 'removed'; readonly text: string }[];
  /** The edit search gave up: the result is the multiset difference. */
  readonly approximate: boolean;
}

/** The multiset difference: each line counted as often as it occurs. */
function multisetDiff(before: readonly string[], after: readonly string[]): DiffResult {
  const counts = new Map<string, number>();
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added.push(line);
  }
  const removed: string[] = [];
  const used = new Map<string, number>();
  for (const line of before) {
    const kept = (counts.get(line) ?? 0) - (used.get(line) ?? 0);
    if (kept > 0) {
      removed.push(line);
      used.set(line, (used.get(line) ?? 0) + 1);
    }
  }
  return {
    added,
    removed,
    ops: [...removed.map((text) => ({ kind: 'removed' as const, text })), ...added.map((text) => ({ kind: 'added' as const, text }))],
    approximate: true,
  };
}

/** The line diff of `before` against `after`. */
export function diffLines(before: readonly string[], after: readonly string[], maxEdits = DIFF_MAX_EDITS): DiffResult {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    const ops = [...a.map((text) => ({ kind: 'removed' as const, text })), ...b.map((text) => ({ kind: 'added' as const, text }))];
    return { added: [...b], removed: [...a], ops, approximate: false };
  }
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  // v[k + offset]: the furthest x on diagonal k. trace[d] keeps the front before round d, only its diagonals
  // -d-1..d+1 (index k + d + 1), so the memory is O(D^2) for D edits, never O(D * (N + M)).
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[k - 1 + offset] ?? 0) < (v[k + 1 + offset] ?? 0));
      let x = down ? (v[k + 1 + offset] ?? 0) : (v[k - 1 + offset] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return multisetDiff(before, after);
  // Backtrack from (n, m) through the saved fronts.
  const ops: { kind: 'added' | 'removed'; text: string }[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const front = trace[d] ?? new Int32Array(0);
    const at = (diagonal: number) => front[diagonal + d + 1] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
    }
    if (down) ops.push({ kind: 'added', text: b[previousY] ?? '' });
    else ops.push({ kind: 'removed', text: a[previousX] ?? '' });
    x = previousX;
    y = previousY;
  }
  ops.reverse();
  return {
    added: ops.filter((op) => op.kind === 'added').map((op) => op.text),
    removed: ops.filter((op) => op.kind === 'removed').map((op) => op.text),
    ops,
    approximate: false,
  };
}
