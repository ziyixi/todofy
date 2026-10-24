/** Owner-requested unread batch, with progress from the existing service status. */
import { Mode, ServiceStatus_AuthState, UnreadClassification_State, type ServiceStatus } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { api, errorMessage, newRequestId, withRetry } from '../api.ts'
import type { ViewContext } from '../app.ts'
import { button, el, fill } from '../dom.ts'

export function unreadClassificationCard(ctx: ViewContext, initialStatus: ServiceStatus | null): HTMLElement {
  let status = initialStatus
  let batch = status?.unreadClassification
  let busy = false
  const progress = el('div', { class: 'unread-progress', role: 'status', 'aria-live': 'polite' })
  const feedback = el('p', { class: 'hint warn', role: 'status', hidden: true })
  const start = button('开始整理', () => void begin(), { class: 'primary' })
  const recheck = button('重判保底 P1', () => void begin(true))
  const refresh = button('刷新进度', () => void load())

  const paint = () => {
    const active = batch?.state === UnreadClassification_State.SCANNING || batch?.state === UnreadClassification_State.RUNNING
    const scanning = batch?.state === UnreadClassification_State.SCANNING
    const completed = batch?.state === UnreadClassification_State.COMPLETED
    let hold: string | null = null
    if (status === null) hold = '状态读取失败，请刷新进度后再开始。'
    else if (active && status.effectiveMode !== Mode.LIVE) hold = '等待切到正式模式后继续整理。当前模式保持不变。'
    else if (active && (status.authState !== ServiceStatus_AuthState.OK || !status.writeScope)) hold = '等待 Gmail 写入授权恢复后继续整理。'
    else if (active && status.aiQuotaExhausted) hold = '今日模型配额已用完，等待下一个 UTC 日继续。'
    else if (active && status.dailyNeuronBudget > 0 && status.neuronsToday >= status.dailyNeuronBudget) hold = '今日模型预算已用完，等待下一个 UTC 日继续。'
    else if (active && (batch?.deferredCount ?? 0) > 0) hold = '部分邮件暂缓，后台会按既有重试时间继续。'
    fill(progress,
      batch === undefined ? el('p', { class: 'hint' }, '尚未开始整理。') : el('p', { class: 'hint' }, scanning ? `正在查找未读邮件，已找到 ${String(batch.totalCount)} 封；总数尚未确定。` : completed ? '本轮整理已结束。' : '后台分批整理中。'),
      batch === undefined ? null : el('p', { class: 'hint' }, `总数 ${String(batch.totalCount)} · 待处理 ${String(batch.pendingCount)} · 已应用 ${String(batch.appliedCount)} · 已跳过 ${String(batch.skippedCount)} · 失败 ${String(batch.failedCount)} · 暂缓 ${String(batch.deferredCount)}`),
      hold === null ? null : el('p', { class: 'hint warn' }, hold),
    )
    start.disabled = busy || active || status === null
    recheck.disabled = start.disabled
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

  const begin = async (recheckFallback = false) => {
    if (start.disabled) return
    busy = true
    feedback.hidden = true
    paint()
    const requestId = newRequestId()
    try {
      batch = await withRetry(() => api.startUnreadClassification({ name: 'unreadClassification', requestId, ...(recheckFallback ? { recheckFallback: true } : {}) }))
      ctx.refreshStatus()
    } catch (error) {
      failure(error)
    }
    busy = false
    paint()
  }

  const box = el('section', { class: 'card unread-classification', 'aria-label': '整理当前未读邮件' },
    el('h2', {}, '整理当前未读邮件'),
    el('p', { class: 'hint' }, '整理当前所有未读邮件，包括已归档邮件，排除垃圾邮件和回收站。P1 留在收件箱，P2–P4 归档；保留邮件、未读状态、星标和其他标签。'),
    el('p', { class: 'hint' }, '重判只处理当前未读的保底 P1；已读和已手动调整的邮件不动。'),
    el('p', { class: 'hint' }, '使用现有模型预算；模型额度用完后等待下一个 UTC 日继续。已应用只统计 Gmail 已确认的修改。'),
    progress,
    feedback,
    el('div', { class: 'actions' }, start, recheck, refresh),
  )
  paint()
  return box
}
