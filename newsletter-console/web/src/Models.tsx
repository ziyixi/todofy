import { useQuery } from '@tanstack/react-query';
import type { ModelUsageDay, ModelUsageNode, UsageTotals } from '@ziyixi/proto/newsletter/ui/v1/model_call_wire';
import { read } from './api.ts';
import { datesBetween, segmentRect, stackByModel, type Stacked } from './chart.ts';
import { budgetSeconds, count, issueDate, microUsd, nodeNameById, purpose, wholeSeconds } from './format.ts';
import { modelsHref, type UsageRange } from './route.ts';

const RANGES: readonly UsageRange[] = [7, 30, 90];
const NOT_RECORDED = '上线前未记录';
/** The chart's drawing box; the SVG stretches it to the card's width, the labels around it are HTML. */
const WIDTH = 720;
const HEIGHT = 160;

/** 10/27 for the axis, where 10月27日 would not fit under a narrow bar. */
const axisDate = (date: string): string => `${String(Number(date.slice(5, 7)))}/${String(Number(date.slice(8, 10)))}`;

/** Which columns carry a date label: every one up to 10, else every week (30 days) or fortnight (90), and the last. */
export function labelled(columns: number): (index: number) => boolean {
  const step = columns <= 10 ? 1 : columns <= 31 ? 7 : 15;
  return (index) => index === columns - 1 || (index % step === 0 && columns - 1 - index >= step / 2);
}

function Tiles({ totals, days, timed }: { totals: UsageTotals | undefined; days: readonly ModelUsageDay[]; timed: number }) {
  const models = [...new Set(days.map((day) => day.model).filter((model): model is string => Boolean(model)))];
  const cost = microUsd(totals?.estimated_cost_microusd);
  const input = totals?.input_tokens ?? 0;
  const cached = totals?.cached_input_tokens ?? 0;
  const calls = totals?.call_count ?? 0;
  return (
    <dl className="tiles" aria-label="用量">
      <div>
        <dt>调用</dt>
        <dd className="value">{count(calls)}<span className="unit"> 次</span></dd>
        <dd>失败 {totals?.failed_count ?? 0} · 用量不完整 {totals?.partial_count ?? 0}</dd>
      </div>
      <div>
        <dt>输入 tokens</dt>
        <dd className="value">{count(input)}</dd>
        <dd>缓存命中 {count(cached)}{input > 0 ? `（${String(Math.round((cached / input) * 100))}%）` : ''}</dd>
      </div>
      <div>
        <dt>输出 tokens</dt>
        <dd className="value">{count(totals?.output_tokens ?? 0)}</dd>
        <dd>{calls === 0 ? '没有调用' : totals?.complete ? '每次调用都有完整用量' : '有调用的用量未完整记录，这是下限'}</dd>
      </div>
      <div>
        <dt>模型</dt>
        <dd className="value">{models.length}<span className="unit"> 个</span></dd>
        <dd className="models-list">{models.length ? models.join('、') : '没有调用'}</dd>
      </div>
      <div>
        <dt>估算费用</dt>
        <dd className="value">{cost ?? '未报告'}</dd>
        <dd>Model Router 的估算；订阅额度不是账单</dd>
      </div>
      <div>
        <dt>有用时记录</dt>
        <dd className="value">{count(timed)}<span className="unit"> / {count(calls)} 次</span></dd>
        <dd>{calls === 0 ? '没有调用' : timed < calls ? '更早的调用上线前未记录用时' : '每次调用都有开始与结束时间'}</dd>
      </div>
    </dl>
  );
}

