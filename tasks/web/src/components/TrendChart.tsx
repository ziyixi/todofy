import { useId } from "react";

/**
 * A copy of Todofy's TrendChart (todofy/web/src/components/TrendChart.tsx) for the GTD page, in Tasks' words.
 * A categorical chart colour (--series-1 … --series-4 in gtd.css), or 'danger' for a series that means trouble.
 */
export type SeriesColor = 1 | 2 | 3 | 4 | "danger";

/**
 * Line dash patterns by position in the chart: colour alone does not separate four series for every reader, so
 * each line (and its legend key) also has its own dash.
 */
const LINE_DASHES: readonly string[] = ["", "6 3", "2 3", "8 3 2 3"];

export interface TrendSeries {
  readonly label: string;
  readonly color: SeriesColor;
  /** One value per day; null leaves a gap (a day not counted, or nothing to measure). */
  readonly values: readonly (number | null)[];
}

interface TrendChartProps {
  readonly title: string;
  /** Account days (YYYY-MM-DD), oldest first. */
  readonly days: readonly string[];
  /** Whether each day was counted; the table says so for the others. */
  readonly recorded: readonly boolean[];
  readonly series: readonly TrendSeries[];
  /** Lines for counts over time, stacked bars for parts of a total. */
  readonly variant: "line" | "bar";
}

const WIDTH = 600;
const HEIGHT = 140;
const TOP = 6;
const BAR_FILL = 0.7;

/** The smallest 1, 2 or 5 times a power of ten at or above `value` (1 for an empty chart). */
export function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 5, 10].find((step) => step * power >= value) ?? 10) * power;
}

function present(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null);
}

/** Polyline segments through consecutive values, broken at every gap. */
function linePath(
  values: readonly (number | null)[],
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  let path = "";
  let open = false;
  values.forEach((value, index) => {
    if (value === null) {
      open = false;
      return;
    }
    path += `${open ? "L" : "M"}${x(index).toFixed(1)} ${y(value).toFixed(1)}`;
    open = true;
  });
  return path;
}

const dashOf = (index: number) =>
  LINE_DASHES[index % LINE_DASHES.length] || undefined;
/** 10/21 for 2026-10-21. */
const shortDay = (day: string) =>
  `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const format = (value: number) => value.toLocaleString("en-US");

/**
 * A small inline-SVG trend with a legend, a text summary for screen readers and the numbers as a table. Lines also
 * differ by dash; stacked bar segments are separated by a thin gap.
 */
export function TrendChart({
  title,
  days,
  recorded,
  series,
  variant,
}: TrendChartProps) {
  const titleId = useId();
  const totals = days.map((_, index) =>
    series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0),
  );
  const peak =
    variant === "bar"
      ? Math.max(0, ...totals)
      : Math.max(0, ...series.flatMap((item) => present(item.values)));
  const max = niceCeiling(peak);
  const band = WIDTH / Math.max(days.length, 1);
  const x = (index: number) => (index + 0.5) * band;
  const y = (value: number) => HEIGHT - (value / max) * (HEIGHT - TOP);
  const summary = series
    .map((item) => {
      const values = present(item.values);
      const latest = values.at(-1);
      return latest === undefined
        ? `${item.label}: no data`
        : `${item.label}: highest ${format(Math.max(...values))}, latest ${format(latest)}`;
    })
    .join("; ");

  return (
    <figure className="trend" aria-labelledby={titleId}>
      <figcaption className="trend-head">
        <span id={titleId} className="trend-title">
          {title}
        </span>
        <ul className="trend-legend">
          {series.map((item, index) => (
            <li key={item.label} className={`series-${item.color}`}>
              {variant === "line" ? (
                <svg
                  className="trend-key"
                  viewBox="0 0 20 10"
                  aria-hidden="true"
                >
                  <line
                    x1={1}
                    x2={19}
                    y1={5}
                    y2={5}
                    strokeDasharray={dashOf(index)}
                  />
                </svg>
              ) : (
                <span className="trend-swatch" aria-hidden="true" />
              )}
              {item.label}
            </li>
          ))}
        </ul>
      </figcaption>
      <div className="trend-plot">
        <span className="trend-scale">{format(max)}</span>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`${title}, the last ${days.length} days. ${summary}`}
        >
          {[0, 0.5, 1].map((fraction) => (
            <line
              key={fraction}
              className="trend-grid"
              x1={0}
              x2={WIDTH}
              y1={y(max * fraction)}
              y2={y(max * fraction)}
            />
          ))}
          {variant === "bar"
            ? days.map((day, index) => {
                let base = 0;
                return (
                  <g key={day}>
                    {series.map((item) => {
                      const value = item.values[index] ?? 0;
                      if (value <= 0) return null;
                      const top = y(base + value);
                      const height = y(base) - top;
                      base += value;
                      return (
                        <rect
                          key={item.label}
                          className={`trend-bar series-${item.color}`}
                          x={x(index) - (band * BAR_FILL) / 2}
                          width={band * BAR_FILL}
                          y={top}
                          height={height}
                        />
                      );
                    })}
                  </g>
                );
              })
            : series.map((item, index) => (
                <g key={item.label} className={`series-${item.color}`}>
                  <path
                    className="trend-line"
                    d={linePath(item.values, x, y)}
                    strokeDasharray={dashOf(index)}
                  />
                  {item.values.map((value, at) =>
                    value === null ? null : (
                      <circle
                        key={days[at]}
                        className="trend-dot"
                        cx={x(at)}
                        cy={y(value)}
                        r={3}
                      />
                    ),
                  )}
                </g>
              ))}
        </svg>
        <div className="trend-axis">
          <span>{days.length ? shortDay(days[0] ?? "") : ""}</span>
          <span>{days.length ? shortDay(days.at(-1) ?? "") : ""}</span>
        </div>
      </div>
      <details className="trend-table">
        <summary>Numbers</summary>
        <div className="trend-table-scroll">
          <table>
            <caption className="visually-hidden">{title}</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                {series.map((item) => (
                  <th key={item.label} scope="col">
                    {item.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((day, index) => (
                <tr key={day}>
                  <th scope="row">{day}</th>
                  {recorded[index] ? (
                    series.map((item) => {
                      const value = item.values[index];
                      return (
                        <td key={item.label}>
                          {value === null || value === undefined
                            ? "—"
                            : format(value)}
                        </td>
                      );
                    })
                  ) : (
                    <td colSpan={series.length} className="trend-unrecorded">
                      Not counted
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
