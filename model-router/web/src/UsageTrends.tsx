import { useId, useState, type PointerEvent } from 'react'
import type { UsageBucket } from '@ziyixi/proto/modelrouter/inference/v1/console_wire'
import type { RequestFilters } from './api'
import { count, money } from './format'
import { usagePoints, type UsagePoint } from './usage'

interface Series {
  label: string
  values: readonly (number | null)[]
}
const WIDTH = 600
const HEIGHT = 150
const PAD = 12
const utcLabel = (value: string, hourly: boolean) => (hourly ? value.slice(11, 16) : value.slice(5, 10))

function Trend({
  title,
  points,
  series,
  hourly,
  format,
  note,
}: {
  title: string
  points: readonly UsagePoint[]
  series: readonly Series[]
  hourly: boolean
  format: (value: number) => string
  note: string
}) {
  const id = useId()
  const [active, setActive] = useState<number | null>(null)
  const peak = Math.max(
    0,
    ...series.flatMap((item) => item.values.filter((value): value is number => value !== null)),
  )
  const max = peak || 1
  const x = (index: number) =>
    points.length === 1 ? WIDTH / 2 : PAD + (index / (points.length - 1)) * (WIDTH - PAD * 2)
  const y = (value: number) => HEIGHT - PAD - (value / max) * (HEIGHT - PAD * 2)
  function path(values: readonly (number | null)[]) {
    let open = false
    return values
      .map((value, index) => {
        if (value === null) {
          open = false
          return ''
        }
        const segment = `${open ? 'L' : 'M'}${x(index)} ${y(value)}`
        open = true
        return segment
      })
      .join(' ')
  }
  function hover(event: PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const position = ((event.clientX - bounds.left) / bounds.width) * WIDTH
    setActive(
      Math.max(
        0,
        Math.min(points.length - 1, Math.round(((position - PAD) / (WIDTH - PAD * 2)) * (points.length - 1))),
      ),
    )
  }
  return (
    <figure className="panel usage-trend" aria-labelledby={id}>
      <figcaption className="section-heading">
        <h2 id={id}>{title}</h2>
        <span className="small muted">UTC · {hourly ? '每小时' : '每日'}</span>
      </figcaption>
      <ul className="chart-legend">
        {series.map((item, index) => (
          <li key={item.label}>
            <span className={`chart-key chart-series-${index}`} />
            {item.label}
          </li>
        ))}
      </ul>
      <div className="chart-scale small muted">
        <span>{format(peak)}</span>
      </div>
      <svg
        className="usage-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${title}，UTC${hourly ? '小时' : '每日'}趋势，左右方向键查看数据`}
        tabIndex={0}
        onPointerMove={hover}
        onPointerDown={hover}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive(points.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            setActive((current) =>
              Math.max(
                0,
                Math.min(
                  points.length - 1,
                  (current ?? points.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1),
                ),
              ),
            )
          }
        }}
      >
        {[0, 0.5, 1].map((fraction) => (
          <line
            key={fraction}
            className="chart-grid"
            x1={PAD}
            x2={WIDTH - PAD}
            y1={y(max * fraction)}
            y2={y(max * fraction)}
          />
        ))}
        {series.map((item, index) => (
          <g key={item.label} className={`chart-series-${index}`}>
            <path className="chart-line" d={path(item.values)} strokeDasharray={index ? '6 4' : undefined} />
            {item.values.map((value, position) =>
              value === null ? null : (
                <circle
                  key={points[position]?.time}
                  cx={x(position)}
                  cy={y(value)}
                  r={active === position ? 4 : 2}
                />
              ),
            )}
          </g>
        ))}
        {active !== null && (
          <line className="chart-cursor" x1={x(active)} x2={x(active)} y1={PAD} y2={HEIGHT - PAD} />
        )}
      </svg>
      <div className="chart-axis small muted">
        <span>{utcLabel(points[0]?.time ?? '', hourly)}</span>
        <span>{utcLabel(points.at(-1)?.time ?? '', hourly)}</span>
      </div>
      <div className="chart-reading small" aria-live="polite">
        {active === null ? (
          <span className="muted">移至图表或用方向键查看数值</span>
        ) : (
          <>
            <strong>{points[active]?.time.slice(0, 16).replace('T', ' ')} UTC</strong>
            {series.map((item) => (
              <span key={item.label}>
                {item.label}：{item.values[active] === null ? '未提供' : format(item.values[active] ?? 0)}
              </span>
            ))}
          </>
        )}
      </div>
      <p className="small muted chart-note">{note}</p>
      <details className="chart-table">
        <summary>数据表</summary>
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">{title}数据（UTC）</caption>
            <thead>
              <tr>
                <th scope="col">时间</th>
                {series.map((item) => (
                  <th scope="col" key={item.label}>
                    {item.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((point, index) => (
                <tr key={point.time}>
                  <th scope="row">{point.time.slice(0, hourly ? 16 : 10).replace('T', ' ')}</th>
                  {series.map((item) => (
                    <td key={item.label}>
                      {item.values[index] === null ? '未提供' : format(item.values[index] ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  )
}

export function UsageTrends({
  buckets,
  filters,
}: {
  buckets: readonly UsageBucket[]
  filters: RequestFilters
}) {
  const points = usagePoints(buckets, filters.days, filters.toTime)
  const shared = { points, hourly: filters.days === 1 }
  return (
    <div className="usage-trends">
      <Trend
        {...shared}
        title="请求趋势"
        series={[
          { label: '请求', values: points.map((point) => point.requests) },
          { label: '失败或中断', values: points.map((point) => point.failures) },
        ]}
        format={count}
        note="按接受请求的时间统计，包含尚在执行的请求。"
      />
      <Trend
        {...shared}
        title="Token 趋势"
        series={[
          { label: '输入', values: points.map((point) => point.input) },
          { label: '输出', values: points.map((point) => point.output) },
        ]}
        format={count}
        note="缓存属于输入，推理属于输出；用量不完整的区间留空。"
      />
      <Trend
        {...shared}
        title="费用趋势"
        series={[
          { label: 'API 费用估算', values: points.map((point) => point.apiCost) },
          { label: '订阅 API 等价', values: points.map((point) => point.subscriptionCost) },
        ]}
        format={money}
        note="两条估算分别显示；订阅参考金额不计入 API 费用，也不代表账单。"
      />
    </div>
  )
}
