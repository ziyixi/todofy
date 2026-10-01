/**
 * Stages 4 and 5 of the noise pipeline (../../docs/design.md §5): the diff of a new text against the notified state,
 * and the watch's trigger on it.
 *
 * - AnyChangeTrigger and NewItemTrigger compare with the notified state: differences below the floor add up until they
 *   reach it (the notified state moves only with a confirmed change).
 * - The other triggers are edges between the previous check's text and this one: they fire when their condition
 *   becomes true, never again while it stays true, and again after it was false in between (a restock after a
 *   sell-out). NumberTrigger.change_percent is the exception: a share of the notified value.
 *
 * Pure and deterministic. A change's summary is one Chinese line made from counts and the trigger kind, never from
 * the page (its values travel in previous_value and current_value, its lines in the diff).
 */
import type { TriggerConfig, TriggerKind } from './config.ts';
import type { Content } from './content.ts';
import { diffLines, type DiffResult } from './diff.ts';
import { AVAILABLE } from './extract/structured.ts';
import { DIFF_LINE_MAX, DIFF_LINES_KEPT } from './limits.ts';

export type SuppressionCode = 'BELOW_THRESHOLD' | 'TRIGGER_NOT_MET' | 'FLICKER';

export interface Evaluation {
  readonly kind: TriggerKind;
  readonly fired: boolean;
  /** Why it did not fire (null when it fired). */
  readonly reason: SuppressionCode | null;
  readonly added: number;
  readonly removed: number;
  readonly diff: DiffResult;
  /** NumberTrigger or AvailabilityTrigger: the notified and the new value ('' when none). */
  readonly previous: string;
  readonly current: string;
  readonly summary: string;
}

export interface KeptDiff {
  readonly lines: readonly { readonly kind: 'added' | 'removed'; readonly text: string }[];
  readonly truncated: boolean;
}

/** The diff lines a change keeps: at most DIFF_LINES_KEPT of at most DIFF_LINE_MAX characters. */
export function keptDiff(diff: DiffResult): KeptDiff {
  const lines = diff.ops.slice(0, DIFF_LINES_KEPT).map((op) => ({ kind: op.kind, text: op.text.length > DIFF_LINE_MAX ? `${op.text.slice(0, DIFF_LINE_MAX - 1)}…` : op.text }));
  const cut = diff.ops.length > DIFF_LINES_KEPT || diff.ops.some((op) => op.text.length > DIFF_LINE_MAX);
  return { lines, truncated: cut };
}

function contains(lines: readonly string[], text: string): boolean {
  const needle = text.toLowerCase();
  return lines.some((line) => line.toLowerCase().includes(needle));
}

function counts(added: number, removed: number): string {
  if (added > 0 && removed > 0) return `新增 ${String(added)} 行，删除 ${String(removed)} 行`;
  if (added > 0) return `新增 ${String(added)} 行`;
  if (removed > 0) return `删除 ${String(removed)} 行`;
  return '内容有变化';
}

/** The trigger on `current`, against the notified `baseline` and the `previous` check's text. */
export function evaluate(trigger: TriggerConfig, baseline: Content, previous: Content, current: Content): Evaluation {
  const diff = diffLines(baseline.lines, current.lines);
  const added = diff.added.length;
  const removed = diff.removed.length;
  const base = { kind: trigger.kind, added, removed, diff, previous: '', current: '' };
  const result = (fired: boolean, reason: SuppressionCode, summary: string, values: { previous?: string; current?: string } = {}): Evaluation => ({
    ...base,
    ...values,
    fired,
    reason: fired ? null : reason,
    summary,
  });
  switch (trigger.kind) {
    case 'any_change': {
      const changed = added + removed;
      const share = baseline.lines.length === 0 ? 100 : (changed * 100) / baseline.lines.length;
      const fired = changed >= trigger.minLines && share >= trigger.minPercent;
      return result(fired, 'BELOW_THRESHOLD', counts(added, removed));
    }
    case 'text_appears': {
      const fired = contains(current.lines, trigger.text) && !contains(previous.lines, trigger.text);
      return result(fired, 'TRIGGER_NOT_MET', fired ? '关注的文字出现了' : counts(added, removed));
    }
    case 'text_disappears': {
      const fired = !contains(current.lines, trigger.text) && contains(previous.lines, trigger.text);
      return result(fired, 'TRIGGER_NOT_MET', fired ? '关注的文字消失了' : counts(added, removed));
    }
    case 'new_item': {
      const known = new Set(baseline.keys);
      const fresh = new Set(current.keys.filter((key) => !known.has(key)));
      const fired = fresh.size >= trigger.minItems;
      return result(fired, 'TRIGGER_NOT_MET', fresh.size > 0 ? `新增 ${String(fresh.size)} 项` : counts(added, removed));
    }
    case 'number': {
      const before = previous.number === null ? null : Number(previous.number);
      const notified = baseline.number === null ? null : Number(baseline.number);
      const value = current.number === null ? null : Number(current.number);
      if (value === null) return result(false, 'TRIGGER_NOT_MET', '没有读到数值', { previous: previous.number ?? '', current: '' });
      const rose = trigger.upper !== null && value >= trigger.upper && (before === null || before < trigger.upper);
      const fell = trigger.lower !== null && value <= trigger.lower && (before === null || before > trigger.lower);
      const moved = trigger.changePercent > 0 && notified !== null && notified !== 0 && (Math.abs(value - notified) * 100) / Math.abs(notified) >= trigger.changePercent;
      const compared = rose || fell || !moved ? previous.number : baseline.number;
      const summary = rose ? '数值升到上限以上' : fell ? '数值降到下限以下' : moved ? `数值变动超过 ${String(trigger.changePercent)}%` : before !== value ? '数值有变化，未达条件' : counts(added, removed);
      return result(rose || fell || moved, 'TRIGGER_NOT_MET', summary, { previous: compared ?? '', current: current.number ?? '' });
    }
    case 'availability': {
      const before = previous.availability ?? '';
      const now = current.availability ?? '';
      const changed = before !== now;
      const fired = trigger.onlyWhenAvailable ? AVAILABLE.has(now) && !AVAILABLE.has(before) : changed;
      const summary = fired ? (AVAILABLE.has(now) ? '可以购买了' : '供货状态变了') : changed ? '供货状态变了，未达条件' : counts(added, removed);
      return result(fired, 'TRIGGER_NOT_MET', summary, { previous: before, current: now });
    }
  }
}

/** The summary of a flicker or a revert (the page went back to the notified state within the window). */
export const REVERTED_SUMMARY = '变化在确认前又恢复了原样';
