import { Activity, ArrowUpRight, CircleCheck, Clock3, Coins, Cpu, List, XCircle } from 'lucide-react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import type { Model } from '@ziyixi/proto/modelrouter/inference/v1/inference_wire'
import type { UsageBucket } from '@ziyixi/proto/modelrouter/inference/v1/console_wire'
import type { RequestFilters, RouterApi } from './api'
import { Filters } from './Filters'
import { RequestList } from './RequestList'
import { Failure, Loading } from './components'
import { billingLabel, cost, count, modelName, money, providerLabel } from './format'
import { estimate, totals, type Estimate } from './usage'
import { UsageTrends } from './UsageTrends'

function Metric({
  label,
  value,
  note,
  Icon,
}: {
  label: string
  value: string
  note: string
  Icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>
}) {
  return (
    <article className="metric">
      <div className="metric-label">
        <span>{label}</span>
        <Icon size={17} aria-hidden={true} />
      </div>
      <strong>{value}</strong>
      <p className="small muted">{note}</p>
    </article>
  )
}
function amount(value: Estimate): string {
  if (!value.requests) return '暂无调用'
  return value.value === undefined ? '未完整提供' : money(value.value)
}
function Metrics({ buckets }: { buckets: readonly UsageBucket[] }) {
  const total = totals(buckets)
  return (
    <div className="metrics-grid">
      <Metric
        label="推理请求"
        value={count(total.requests)}
        note={`${count(total.succeeded)} 成功 · ${count(total.failed)} 失败或中断`}
        Icon={Activity}
      />
      <Metric
        label="报告的 token"
        value={total.known || !total.requests ? count(total.tokens) : '未提供'}
        note={`${count(total.known)} 次提供用量 · ${count(total.requests - total.known)} 次未完整提供`}
        Icon={Cpu}
      />
      <Metric
        label="API 费用估算"
        value={amount(total.api)}
        note={
          total.api.missing
            ? `${total.api.missing} 个模型时间区间的费用未完整提供`
            : '按 API 用量与单价估算，不代表账单'
        }
        Icon={Coins}
      />
      <Metric
        label="订阅 API 等价估算"
        value={amount(total.subscription)}
        note={`${count(total.subscription.requests)} 次订阅请求 · 仅供比较，不计入 API 费用`}
        Icon={Clock3}
      />
    </div>
  )
}
function ModelCatalog({ models }: { models: readonly Model[] }) {
  return (
    <section className="panel catalog">
      <div className="section-heading">
        <div>
          <h2>模型与连接</h2>
          <p className="small muted">连接已配置不代表模型实时可用。</p>
        </div>
        <span className="small muted">{models.length} 个模型</span>
      </div>
      {!models.length && <p className="muted">暂无模型目录。</p>}
      <div className="catalog-list">
        {models.map((model) => (
          <article className="catalog-row" key={model.id}>
            <span className={`catalog-status ${model.configured ? 'configured' : ''}`} aria-hidden="true">
              {model.configured ? <CircleCheck size={19} /> : <XCircle size={19} />}
            </span>
            <div className="catalog-model">
              <h3>
                {providerLabel(model.provider)} · {model.display_name || modelName(model.id)}
              </h3>
              <p className="small muted">
                <code>{modelName(model.id)}</code> · {model.kind === 'embedding' ? '向量' : '文本 / JSON'}
              </p>
            </div>
            <span className={`tag ${model.configured ? 'configured' : 'unconfigured'}`}>
              {model.configured ? '已配置' : '未配置'}
            </span>
          </article>
        ))}
      </div>
    </section>
  )
}