function Bars({ stacked }: { stacked: Stacked }) {
  const { columns, models, top, ticks } = stacked;
  const series = (model: string): number => models.indexOf(model);
  const shows = labelled(columns.length);
  return (
    <>
      <ul className="legend" aria-label="模型">
        {models.map((model) => <li key={model}><span className={`swatch series-${String(series(model))}`} aria-hidden="true" />{model}</li>)}
      </ul>
      <div className="bars">
        <div className="bars-scale" aria-hidden="true">
          {ticks.map((tick) => <span key={tick} style={{ bottom: `${String((tick / top) * 100)}%` }}>{tick === 0 ? '0' : count(tick)}</span>)}
        </div>
        <svg className="bars-plot" viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`} preserveAspectRatio="none" role="img"
          aria-label={`每日 tokens（输入加输出），按模型堆叠，共 ${String(columns.length)} 天；数值见下方表格`}>
          {ticks.map((tick) => {
            const y = HEIGHT - (tick / top) * HEIGHT;
            return <line key={tick} className="bars-grid" x1={0} x2={WIDTH} y1={y} y2={y} vectorEffect="non-scaling-stroke" />;
          })}
          {columns.map((column, index) => (
            <g key={column.date}>
              <title>{`${issueDate(column.date)}：${column.total ? `${count(column.total)} tokens` : '没有调用'}${column.segments.map((segment) => `\n${segment.model} ${count(segment.value)}`).join('')}`}</title>
              {column.segments.map((segment) => {
                const rect = segmentRect(stacked, index, segment, WIDTH, HEIGHT);
                return <rect key={segment.model} className={`series-${String(series(segment.model))}`} x={rect.x} y={rect.y} width={rect.width} height={rect.height} />;
              })}
            </g>
          ))}
        </svg>
        <div className="bars-axis" aria-hidden="true">
          {columns.map((column, index) => (shows(index) ? (
            <span key={column.date} style={{ left: `${String(((index + 0.5) / columns.length) * 100)}%` }}>{axisDate(column.date)}</span>
          ) : null))}
        </div>
      </div>
    </>
  );
}

function DayTable({ days }: { days: readonly ModelUsageDay[] }) {
  return (
    <details className="twin">
      <summary>以表格查看</summary>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">日期</th><th scope="col">模型</th><th scope="col" className="num">调用</th><th scope="col" className="num">失败</th>
              <th scope="col" className="num">输入</th><th scope="col" className="num">缓存命中</th><th scope="col" className="num">输出</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={`${day.issue_date ?? ''}/${day.model ?? ''}`}>
                <td>{issueDate(day.issue_date)}</td>
                <td><code>{day.model || '未记录'}</code></td>
                <td className="num">{day.usage?.call_count ?? 0}</td>
                <td className="num">{day.usage?.failed_count ?? 0}</td>
                <td className="num">{count(day.usage?.input_tokens ?? 0)}</td>
                <td className="num">{count(day.usage?.cached_input_tokens ?? 0)}</td>
                <td className="num">{count(day.usage?.output_tokens ?? 0)}{day.usage?.complete ? '' : '（下限）'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

const callSeconds = (value: number | undefined): string => (value === undefined ? NOT_RECORDED : budgetSeconds(value));

/** A call's longest time against the newest frozen budget of its node: past it, or within its last fifth. */
export function callBudgetNote(node: ModelUsageNode): string | null {
  if (!node.budget_seconds || node.max_seconds === undefined) return null;
  if (node.max_seconds > node.budget_seconds) return '▲ 超过节点预算';
  return node.max_seconds > node.budget_seconds * 0.8 ? '▲ 接近节点预算' : null;
}

function Nodes({ nodes }: { nodes: readonly ModelUsageNode[] }) {
  return (
    <section className="card" aria-labelledby="nodes-title">
      <header className="card-head">
        <h2 id="nodes-title">按节点</h2>
        <p className="muted">每次调用的用时；预算是范围内最新一次运行冻结的节点预算</p>
      </header>
      {nodes.length === 0 ? <p className="muted">这段时间没有模型调用。</p> : (
        <div className="table-scroll">
          <table className="node-usage">
            <thead>
              <tr>
                <th scope="col">节点 · 用途</th><th scope="col" className="num">调用</th><th scope="col" className="num">中位用时</th>
                <th scope="col" className="num">最长 / 预算</th><th scope="col" className="num">Tokens 输入 / 输出</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node, index) => {
                const usage = node.usage;
                const note = callBudgetNote(node);
                return (
                  <tr key={index}>
                    <th scope="row">
                      {nodeNameById(node.node_id)}
                      <span className="cell-sub">{purpose(node.purpose) ?? NOT_RECORDED}</span>
                    </th>
                    <td className="num">
                      {usage?.call_count ?? 0}
                      {usage?.failed_count ? <span className="cell-sub bad-text">失败 {usage.failed_count}</span> : null}
                    </td>
                    <td className="num">{callSeconds(node.median_seconds)}</td>
                    <td className="num">
                      {node.max_seconds === undefined ? NOT_RECORDED : callSeconds(node.max_seconds)}
                      {node.budget_seconds ? <span className="muted"> / {wholeSeconds(node.budget_seconds)}</span> : null}
                      {note ? <span className="cell-sub warn-text">{note}</span> : null}
                    </td>
                    <td className="num">
                      {count(usage?.input_tokens ?? 0)} / {count(usage?.output_tokens ?? 0)}
                      {usage?.complete ? null : <span className="cell-sub">下限</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function ModelsPage({ days }: { days: UsageRange }) {
  const usage = useQuery({ queryKey: ['modelUsage', days], queryFn: () => read.modelUsage(days) });
  const data = usage.data;
  const span = datesBetween(data?.first_issue_date, data?.last_issue_date).length;
  return (
    <div className="page models">
      <header className="page-head">
        <div>
          <h2>模型调用</h2>
          <p className="muted">
            {data?.first_issue_date
              ? `${issueDate(data.first_issue_date)} – ${issueDate(data.last_issue_date)} · ${String(span)} 天，止于最近一次有运行的发刊日`
              : '按发刊日统计，止于最近一次有运行的发刊日'}
          </p>
        </div>
        <nav className="segmented" aria-label="时间范围">
          {RANGES.map((range) => (
            <a key={range} href={modelsHref(range)} aria-current={range === days ? 'page' : undefined}>{range} 天</a>
          ))}
        </nav>
      </header>
      {usage.isPending ? <p className="muted">正在读取模型用量…</p> : null}
      {usage.isError ? <p className="notice">模型用量暂时读不到，稍后刷新。</p> : null}
      {data ? (
        <>
          <Tiles totals={data.totals} days={data.days ?? []} timed={data.timed_call_count ?? 0} />
          <section className="card usage-chart" aria-labelledby="usage-title">
            <header className="card-head">
              <h2 id="usage-title">每日 tokens</h2>
              <p className="muted">输入加输出，按模型堆叠；没有柱的日子没有调用</p>
            </header>
            {data.first_issue_date
              ? <Bars stacked={stackByModel(data.days ?? [], data.first_issue_date, data.last_issue_date)} />
              : <p className="muted">还没有运行。</p>}
            {data.days?.length ? <DayTable days={data.days} /> : null}
          </section>
          <Nodes nodes={data.nodes ?? []} />
          <p className="muted small footnote">
            这里是 Newsletter 自己的调用账本；Model Router 的请求记录是另一份账本，从每次运行的「模型调用」可以打开。
          </p>
        </>
      ) : null}
    </div>
  );
}
