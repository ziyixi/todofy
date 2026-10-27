import { ArrowDownLeft, ChevronRight, Inbox } from 'lucide-react'
import type { Generation } from '@ziyixi/proto/modelrouter/inference/v1/inference_wire'
import { Status } from './components'
import { cost, duration, modelName, requestId, time, totalTokens } from './format'

export function RequestList({
  requests,
  selected,
  onSelect,
  compact = false,
}: {
  requests: readonly Generation[]
  selected?: string
  onSelect: (request: Generation) => void
  compact?: boolean
}) {
  if (!requests.length)
    return (
      <div className="empty-state">
        <Inbox size={24} aria-hidden="true" />
        <h3>暂无请求</h3>
        <p>尝试调整筛选条件，或在 Playground 运行一次推理。</p>
      </div>
    )
  return (
    <div className={`request-list ${compact ? 'is-compact' : ''}`}>
      {!compact && (
        <div className="request-list-heading" aria-hidden="true">
          <span>请求 / 模型</span>
          <span>用量 / 耗时</span>
        </div>
      )}
      {requests.map((request) => (
        <button
          type="button"
          key={request.name}
          className={`request-row ${selected === request.name ? 'selected' : ''}`}
          onClick={() => onSelect(request)}
          aria-pressed={selected === request.name}
        >
          <span className="request-icon" aria-hidden="true">
            <ArrowDownLeft size={17} />
          </span>
          <span className="request-main">
            <span className="request-line">
              <strong>{request.app || '来源未提供'}</strong>
              <Status state={request.state} />
            </span>
            <span className="small request-model">{modelName(request.model)}</span>
            <span className="small muted">
              <time dateTime={request.started_at}>{time(request.started_at)}</time>
              <span className="request-short-id"> · {requestId(request.name).slice(0, 8)}</span>
            </span>
          </span>
          <span className="request-metrics">
            <span>
              {totalTokens(request)} <span className="muted small">token</span>
            </span>
            <span className="small muted">{duration(request.duration_ms)}</span>
            {!compact && <span className="small muted">{cost(request.usage)}</span>}
          </span>
          <ChevronRight size={15} className="muted" aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}
