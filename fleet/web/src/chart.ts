/** Pure chart geometry: value scales, local-time ticks and gap-aware runs. No DOM. */
import { byteUnit, cores, load, percent, rate, bytes } from './format.ts';

export type Unit = 'percent' | 'bytes' | 'bytes_per_second' | 'load' | 'cores';
export type RangeName = 'day' | 'week' | 'month' | 'half_year' | 'two_years';

export const RANGE_LABELS: Readonly<Record<RangeName, string>> = {
  day: '24 小时', week: '7 天', month: '30 天', half_year: '180 天', two_years: '2 年',
};

export function formatValue(unit: Unit, value: number | null | undefined): string {
  switch (unit) {
    case 'percent': return percent(value);
    case 'bytes': return bytes(value);
    case 'bytes_per_second': return rate(value);
    case 'load': return load(value);
    case 'cores': return cores(value);
  }
}

/** 1, 2, 2.5 or 5 times a power of ten, at least `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

export interface Scale {
  /** Top of the axis; the bottom is always zero. */
  readonly max: number;
  readonly ticks: readonly { value: number; label: string }[];
}

/** A zero-based axis over [0, max] with about `intervals` clean steps, in the unit's own scale (GiB, %, cores). */
export function valueScale(unit: Unit, max: number, intervals = 3): Scale {
  const top = Math.max(max, 0);
  const binary = unit === 'bytes' || unit === 'bytes_per_second';
  let divisor = binary ? byteUnit(top).divisor : 1;
  let step = niceStep(top / divisor / intervals || 1 / intervals);
  let count = Math.max(1, Math.ceil(top / divisor / step - 1e-9));
  if (binary && count * step >= 1000 && divisor < 1024 ** 5) {
    // A four-digit top (1000 MiB) reads better in the next unit (1 GiB).
    divisor *= 1024;
    step = niceStep(top / divisor / intervals);
    count = Math.max(1, Math.ceil(top / divisor / step - 1e-9));
  }
  const suffix = binary
    ? ` ${byteUnit(divisor).name}${unit === 'bytes_per_second' ? '/s' : ''}`
    : unit === 'percent' ? '%' : '';
  const ticks = Array.from({ length: count + 1 }, (_, i) => {
    const scaled = Number((i * step).toPrecision(6));
    return { value: scaled * divisor, label: `${scaled}${i === 0 ? '' : suffix}` };
  });
  return { max: count * step * divisor, ticks };
}

/** Indices with a value, grouped into runs of consecutive steps. A missing step ends a run: lines never bridge it. */
export function runs(values: readonly (number | null)[]): number[][] {
  const out: number[][] = [];
  let current: number[] = [];
  values.forEach((value, index) => {
    if (value == null) {
      if (current.length) out.push(current);
      current = [];
    } else {
      current.push(index);
    }
  });
  if (current.length) out.push(current);
  return out;
}

const md = (d: Date): string => `${d.getMonth() + 1}/${d.getDate()}`;
const hh = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:00`;

/** Calendar ticks in the viewer's time zone, thinned so labels keep `minGap` pixels apart. */
export function timeTicks(
  start: number, end: number, range: RangeName, x: (t: number) => number, minGap = 56,
): { t: number; label: string }[] {
  const out: { t: number; label: string; major: boolean }[] = [];
  const d = new Date(start);
  const push = (label: string): void => {
    const major = range === 'day' ? d.getHours() === 0 : range === 'half_year' || range === 'two_years' ? d.getMonth() === 0 : d.getDate() === 1;
    if (d.getTime() >= start && d.getTime() <= end) out.push({ t: d.getTime(), label, major });
  };
  if (range === 'day') {
    d.setMinutes(0, 0, 0);
    for (; d.getTime() <= end; d.setHours(d.getHours() + 1)) {
      if (d.getHours() % 3 === 0) push(d.getHours() === 0 ? md(d) : hh(d));
    }
  } else if (range === 'week' || range === 'month') {
    d.setHours(0, 0, 0, 0);
    for (; d.getTime() <= end; d.setDate(d.getDate() + 1)) {
      if (range === 'week' || [1, 8, 15, 22].includes(d.getDate())) push(md(d));
    }
  } else {
    d.setHours(0, 0, 0, 0);
    d.setDate(1);
    for (; d.getTime() <= end; d.setMonth(d.getMonth() + 1)) {
      if (range === 'two_years' && d.getMonth() % 3 !== 0) continue;
      push(d.getMonth() === 0 ? `${d.getFullYear()}年` : `${d.getMonth() + 1}月`);
    }
  }
  // Day and year boundaries first, so thinning never drops the label that says which day or year it is.
  const kept: { t: number; label: string }[] = [];
  const fits = (t: number): boolean => kept.every((other) => Math.abs(x(t) - x(other.t)) >= minGap);
  for (const tick of [...out.filter((t) => t.major), ...out.filter((t) => !t.major)]) {
    if (fits(tick.t)) kept.push({ t: tick.t, label: tick.label });
  }
  return kept.sort((a, b) => a.t - b.t);
}

const STEP_FORMAT: Readonly<Record<RangeName, Intl.DateTimeFormatOptions>> = {
  day: { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false },
  week: { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false },
  month: { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false },
  half_year: { year: 'numeric', month: 'numeric', day: 'numeric' },
  two_years: { year: 'numeric', month: 'numeric', day: 'numeric' },
};
/** A step as local time: its start, and its end when a step is longer than one sample. */
export function stepLabel(start: number, stepSeconds: number, range: RangeName): string {
  const format = new Intl.DateTimeFormat('zh-CN', STEP_FORMAT[range]);
  if (stepSeconds <= 300) return format.format(start);
  const end = start + stepSeconds * 1000;
  return range === 'half_year' ? format.format(start) : `${format.format(start)} – ${format.format(end)}`;
}
