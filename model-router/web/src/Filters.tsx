import { Filter, RotateCcw } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { Model } from '@ziyixi/proto/modelrouter/inference/v1/inference_wire'
import type { RequestFilters, TimeRange } from './api'
import { modelLabel, stateLabel } from './format'

export function defaultFilters(): RequestFilters {
  return { days: 7, app: '', model: '', state: '', toTime: new Date().toISOString() }
}

export function Filters({
  filters,
  models,
  onChange,
  showState = true,
  utcDays = false,
}: {
  filters: RequestFilters
  models: readonly Model[]
  onChange: (value: RequestFilters) => void
  showState?: boolean
  utcDays?: boolean
}) {
  const [draft, setDraft] = useState(filters)
  function apply(event: FormEvent) {
    event.preventDefault()
    const value = { ...draft, app: draft.app.trim(), toTime: new Date().toISOString() }
    setDraft(value)
    onChange(value)
  }
  function reset() {
    const value = defaultFilters()
    setDraft(value)
    onChange(value)
  }
  return (
    <form className="filters" onSubmit={apply} aria-label="筛选请求">
      <label>
        时间
        <select
          aria-label="时间"
          value={draft.days}
          onChange={(event) => setDraft({ ...draft, days: Number(event.target.value) as TimeRange })}
        >
          <option value={1}>{utcDays ? '今天（UTC）' : '最近 24 小时'}</option>
          <option value={7}>{utcDays ? '近 7 个 UTC 日' : '最近 7 天'}</option>
          <option value={30}>{utcDays ? '近 30 个 UTC 日' : '最近 30 天'}</option>
          <option value={90}>{utcDays ? '近 90 个 UTC 日' : '最近 90 天'}</option>
        </select>
      </label>
      <label>
        应用
        <input
          value={draft.app}
          onChange={(event) => setDraft({ ...draft, app: event.target.value })}
          placeholder="全部应用"
        />
      </label>
      <label>
        模型
        <select
          aria-label="模型"
          value={draft.model}
          onChange={(event) => setDraft({ ...draft, model: event.target.value })}
        >
          <option value="">全部模型</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {modelLabel(model)}
            </option>
          ))}
        </select>
      </label>
      {showState && (
        <label>
          状态
          <select
            aria-label="状态"
            value={draft.state}
            onChange={(event) => setDraft({ ...draft, state: event.target.value })}
          >
            <option value="">全部状态</option>
            {['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].map((value) => (
              <option key={value} value={value}>
                {stateLabel(value)}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit">
        <Filter size={14} aria-hidden="true" />
        应用筛选
      </button>
      {(draft.app || draft.model || draft.state || draft.days !== 7) && (
        <button type="button" className="icon-button" aria-label="重置筛选" onClick={reset}>
          <RotateCcw size={15} />
        </button>
      )}
    </form>
  )
}