function ModelBreakdown({ buckets }: { buckets: readonly UsageBucket[] }) {
  const groups = new Map<string, UsageBucket[]>()
  for (const bucket of buckets) {
    const key = JSON.stringify([bucket.provider, bucket.model, bucket.billing_kind])
    groups.set(key, [...(groups.get(key) ?? []), bucket])
  }
  return (
    <section className="panel model-breakdown">
      <div className="section-heading">
        <h2>按模型汇总</h2>
        <span className="small muted">同一筛选范围</span>
      </div>
      {!groups.size ? (
        <p className="muted">此期间暂无用量记录。</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>供应商 / 模型</th>
                <th>计费方式</th>
                <th>请求</th>
                <th>已报告 token</th>
                <th>费用估算 / 参考</th>
              </tr>
            </thead>
            <tbody>
              {[...groups.entries()].map(([key, rows]) => {
                const bucket = rows[0]!
                const total = totals(rows)
                const amount = estimate(rows, bucket.billing_kind ?? '')
                return (
                  <tr key={key}>
                    <th scope="row">
                      {providerLabel(bucket.provider)} · <code>{modelName(bucket.model)}</code>
                    </th>
                    <td>{billingLabel(bucket.billing_kind)}</td>
                    <td>{count(total.requests)}</td>
                    <td>
                      {total.known ? count(total.tokens) : '未提供'}
                      <span className="small muted">
                        {' '}
                        · {total.known}/{total.requests} 次
                      </span>
                    </td>
                    <td>
                      {cost({ billing_kind: bucket.billing_kind, estimated_cost_microusd: amount.value })}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function Overview({
  api,
  models,
  filters,
  onFilter,
  onRequest,
}: {
  api: RouterApi
  models: readonly Model[]
  filters: RequestFilters
  onFilter: (value: RequestFilters) => void
  onRequest: (name: string) => void
}) {
  const usage = useQuery({
    queryKey: ['router-usage', filters.days, filters.app, filters.model],
    queryFn: () => api.getUsage(filters.days, filters.app, filters.model),
    placeholderData: keepPreviousData,
  })
  const recent = useQuery({
    queryKey: ['router-requests', filters, 'preview'],
    queryFn: () => api.listRequests(filters),
  })
  const buckets = usage.data?.buckets ?? []
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">OVERVIEW</p>
          <h1>推理概览</h1>
          <p className="muted">各应用共用的模型调用与用量。</p>
        </div>
        <span className="retention-note">
          <span className="live-dot" />
          私有控制台
        </span>
      </div>
      <Filters filters={filters} models={models} onChange={onFilter} showState={false} utcDays />
      {usage.isPending && (
        <div className="metrics-loading">
          <Loading>正在读取用量…</Loading>
        </div>
      )}
      {usage.error && <Failure error={usage.error} retry={() => void usage.refetch()} />}
      {usage.data && (
        <div aria-busy={usage.isFetching}>
          <Metrics buckets={buckets} />
          <p className="small muted overview-note">
            按 UTC {filters.days === 1 ? '小时' : '日'}
            统计。缓存属于输入，推理属于输出；未提供的用量与费用不会按零计算。
          </p>
          <UsageTrends
            buckets={buckets}
            filters={{
              ...filters,
              toTime: usage.dataUpdatedAt ? new Date(usage.dataUpdatedAt).toISOString() : filters.toTime,
            }}
          />
        </div>
      )}
      {usage.data && <ModelBreakdown buckets={buckets} />}
      <div className="overview-columns">
        <section className="panel">
          <div className="section-heading">
            <h2>
              <List size={16} aria-hidden="true" />
              最新请求
            </h2>
            <a className="text-button" href="#/requests">
              全部请求
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
          </div>
          {recent.isPending && <Loading />}
          {recent.error && <Failure error={recent.error} retry={() => void recent.refetch()} />}
          {recent.data && (
            <RequestList
              requests={(recent.data.requests ?? []).slice(0, 5)}
              compact
              onSelect={(request) => {
                if (request.generation?.name) onRequest(request.generation.name)
              }}
            />
          )}
        </section>
        <ModelCatalog models={models} />
      </div>
    </>
  )
}
