/**
 * A line chart over a fixed step grid, hand-drawn in SVG. Missing steps are gaps (a lone step is a dot); a
 * crosshair snaps to the nearest step on hover or arrow keys and lists every series; a data table is the
 * non-visual twin. Light theme only.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { formatValue, RANGE_LABELS, runs, stepLabel, timeTicks, valueScale, type RangeName, type Unit } from './chart.ts';

/** Categorical slots in fixed order (validated: adjacent and all-pairs for three, light surface). */
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'] as const;

export interface ChartLine {
  readonly key: string;
  readonly name: string;
  readonly color: string;
  readonly values: readonly (number | null)[];
  /** Largest sample per step; shown on hover when a step holds more than one sample. */
  readonly max?: readonly (number | null)[] | undefined;
}
export interface ChartGrid {
  readonly start: number;
  readonly stepSeconds: number;
  readonly count: number;
}
interface Props {
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly unit: Unit;
  readonly grid: ChartGrid;
  readonly range: RangeName;
  readonly lines: readonly ChartLine[];
  /** Smallest axis top (e.g. 10% so idle CPU is not drawn as full scale). */
  readonly floor?: number | undefined;
  /** Largest axis top (100 for a percentage). */
  readonly ceiling?: number | undefined;
  /** Axis top shared by small multiples. */
  readonly fixedMax?: number | undefined;
  readonly reference?: { readonly value: number; readonly label: string } | undefined;
  /** A small multiple: shorter, area wash, no legend or table. */
  readonly compact?: boolean | undefined;
  /** Spans the whole chart grid. */
  readonly wide?: boolean | undefined;
}

