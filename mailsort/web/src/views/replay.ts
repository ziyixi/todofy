/** Settings' replay reads only corrected samples; no mail content or Gmail mutations. */
import { LabelConsolidation_State } from '@ziyixi/proto/mailsort/ui/v2/consolidation_pb'
import type { Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { ReplayEvaluation_State, type ReplayEvaluation } from '@ziyixi/proto/mailsort/ui/v2/replay_pb'
import { Mode, ServiceStatus_AuthState, type ServiceStatus } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { ApiError, api, errorMessage, newRequestId, withRetry } from '../api.ts'
import { card, kpi, meter } from '../components.ts'
import { button, el, fill } from '../dom.ts'
import { labelText, ms, when } from '../format.ts'

/** Known current holds only; a past error code cannot establish what is blocking this job. */
export function replayHold(status: ServiceStatus | null): string | null {
  if (status === null) return '运行状态读取失败；刷新状态后再开始'
  if (status.effectiveMode === Mode.OFF) return '模式已关闭，回放暂停；切到影子或正式后继续'
  if (status.authState !== ServiceStatus_AuthState.OK) return 'Gmail 尚未授权或授权已失效，恢复授权后才能继续'
  if (status.aiQuotaExhausted) return '今日模型配额已用完，等待下一个 UTC 日继续'
  if (status.dailyNeuronBudget > 0 && status.neuronsToday >= status.dailyNeuronBudget) return '今日模型预算已用完，等待下一个 UTC 日继续'
  return null
}

function results(replay: ReplayEvaluation, labels: readonly Label[]): HTMLElement[] {
  const processed = replay.evaluatedCount + replay.skippedCount
  const matched = replay.autoMatchCount + replay.noLabelMatchCount
  const mismatchCount = replay.autoCount + replay.noLabelCount - matched
  const running = replay.state === ReplayEvaluation_State.RUNNING
  const line = replay.totalCount === 0
    ? '最近 14 天没有可回放的已确认样本'
    : `${running ? '进行中' : '已完成'}：${String(processed)} / ${String(replay.totalCount)} 封`
  return [
    el('p', { class: 'hint', role: 'status' }, line),
    ...(replay.totalCount === 0 ? [] : [
      meter(processed, replay.totalCount, '回放进度'),
      el('div', { class: 'kpis replay-counts' }, kpi('样本', replay.totalCount), kpi('已判断', replay.evaluatedCount), kpi('与回答一致', matched), kpi('不一致', mismatchCount), kpi('拿不准', replay.unsureCount), kpi('无法读取', replay.skippedCount)),
      el('p', { class: 'hint' }, '一致与不一致只统计有把握的判断；拿不准和无法读取单独列出。'),
    ]),
    ...(replay.mismatches.length === 0 ? [] : [el('ul', { class: 'replay-mismatches', 'aria-label': '不一致的标签' }, ...replay.mismatches.map((item) => el('li', {}, `${labelText(item.decidedLabel, labels)} → 你的回答：${labelText(item.ownerLabel, labels)}（${String(item.mailCount)} 封）`)))]),
    (replay.reasonCounts['model_unavailable'] ?? 0) > 0 ? el('p', { class: 'hint warn' }, `${String(replay.reasonCounts['model_unavailable'])} 封因模型未能回答而记为拿不准`) : null,
    el('p', { class: 'meta' }, `开始 ${when(replay.createTime)}${replay.completeTime === undefined ? '' : ` · 完成 ${when(replay.completeTime)}`}`),
  ].filter((node): node is HTMLElement => node !== null)
}

export async function replayCard(labels: readonly Label[]): Promise<HTMLElement> {
  const box = card('检查分类效果', '', el('p', { class: 'hint' }, '最近 14 天你已回答的待审邮件，最多 200 封。使用现有模型预算，正常分拣优先；不改 Gmail，也不代表整个邮箱的准确率。'))
  const content = el('div', { class: 'replay-results' })
  const feedback = el('p', { class: 'hint warn', role: 'status', hidden: true })
  let replay: ReplayEvaluation | null = null
  let status: ServiceStatus | null = null
  let migrationHold: string | null = null
  let busy = false
  let readable = false
  let pendingRequestId: string | null = null
  let pendingBaseline: number | null = null
  const start = button('检查分类效果', () => void begin(), { class: 'primary' })
  const refresh = button('刷新状态', () => void load())

  const paint = () => {
    const running = replay?.state === ReplayEvaluation_State.RUNNING
    const hold = migrationHold ?? replayHold(status)
    fill(content, ...(readable ? replay === null ? [el('p', { class: 'hint' }, '尚未检查分类效果')] : results(replay, labels) : []), hold === null ? null : el('p', { class: 'hint warn' }, hold), running && hold === null ? el('p', { class: 'hint' }, '等待后台分批检查；正常分拣、退避或临时降载可能推迟进度。可刷新查看。') : null)
    start.textContent = busy ? '请求中…' : running ? '检查进行中' : pendingRequestId !== null ? '重试本次启动' : replay === null ? '检查分类效果' : '重新检查'
    start.disabled = busy || running || !readable || hold !== null
    refresh.disabled = busy
  }

  const failure = (error: unknown) => {
    feedback.textContent = errorMessage(error)
    feedback.hidden = false
  }

  const load = async () => {
    if (busy) return
    busy = true
    paint()
    feedback.hidden = true
    const statusPromise = api.getServiceStatus({ name: 'serviceStatus' }).catch(() => null)
    const migrationPromise = api.getLabelConsolidation({ name: 'labelConsolidation' }).then((job) => job.state === LabelConsolidation_State.SUCCEEDED ? null : '标签正在整理，回放暂停；到整理标签查看进度').catch((error: unknown) => error instanceof ApiError && error.reason === 'NOT_FOUND' ? null : '整理状态读取失败；刷新状态后再开始')
    try {
      replay = await api.getReplayEvaluation({ name: 'replayEvaluation' }).catch((error: unknown) => {
        if (error instanceof ApiError && error.reason === 'NOT_FOUND') return null
        throw error
      })
      readable = true
      if (replay !== null && ms(replay.createTime) !== pendingBaseline) pendingRequestId = null
    } catch (error) {
      readable = false
      failure(error)
    }
    status = await statusPromise
    migrationHold = await migrationPromise
    busy = false
    paint()
  }

  const begin = async () => {
    if (busy || start.disabled) return
    busy = true
    if (pendingRequestId === null) {
      pendingBaseline = ms(replay?.createTime)
      pendingRequestId = newRequestId()
    }
    const requestId = pendingRequestId
    feedback.hidden = true
    paint()
    try {
      replay = await withRetry(() => api.startReplayEvaluation({ name: 'replayEvaluation', requestId }))
      readable = true
      pendingRequestId = null
    } catch (error) {
      failure(error)
      if (!(error instanceof ApiError) || !error.transient) pendingRequestId = null
    }
    busy = false
    paint()
  }

  box.append(content, feedback, el('div', { class: 'actions' }, start, refresh))
  await load()
  return box
}
