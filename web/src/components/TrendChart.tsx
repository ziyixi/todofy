import { useId } from 'react'
import { shortDay } from '../lib/format'

/** Number of categorical chart colours (--series-1 … --series-5 in tokens.css). */
export const SERIES_COLORS = 5

/**
 * A categorical chart colour, or 'danger' for a series that means failure. The categorical
 * colours differ in hue and lightness; the status tones (accent and ok are both green) do not,
 * so charts never use them for ordinary series.
 */
export type SeriesColor = 1 | 2 | 3 | 4 | 5 | 'danger'

/**
 * Line dash patterns by position in the chart: colour alone does not separate four or five
 * series for every reader, so each line (and its legend key) also has its own dash.
 */
export const LINE_DASHES: readonly string[] = ['', '6 3', '2 3', '8 3 2 3', '1 2']

export interface TrendSeries {
  readonly label: string
  readonly color: SeriesColor
  /** One value per day; null leaves a gap (a day not recorded, or nothing to measure). */
  readonly values: readonly (number | null)[]
}

interface TrendChartProps {
  readonly title: string
  /** UTC days (YYYY-MM-DD), oldest first. */
  readonly days: readonly string[]
  /** Whether each day was counted; the table says so for the others. */
  readonly recorded: readonly boolean[]
  readonly series: readonly TrendSeries[]
  /** Lines for rates and durations, stacked bars for parts of a total. */
  readonly variant: 'line' | 'bar'
  readonly format: (value: number) => string
  readonly axisFormat?: (value: number) => string
}

const WIDTH = 600
const HEIGHT = 140
const TOP = 6
const BAR_FILL = 0.7

/** The smallest 1, 2 or 5 times a power of ten at or above `value` (1 for an empty chart). */
export function niceCeiling(value: number): number {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  return (([1, 2, 5, 10].find((step) => step * power >= value) ?? 10) * power)
}

function present(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null)
}

/** Polyline segments through consecutive values, broken at every gap. */
function linePath(values: readonly (number | null)[], x: (index: number) => number, y: (value: number) => number): string {
  let path = ''
  let open = false
  values.forEach((value, index) => {
    if (value === null) {
      open = false
      return
    }
    path += `${open ? 'L' : 'M'}${x(index).toFixed(1)} ${y(value).toFixed(1)}`
    open = true
  })
  return path
}

function dashOf(index: number): string | undefined {
  return LINE_DASHES[index % LINE_DASHES.length] || undefined
}

/**
 * A small inline-SVG trend with a legend, a text summary for screen readers and the numbers as a
 * table. Colours come from the --series-N tokens, so it follows the light and dark themes; lines
 * also differ by dash, stacked bar segments are separated by a thin gap. Pass at most
 * SERIES_COLORS series with distinct colours.
 */
export function TrendChart({ title, days, recorded, series, variant, format, axisFormat = format }: TrendChartProps) {
  const titleId = useId()
  const totals = days.map((_, index) => series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0))
  const peak = variant === 'bar' ? Math.max(0, ...totals) : Math.max(0, ...series.flatMap((item) => present(item.values)))
  const max = niceCeiling(peak)
  const band = WIDTH / Math.max(days.length, 1)
  const x = (index: number) => (index + 0.5) * band
  const y = (value: number) => HEIGHT - (value / max) * (HEIGHT - TOP)
  const summary = series
    .map((item) => {
      const values = present(item.values)
      const latest = values.at(-1)
      return latest === undefined
        ? `${item.label}：无数据`
        : `${item.label}：最高 ${format(Math.max(...values))}，最近一天 ${format(latest)}`
    })
    .join('；')

  return (
    <figure className="trend" aria-labelledby={titleId}>
      <figcaption className="trend-head">
        <span id={titleId} className="trend-title">
          {title}
        </span>
        <ul className="trend-legend">
          {series.map((item, index) => (
            <li key={item.label} className={`series-${item.color}`}>
              {variant === 'line' ? (
                <svg className="trend-key" viewBox="0 0 20 10" aria-hidden="true">
                  <line x1={1} x2={19} y1={5} y2={5} strokeDasharray={dashOf(index)} />
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
        <span className="muted small">{axisFormat(max)}</span>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${title}，最近 ${days.length} 天。${summary}`}>
          {[0, 0.5, 1].map((fraction) => (
            <line key={fraction} className="trend-grid" x1={0} x2={WIDTH} y1={y(max * fraction)} y2={y(max * fraction)} />
          ))}
          {variant === 'bar'
            ? days.map((day, index) => {
                let base = 0
                return (
                  <g key={day}>
                    {series.map((item) => {
                      const value = item.values[index] ?? 0
                      if (value <= 0) return null
                      const top = y(base + value)
                      const height = y(base) - top
                      base += value
                      return (
                        <rect
                          key={item.label}
                          className={`trend-bar series-${item.color}`}
                          x={x(index) - (band * BAR_FILL) / 2}
                          width={band * BAR_FILL}
                          y={top}
                          height={height}
                        />
                      )
                    })}
                  </g>
                )
              })
            : series.map((item, index) => (
                <g key={item.label} className={`series-${item.color}`}>
                  <path className="trend-line" d={linePath(item.values, x, y)} strokeDasharray={dashOf(index)} />
                  {item.values.map((value, index) =>
                    value === null ? null : <circle key={days[index]} className="trend-dot" cx={x(index)} cy={y(value)} r={3} />,
                  )}
                </g>
              ))}
        </svg>
        <div className="trend-axis muted small">
          <span>{days.length ? shortDay(days[0] ?? '') : ''}</span>
          <span>{days.length ? shortDay(days.at(-1) ?? '') : ''}</span>
        </div>
      </div>
      <details className="trend-table">
        <summary>数据表</summary>
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">{title}（UTC 日期）</caption>
            <thead>
              <tr>
                <th scope="col">日期</th>
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
                      const value = item.values[index]
                      return <td key={item.label}>{value === null || value === undefined ? '—' : format(value)}</td>
                    })
                  ) : (
                    <td colSpan={series.length} className="muted">
                      未记录
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}
