import { ChevronLeft, ChevronRight, Inbox } from 'lucide-react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { Generation, Model } from '@ziyixi/proto/modelrouter/inference/v1/inference_wire'
import type { RequestFilters, RouterApi } from './api'
import type { PlaygroundDraft } from './Playground'
import { Filters } from './Filters'
import { RequestDetail } from './RequestDetail'
import { RequestList } from './RequestList'
import { Failure, Loading } from './components'

export function Requests({
  api,
  models,
  filters,
  onFilter,
  selectedName,
  onSelect,
  onCopy,
}: {
  api: RouterApi
  models: readonly Model[]
  filters: RequestFilters
  onFilter: (value: RequestFilters) => void
  selectedName?: string
  onSelect: (name?: string) => void
  onCopy: (draft: PlaygroundDraft) => void
}) {
  const [pageTokens, setPageTokens] = useState<string[]>([''])
  const [page, setPage] = useState(0)
  const query = useQuery({
    queryKey: ['router-requests', filters, pageTokens[page]],
    queryFn: () => api.listRequests(filters, pageTokens[page]),
    placeholderData: keepPreviousData,
  })
  const requests = query.data?.requests ?? []
  const [selectedSummary, setSelectedSummary] = useState<Generation>()
  function filter(value: RequestFilters) {
    setPageTokens([''])
    setPage(0)
    onFilter(value)
  }
  function select(request: Generation) {
    setSelectedSummary(request)
    onSelect(request.name)
  }
  function next() {
    const token = query.data?.next_page_token
    if (!token) return
    setPageTokens((current) => [...current.slice(0, page + 1), token])
    setPage((current) => current + 1)
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">REQUESTS</p>
          <h1>请求记录</h1>
          <p className="muted">查看每次推理的模型、用量与结果。</p>
        </div>
        <span className="retention-note">内容 7 天 · 元数据 90 天</span>
      </div>
      <Filters filters={filters} models={models} onChange={filter} />
      <div className={`requests-layout ${selectedName ? 'has-selection' : ''}`}>
        <section className="panel requests-panel" aria-label="请求列表" aria-busy={query.isFetching}>
          <div className="section-heading">
            <h2>请求</h2>
            {query.isFetching && (
              <span className="small muted" role="status">
                更新中…
              </span>
            )}
            <span className="small muted">第 {page + 1} 页</span>
          </div>
          {query.isPending && (
            <div className="list-loading">
              <Loading />
            </div>
          )}
          {query.error && <Failure error={query.error} retry={() => void query.refetch()} />}
          {query.data && <RequestList requests={requests} selected={selectedName} onSelect={select} />}
          <div className="pagination">
            <span className="small muted">每页最多 25 条</span>
            <div>
              <button
                aria-label="上一页"
                disabled={page === 0 || query.isFetching}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
              >
                <ChevronLeft size={16} />
              </button>
              <button
                aria-label="下一页"
                disabled={!query.data?.next_page_token || query.isFetching || query.isPlaceholderData}
                onClick={next}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </section>
        {selectedName ? (
          <RequestDetail
            key={selectedName}
            name={selectedName}
            summary={
              selectedSummary?.name === selectedName
                ? selectedSummary
                : requests.find((request) => request.name === selectedName)
            }
            api={api}
            onClose={() => onSelect()}
            onCopy={onCopy}
          />
        ) : (
          <aside className="panel detail-placeholder">
            <Inbox size={28} aria-hidden="true" />
            <h2>选择一条请求</h2>
            <p>查看输入、输出、实际参数和用量。</p>
            <p className="small">请求内容仅在此私有页面加载。</p>
          </aside>
        )}
      </div>
    </>
  )
}
