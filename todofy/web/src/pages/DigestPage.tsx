import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Newspaper, RefreshCw, Sparkles } from 'lucide-react'
import { useId, useState } from 'react'
import { api, ApiError } from '../api/client'
import { keys, useReports } from '../api/queries'
import type { RecommendationReport, RecomputeRequest, SummaryReport } from '../api/types'
import { useActionId } from '../api/useAction'
import { Modal } from '../components/Modal'
import { Badge, Button, EmptyState, ErrorPanel, Facts, Loading, PageHeader, Section, Time } from '../components/ui'
import { RECOMMENDATION_STATUS, SUMMARY_STATUS } from '../lib/labels'

function Window({ report }: { report: SummaryReport | RecommendationReport }) {
  return (
    <Facts
      items={[
        ['生成于', <Time key="c" value={report.computed_at} />],
        [
          '窗口',
          <span key="w">
            <Time value={report.window_start} /> – <Time value={report.window_end} />
          </span>,
        ],
        ['邮件摘要数', report.task_count],
        ['模型', report.model ? <code key="m">{report.model}</code> : <span key="m" className="muted">未调用</span>],
      ]}
    />
  )
}

function RawJson({ value }: { value: unknown }) {
  return (
    <details className="raw-json">
      <summary>newsletter 收到的原始 JSON</summary>
      <pre className="pre">{JSON.stringify(value, null, 2)}</pre>
    </details>
  )
}

function SummaryCard({ report }: { report: SummaryReport }) {
  const status = SUMMARY_STATUS[report.status]
  return (
    <Section title="每日摘要" aside={<Badge tone={status.tone}>{status.label}</Badge>}>
      <Window report={report} />
      <p className="pre report-text">{report.summary}</p>
      <RawJson value={report} />
    </Section>
  )
}

function RecommendationCard({ report }: { report: RecommendationReport }) {
  const status = RECOMMENDATION_STATUS[report.status]
  return (
    <Section title={`推荐任务 · 前 ${report.top_n} 项`} aside={<Badge tone={status.tone}>{status.label}</Badge>}>
      <Window report={report} />
      {report.tasks.length === 0 ? (
        <p className="muted">没有推荐任务。</p>
      ) : (
        <ol className="ranked">
          {report.tasks.map((task) => (
            <li key={task.rank}>
              <span className="rank" aria-hidden="true">
                {task.rank}
              </span>
              <div>
                <p className="ranked-title">{task.title}</p>
                <p className="muted pre">{task.reason}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
      <RawJson value={report} />
    </Section>
  )
}

type Kind = RecomputeRequest['kind']

/** The newsletter always asks for ?top=10 (api/recommendation-v1.schema.json). */
const NEWSLETTER_TOP = 10

/** What a recompute changes for the newsletter, which reads only the `top` it asks for. */
function newsletterEffect(kind: Kind, top: string): string {
  if (kind === 'summary') return '成功后，newsletter 下次读取的就是新结果。'
  if (!top) return '成功后，newsletter 下次读取的就是新结果（前提是 REPORT_DEFAULT_TOP 等于 newsletter 请求的数量 10）。'
  const read = top === String(NEWSLETTER_TOP) ? '就是这一份' : '不会读到这一份'
  return `只重新生成并保存「前 ${top} 项」的结果；newsletter 只读取它请求的 ?top=${NEWSLETTER_TOP} 对应的结果，${read}。`
}

function RecomputeDialog({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const client = useQueryClient()
  const { idFor, forget } = useActionId()
  const selectId = useId()
  const [top, setTop] = useState('')
  const mutation = useMutation({
    mutationFn: api.recompute,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.reports })
      onClose()
    },
    onError: (error) => {
      // The Worker answered and stored this failure: a retry needs a new id, or it is replayed.
      // Keep the id when the outcome is unknown, so a resend replays a stored success instead.
      if (error instanceof ApiError && error.code !== 'network_error' && error.code !== 'bad_response') forget()
    },
  })

  function submit() {
    const request = kind === 'recommendation' && top ? { kind, top: Number(top) } : { kind }
    mutation.mutate({ ...request, action_request_id: idFor(request) })
  }

  return (
    <Modal
      title={kind === 'summary' ? '重新生成每日摘要' : '重新生成推荐任务'}
      onClose={onClose}
      busy={mutation.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? '正在生成…' : '重新生成'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="consequence">
          用最近 24 小时的邮件摘要重新计算，会调用 Gemini（窗口为空时除外）并计入每小时的报告计算上限。
          {newsletterEffect(kind, top)}可能需要几十秒。
        </p>
        {kind === 'recommendation' ? (
          <div className="field">
            <label htmlFor={selectId}>推荐数量</label>
            <select id={selectId} value={top} onChange={(e) => setTop(e.target.value)} data-autofocus>
              <option value="">默认（REPORT_DEFAULT_TOP）</option>
              {Array.from({ length: 10 }, (_, index) => index + 1).map((n) => (
                <option key={n} value={n}>
                  前 {n} 项
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {mutation.isError ? <ErrorPanel error={mutation.error} /> : null}
      </div>
    </Modal>
  )
}

export function DigestPage() {
  const reports = useReports()
  const [recompute, setRecompute] = useState<Kind | null>(null)

  return (
    <>
      <PageHeader
        title="日报"
        description="newsletter 读取的每日摘要与推荐任务，与 /api/summary、/api/recommendation 返回的内容一致。"
        actions={
          <Button variant="ghost" onClick={() => reports.refetch()} disabled={reports.isFetching} aria-label="刷新日报">
            <RefreshCw size={16} aria-hidden="true" className={reports.isFetching ? 'spin' : undefined} />
            <span className="hide-narrow">刷新</span>
          </Button>
        }
      />
      <div className="action-row page-block">
        <Button onClick={() => setRecompute('summary')}>
          <Sparkles size={16} aria-hidden="true" />
          重新生成摘要
        </Button>
        <Button onClick={() => setRecompute('recommendation')}>
          <Sparkles size={16} aria-hidden="true" />
          重新生成推荐
        </Button>
      </div>
      {reports.isPending ? (
        <Loading />
      ) : reports.isError ? (
        <ErrorPanel error={reports.error} onRetry={() => reports.refetch()} />
      ) : !reports.data.summary && reports.data.recommendations.length === 0 ? (
        <EmptyState icon={<Newspaper size={28} />} title="还没有日报">
          每天按 REPORT_PRECOMPUTE_UTC 预先计算一次，也可以现在手动生成。
        </EmptyState>
      ) : (
        <div className="stack">
          {reports.data.summary ? <SummaryCard report={reports.data.summary} /> : null}
          {reports.data.recommendations.map((report) => (
            <RecommendationCard key={report.top_n} report={report} />
          ))}
        </div>
      )}
      {recompute ? <RecomputeDialog kind={recompute} onClose={() => setRecompute(null)} /> : null}
    </>
  )
}
