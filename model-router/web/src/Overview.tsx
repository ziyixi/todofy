import { Activity, ArrowUpRight, CircleCheck, Clock3, Coins, Cpu, List, XCircle } from 'lucide-react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import type { Model, UsageSummary } from '@ziyixi/proto/modelrouter/inference/v1/inference_wire'
import type { RequestFilters, RouterApi } from './api'
import { Filters } from './Filters'
import { RequestList } from './RequestList'
import { Failure, Loading } from './components'
import { count, modelName } from './format'

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

function Metrics({ usage }: { usage: UsageSummary }) {
  const requests = usage.request_count ?? 0
  const known = usage.usage_available_count ?? 0
  const succeeded = usage.success_count ?? 0
  return (
    <div className="metrics-grid">
      <Metric
        label="推理请求"
        value={count(requests)}
        note={`${count(succeeded)} 成功 · ${count(usage.failure_count ?? 0)} 失败或中断`}
        Icon={Activity}
      />
      <Metric
        label="报告的 token"
        value={known ? count((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)) : '未提供'}
        note={
          known
            ? `${count(known)} 次提供用量 · ${count(Math.max(0, requests - known))} 次未提供`
            : '未知用量不会按零计算'
        }
        Icon={Cpu}
      />
      <Metric
        label="API 费用估算"
        value={
          usage.api_cost_available ? `US$${((usage.estimated_cost_microusd ?? 0) / 1_000_000).toFixed(4)}` : '未提供'
        }
        note="仅累计已提供的 API 估算"
        Icon={Coins}
      />
      <Metric
        label="订阅请求"
        value={count(usage.subscription_request_count ?? 0)}
        note="订阅用量不换算为 API USD"
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
          <p className="small muted">显示本控制台的连接配置，不代表实时可用性。</p>
        </div>
        <span className="small muted">{models.length} 个模型</span>
      </div>
      {!models.length && <p className="muted">暂无模型目录。</p>}
      <div className="catalog-list">
        {models.map((model) => (
          <article className="catalog-row" key={model.name}>
            <span className={`catalog-status ${model.configured ? 'configured' : ''}`} aria-hidden="true">
              {model.configured ? <CircleCheck size={19} /> : <XCircle size={19} />}
            </span>
            <div className="catalog-model">
              <h3>{model.display_name || modelName(model.name)}</h3>
              <p className="small muted">
                {model.provider} · <code>{modelName(model.name)}</code>
              </p>
              <div className="capabilities">
                {model.generation && <span>文本 / JSON</span>}
                {model.embeddings && <span>向量 {model.dimensions ? `${model.dimensions} 维` : ''}</span>}
                {model.conversations && <span>短会话</span>}
                {model.web_research && <span>网页观测</span>}
                {Boolean(model.efforts?.length) && <span>effort {model.efforts?.join(' / ')}</span>}
                {model.temperature && <span>temperature</span>}
                {model.max_output_tokens && <span>输出上限</span>}
              </div>
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
          <Metrics usage={usage.data} />
          <p className="small muted overview-note">用量按 UTC 日累计。缓存命中已计入输入，推理 token 已计入输出。</p>
        </div>
      )}
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
                if (request.name) onRequest(request.name)
              }}
            />
          )}
        </section>
        <section className="panel usage-panel">
          <div className="section-heading">
            <h2>每日用量</h2>
            <span className="small muted">UTC</span>
          </div>
          {!usage.data && !usage.error && <Loading />}
          {usage.data && !usage.data.days?.length && <p className="muted">此期间暂无用量记录。</p>}
          {Boolean(usage.data?.days?.length) && (
            <div className="table-scroll">
              <table className="daily-table">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>请求</th>
                    <th>输入</th>
                    <th>输出</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(usage.data?.days ?? [])].reverse().map((day) => (
                    <tr key={day.day}>
                      <td>{day.day}</td>
                      <td>{count(day.request_count ?? 0)}</td>
                      <td>{count(day.input_tokens ?? 0)}</td>
                      <td>{count(day.output_tokens ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted">token 列仅累计已报告的用量。</p>
        </section>
      </div>
      <ModelCatalog models={models} />
    </>
  )
}