const FALLBACK_WIDTH = 640;
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = (): void => setWidth(element.clientWidth || FALLBACK_WIDTH);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function TimeChart(props: Props) {
  const { title, subtitle, unit, grid, range, lines, compact = false } = props;
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);

  const height = compact ? 92 : 176;
  const margin = { top: 10, right: compact ? 6 : 12, bottom: 22, left: compact ? 44 : 56 };
  const plotW = Math.max(40, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;
  const stepMs = grid.stepSeconds * 1000;
  const spanMs = Math.max(stepMs, grid.count * stepMs);

  const all = lines.flatMap((line) => line.values.filter((v): v is number => v != null));
  const hasData = all.length > 0;
  const dataMax = Math.max(0, ...all, props.reference?.value ?? 0, props.floor ?? 0);
  const scale = valueScale(unit, props.fixedMax ?? Math.min(props.ceiling ?? Infinity, dataMax), compact ? 2 : 4);

  const xAt = (t: number): number => margin.left + ((t - grid.start) / spanMs) * plotW;
  const xOf = (index: number): number => xAt(grid.start + (index + 0.5) * stepMs);
  const yOf = (value: number): number => margin.top + plotH * (1 - Math.min(value, scale.max) / (scale.max || 1));
  const baseline = margin.top + plotH;
  const ticks = timeTicks(grid.start, grid.start + spanMs, range, xAt, compact ? 72 : 56);

  const lastIndex = (): number => {
    for (let i = grid.count - 1; i >= 0; i -= 1) if (lines.some((line) => line.values[i] != null)) return i;
    return grid.count - 1;
  };
  const clamp = (index: number): number => Math.min(grid.count - 1, Math.max(0, index));
  const onPointer = (event: PointerEvent<SVGSVGElement>): void => {
    const left = event.currentTarget.getBoundingClientRect().left;
    setActive(clamp(Math.floor(((event.clientX - left - margin.left) / plotW) * grid.count)));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const moves: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1, PageUp: -12, PageDown: 12 };
    const current = active ?? lastIndex();
    let next: number | null = null;
    if (event.key in moves) next = clamp(current + (moves[event.key] ?? 0));
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = lastIndex();
    else if (event.key === 'Escape') setActive(null);
    if (next !== null) {
      event.preventDefault();
      setActive(next);
    }
  };

  const latest = (line: ChartLine): string => {
    for (let i = line.values.length - 1; i >= 0; i -= 1) {
      const value = line.values[i];
      if (value != null) return formatValue(unit, value);
    }
    return '无数据';
  };
  const showPeak = grid.stepSeconds > 300;

  return (
    <figure className={['chart', compact && 'compact', props.wide && 'wide'].filter(Boolean).join(' ')}>
      <figcaption>
        <h3>{title}</h3>
        {lines.length === 1 && lines[0] && <span className="chart-latest">{latest(lines[0])}</span>}
        {subtitle && <p className="chart-sub">{subtitle}</p>}
      </figcaption>
      {!compact && lines.length > 1 && (
        <ul className="legend" aria-label={`${title}图例`}>
          {lines.map((line) => (
            <li key={line.key}>
              <span className="line-key" style={{ background: line.color }} aria-hidden="true" />
              <span>{line.name}</span>
              <strong>{latest(line)}</strong>
            </li>
          ))}
        </ul>
      )}
      <div
        ref={ref}
        className="plot"
        role="group"
        aria-roledescription="图表"
        aria-label={`${title}，${RANGE_LABELS[range]}。用左右方向键逐点查看数值`}
        tabIndex={hasData ? 0 : -1}
        onKeyDown={hasData ? onKey : undefined}
        onFocus={() => hasData && setActive((value) => value ?? lastIndex())}
        onBlur={() => setActive(null)}
      >
        <svg width={width} height={height} aria-hidden="true"
          onPointerMove={hasData ? onPointer : undefined} onPointerDown={hasData ? onPointer : undefined} onPointerLeave={() => setActive(null)}>
          {scale.ticks.map((tick) => (
            <g key={tick.value}>
              {tick.value > 0 && <line className="grid-line" x1={margin.left} x2={margin.left + plotW} y1={yOf(tick.value)} y2={yOf(tick.value)} />}
              <text className="axis-label" x={margin.left - 8} y={yOf(tick.value)} dy="0.32em" textAnchor="end">{tick.label}</text>
            </g>
          ))}
          <line className="baseline" x1={margin.left} x2={margin.left + plotW} y1={baseline} y2={baseline} />
          {ticks.map((tick) => (
            <text key={tick.t} className="axis-label" x={xAt(tick.t)} y={height - 4} textAnchor="middle">{tick.label}</text>
          ))}
          {props.reference && (
            <g>
              <line className="reference" x1={margin.left} x2={margin.left + plotW} y1={yOf(props.reference.value)} y2={yOf(props.reference.value)} />
              <text className="reference-label" x={margin.left + plotW} y={yOf(props.reference.value) - 4} textAnchor="end">{props.reference.label}</text>
            </g>
          )}
          {lines.map((line) => runs(line.values).map((run) => {
            const first = run[0] ?? 0;
            if (run.length === 1) return <circle key={`${line.key}-${first}`} cx={xOf(first)} cy={yOf(line.values[first] ?? 0)} r={2.5} fill={line.color} />;
            const path = run.map((i, n) => `${n ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(line.values[i] ?? 0).toFixed(1)}`).join('');
            const last = run[run.length - 1] ?? first;
            return (
              <g key={`${line.key}-${first}`} data-run={line.key}>
                {compact && <path d={`${path}L${xOf(last).toFixed(1)},${baseline}L${xOf(first).toFixed(1)},${baseline}Z`} fill={line.color} fillOpacity={0.1} />}
                <path d={path} fill="none" stroke={line.color} strokeWidth={compact ? 1.5 : 2} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          }))}
          {active !== null && (
            <g>
              <line className="crosshair" x1={xOf(active)} x2={xOf(active)} y1={margin.top} y2={baseline} />
              {lines.map((line) => {
                const value = line.values[active];
                return value == null ? null : (
                  <circle key={line.key} cx={xOf(active)} cy={yOf(value)} r={4} fill={line.color} className="marker" />
                );
              })}
            </g>
          )}
        </svg>
        {!hasData && <p className="plot-empty">此范围内没有数据</p>}
        {active !== null && (
          <div className={xOf(active) > width * 0.6 ? 'tooltip flip' : 'tooltip'} style={{ left: xOf(active) }} aria-live="polite">
            <time>{stepLabel(grid.start + active * stepMs, grid.stepSeconds, range)}</time>
            {lines.map((line) => {
              const value = line.values[active];
              const peak = line.max?.[active];
              return (
                <div key={line.key} className="tooltip-row">
                  <span className="line-key" style={{ background: line.color }} aria-hidden="true" />
                  <strong>{value == null ? '无数据' : formatValue(unit, value)}</strong>
                  {(lines.length > 1 || compact) && <span>{line.name}</span>}
                  {showPeak && value != null && peak != null && peak > value && <span className="peak">峰值 {formatValue(unit, peak)}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {!compact && hasData && <TableDetails {...props} />}
    </figure>
  );
}

/** The chart's data as a table, built only when opened. */
export function TableDetails(props: Pick<Props, 'title' | 'unit' | 'grid' | 'range' | 'lines'>) {
  const [open, setOpen] = useState(false);
  return (
    <details className="chart-table" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{props.title}数据表</summary>
      {open && <ChartTable {...props} />}
    </details>
  );
}

/** Every step with data, as text: the chart's equivalent for screen readers and exact reading. */
function ChartTable({ title, unit, grid, range, lines }: Pick<Props, 'title' | 'unit' | 'grid' | 'range' | 'lines'>) {
  const showPeak = grid.stepSeconds > 300;
  const steps = Array.from({ length: grid.count }, (_, i) => i).filter((i) => lines.some((line) => line.values[i] != null));
  return (
    <div className="table-scroll">
      <table>
        <caption>{title}（{showPeak ? '均值，括号内为峰值' : '每 5 分钟样本'}）</caption>
        <thead><tr><th scope="col">时间</th>{lines.map((line) => <th scope="col" key={line.key}>{line.name}</th>)}</tr></thead>
        <tbody>
          {steps.map((i) => (
            <tr key={i}>
              <th scope="row">{stepLabel(grid.start + i * grid.stepSeconds * 1000, grid.stepSeconds, range)}</th>
              {lines.map((line) => {
                const value = line.values[i];
                const peak = line.max?.[i];
                return (
                  <td key={line.key}>
                    {value == null ? '—' : formatValue(unit, value)}
                    {showPeak && value != null && peak != null && peak > value ? `（${formatValue(unit, peak)}）` : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
