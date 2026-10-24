/** Owner-requested priority batches, with progress from the existing service status. */
import { Mode, ServiceStatus_AuthState, UnreadClassification_State, type ServiceStatus } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { api, errorMessage, newRequestId, withRetry } from '../api.ts'
import type { ViewContext } from '../app.ts'
import { button, el, fill } from '../dom.ts'
import { claudeErrorMessage, relative } from '../format.ts'

export function unreadClassificationCard(ctx: ViewContext, initialStatus: ServiceStatus | null): HTMLElement {
  let status = initialStatus
  let batch = status?.unreadClassification
  let busy = false
  const progress = el('div', { class: 'unread-progress', role: 'status', 'aria-live': 'polite' })
  const feedback = el('p', { class: 'hint warn', role: 'status', hidden: true })
  const start = button('整理当前未读', () => void begin(), { class: 'primary' })
  const recheck = button('重判保底 P1', () => void begin('fallback'))
  const recheckInitial = button('重判原100封', () => void begin('initial100'))
  const refresh = button('刷新进度', () => void load())

  const paint = () => {
    const active = batch?.state === UnreadClassification_State.SCANNING || batch?.state === UnreadClassification_State.RUNNING
    const scanning = batch?.state === UnreadClassification_State.SCANNING
    const completed = batch?.state === UnreadClassification_State.COMPLETED
    let hold: string | null = null
    if (status === null) hold = '状态读取失败，请刷新进度后再开始。'
    else if (active && status.effectiveMode !== Mode.LIVE) hold = '等待切到正式模式后继续整理。当前模式保持不变。'
    else if (active && (status.authState !== ServiceStatus_AuthState.OK || !status.writeScope)) hold = '等待 Gmail 写入授权恢复后继续整理。'
    else if (active && status.claudeBudget === undefined) hold = 'Claude 用量未提供，请刷新进度或等待服务更新。'
    else if (active && status.claudeBudget?.providerLimitReached === true) hold = 'Anthropic 工作区已达到消费上限，等待额度恢复后继续。'
    else if (active && status.claudeBudget !== undefined && status.claudeBudget.limitUsd > 0 && status.claudeBudget.spentUsd >= status.claudeBudget.limitUsd) hold = '本月模型预算已用完，等待下个月继续。'
    else if (active && status.claudeBudget?.lastErrorCode) hold = `最近一次模型请求：${claudeErrorMessage(status.claudeBudget.lastErrorCode)}。`
    else if (active && (batch?.deferredCount ?? 0) > 0) hold = '部分邮件暂缓，后台会按既有重试时间继续。'
    fill(progress,
      batch === undefined ? el('p', { class: 'hint' }, '尚未开始整理。') : el('p', { class: 'hint' }, scanning ? `正在收集本轮邮件，已找到 ${String(batch.totalCount)} 封；总数尚未确定。` : completed ? '本轮整理已结束。' : '后台分批整理中。'),
      batch === undefined ? null : el('p', { class: 'hint' }, `总数 ${String(batch.totalCount)} · 待处理 ${String(batch.pendingCount)} · 已应用 ${String(batch.appliedCount)} · 已跳过 ${String(batch.skippedCount)} · 失败 ${String(batch.failedCount)} · 暂缓 ${String(batch.deferredCount)}`),
      hold === null ? null : el('p', { class: 'hint warn' }, hold),
      !active || status?.claudeBudget?.nextBatchTime === undefined ? null : el('p', { class: 'hint' }, `下批判断最早在 ${relative(status.claudeBudget.nextBatchTime, ctx.host.now())}，通常约每小时一批。`),
    )
    start.disabled = busy || active || status === null
    recheck.disabled = start.disabled
    recheckInitial.disabled = start.disabled
    refresh.disabled = busy
  }

  const failure = (error: unknown) => {
    feedback.textContent = errorMessage(error)
    feedback.hidden = false
  }

  const load = async () => {
    if (busy) return
    busy = true
    feedback.hidden = true
    paint()
    ctx.refreshStatus()
    try {
      status = await ctx.status()
      batch = status.unreadClassification
    } catch (error) {
      status = null
      failure(error)
    }
    busy = false
    paint()
  }

  const begin = async (recheckMode?: 'fallback' | 'initial100') => {
    if (start.disabled) return
    busy = true
    feedback.hidden = true
    paint()
    const requestId = newRequestId()
    try {
      batch = await withRetry(() => api.startUnreadClassification({ name: 'unreadClassification', requestId, ...(recheckMode === 'fallback' ? { recheckFallback: true } : {}), ...(recheckMode === 'initial100' ? { recheckInitial100: true } : {}) }))
      ctx.refreshStatus()
    } catch (error) {
      failure(error)
    }
    busy = false
    paint()
  }

  const box = el('section', { class: 'card unread-classification', 'aria-label': '批量分级' },
    el('h2', {}, '批量分级'),
    el('p', { class: 'hint' }, '整理当前所有未读邮件，包括已归档邮件，排除垃圾邮件和回收站。P1 留在收件箱，P2–P4 归档；保留邮件、未读状态、星标和其他标签。'),
    el('p', { class: 'hint' }, '重判保底 P1 只处理当前未读邮件；已读和已手动调整的邮件不动。'),
    el('p', { class: 'hint' }, '重判原100封会重新判断新分级启用后最早自动分级的100封，包括已读和已归档邮件；跳过已手动调整的邮件，保留已读状态。'),
    el('p', { class: 'hint' }, 'Claude 约每小时批量判断，使用配置的月度预算；达到消费上限后等待额度恢复。重判后级别未变时只更新判断证据，计入已跳过，不写入 Gmail。已应用只统计 Gmail 已确认的修改。'),
    progress,
    feedback,
    el('div', { class: 'actions' }, start, recheck, recheckInitial, refresh),
  )
  paint()
  return box
}
