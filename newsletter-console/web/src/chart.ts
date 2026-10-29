/**
 * Pure geometry of the 模型 page's daily bars: one column per issue date of the range (a date without calls is an
 * empty column, never a skipped one), stacked by model, on a zero-based scale with clean steps. No DOM.
 */
import type { ModelUsageDay } from '@ziyixi/proto/newsletter/ui/v1/model_call_wire';

/** At most this many models get their own colour; the rest are summed as 其他. */
export const MAX_SERIES = 4;
export const OTHER = '其他';

export interface Segment {
  readonly model: string;
  readonly value: number;
  /** The segment's bottom and top on the value scale. */
  readonly from: number;
  readonly to: number;
}

export interface Column {
  readonly date: string;
  readonly total: number;
  readonly segments: readonly Segment[];
}

export interface Stacked {
  /** The series, largest total first (OTHER last). */
  readonly models: readonly string[];
  readonly columns: readonly Column[];
  /** The top of the scale, and the ticks from zero to it. */
  readonly top: number;
  readonly ticks: readonly number[];
}

/** Every calendar date from `first` to `last` (YYYY-MM-DD, inclusive), at most `limit`; empty when either is invalid. */
export function datesBetween(first: string | undefined, last: string | undefined, limit = 90): string[] {
  const start = Date.parse(`${first ?? ''}T00:00:00Z`);
  const end = Date.parse(`${last ?? ''}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const out: string[] = [];
  for (let t = start; t <= end && out.length < limit; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** 1, 2, 2.5 or 5 times a power of ten, at least `raw` (Fleet's chart steps). */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
}

/** A zero-based scale over [0, max] in about `intervals` clean steps. */
export function scaleOf(max: number, intervals = 3): { top: number; ticks: number[] } {
  const step = niceStep(max / intervals);
  const steps = Math.max(1, Math.ceil(max / step - 1e-9));
  return { top: steps * step, ticks: Array.from({ length: steps + 1 }, (_, i) => Number((i * step).toPrecision(6))) };
}

/** A day's tokens of one model: what was read and written (input and output). */
export const tokensOf = (day: ModelUsageDay): number => (day.usage?.input_tokens ?? 0) + (day.usage?.output_tokens ?? 0);

/** The range's columns, stacked by model in the same order on every column. */
export function stackByModel(days: readonly ModelUsageDay[], first: string | undefined, last: string | undefined): Stacked {
  const totals = new Map<string, number>();
  for (const day of days) totals.set(day.model || '未记录', (totals.get(day.model || '未记录') ?? 0) + tokensOf(day));
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([model]) => model);
  const own = ranked.length > MAX_SERIES ? ranked.slice(0, MAX_SERIES - 1) : ranked;
  const models = ranked.length > MAX_SERIES ? [...own, OTHER] : own;
  const seriesOf = (model: string): string => (own.includes(model) ? model : OTHER);
  const columns = datesBetween(first, last).map((date) => {
    const values = new Map<string, number>();
    for (const day of days) {
      if (day.issue_date !== date) continue;
      const series = seriesOf(day.model || '未记录');
      values.set(series, (values.get(series) ?? 0) + tokensOf(day));
    }
    let from = 0;
    const segments = models.filter((model) => (values.get(model) ?? 0) > 0).map((model) => {
      const value = values.get(model) ?? 0;
      const segment = { model, value, from, to: from + value };
      from += value;
      return segment;
    });
    return { date, total: from, segments };
  });
  const { top, ticks } = scaleOf(Math.max(0, ...columns.map((column) => column.total)));
  return { models, columns, top, ticks };
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The widest a bar may be, in the drawing's units: seven days would otherwise draw slabs. */
export const MAX_BAR = 36;

/**
 * Where segment `segment` of column `index` sits in a `width` × `height` box: columns share the width equally, each
 * bar takes `fill` of its band (at most MAX_BAR), centred, and values grow up from the bottom edge.
 */
export function segmentRect(stacked: Stacked, index: number, segment: Segment, width: number, height: number, fill = 0.64): Rect {
  const band = width / Math.max(1, stacked.columns.length);
  const barWidth = Math.min(MAX_BAR, Math.max(1, band * fill));
  const y = (value: number): number => height - (value / stacked.top) * height;
  return { x: index * band + (band - barWidth) / 2, y: y(segment.to), width: barWidth, height: y(segment.from) - y(segment.to) };
}
