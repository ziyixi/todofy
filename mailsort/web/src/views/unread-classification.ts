/** Owner-requested priority batches, with progress from the existing service status. */
import { ClassificationProvider, Mode, ServiceStatus_AuthState, UnreadClassification_State, type ServiceStatus } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { api, errorMessage, newRequestId, withRetry } from '../api.ts'
import type { ViewContext } from '../app.ts'
import { button, el, fill } from '../dom.ts'
import { classificationProvider, classificationProviderName, classifierErrorMessage, ms, relative, when } from '../format.ts'

const PROGRESS_REFRESH_MS = 30_000
const MODEL_CONFIG_ERRORS = new Set(['claude_not_configured', 'claude_auth', 'claude_401', 'claude_403', 'codex_not_configured', 'codex_auth', 'codex_http_401', 'codex_http_403'])

export function unreadClassificationCard(ctx: ViewContext, initialStatus: ServiceStatus | null, onStatusRefresh?: () => Promise<void>): HTMLElement {
  let status = initialStatus
  let batch = status?.unreadClassification
  let busy = false
  let left = false
  let timer: number | undefined
  const progress = el('div', { class: 'unread-progress', role: 'status', 'aria-live': 'polite' })
  const feedback = el('p', { class: 'hint warn', role: 'status', hidden: true })
  const start = button('整理当前未读', () => void begin(), { class: 'primary' })
  const recheck = button('重判保底 P1', () => void begin('fallback'))
  const recheckInitial = button('重判最初100封', () => void begin('initial100'))
  const refresh = button('刷新进度', () => void load())

  const active = () => batch?.state === UnreadClassification_State.SCANNING || batch?.state === UnreadClassification_State.RUNNING
  const cancelRefresh = () => {
    window.clearTimeout(timer)
    timer = undefined
  }

  const paint = () => {
    cancelRefresh()
    const running = active()
    const scanning = batch?.state === UnreadClassification_State.SCANNING
    const completed = batch?.state === UnreadClassification_State.COMPLETED
    const provider = classificationProvider(status?.classifier?.provider)
    const claude = provider === ClassificationProvider.CLAUDE
    const modelError = status?.classifier?.lastErrorCode ?? (claude ? status?.claudeBudget?.lastErrorCode ?? '' : '')
    const nextBatch = status?.classifier?.nextBatchTime ?? (claude ? status?.claudeBudget?.nextBatchTime : undefined)
    const futureBatch = (ms(nextBatch) ?? 0) > ctx.host.now()
    let hold: string | null = null
    if (status === null) hold = '状态读取失败，请刷新进度后再开始。'
    else if (running && status.effectiveMode !== Mode.LIVE) hold = '等待切到正式模式后继续整理。当前模式保持不变。'
    else if (running && (status.authState !== ServiceStatus_AuthState.OK || !status.writeScope)) hold = '等待 Gmail 写入授权恢复后继续整理。'
    else if (running && claude && status.claudeBudget?.providerLimitReached === true) hold = 'Anthropic 工作区已达到消费上限，等待额度恢复后继续。'
    else if (running && claude && status.claudeBudget !== undefined && status.claudeBudget.limitUsd > 0 && status.claudeBudget.spentUsd >= status.claudeBudget.limitUsd) hold = '本月模型预算已用完，等待下个月继续。'
    else if (running && status.classifier?.configured === false) hold = `${classificationProviderName(provider)} 尚未配置，等待配置完成后继续。`
    else if (running && MODEL_CONFIG_ERRORS.has(modelError)) hold = `最近一次模型请求：${classifierErrorMessage(provider, modelError)}。`
    else if (running && status.gmailWriteResumeTime !== undefined) hold = `已达本应用今日 Gmail 写入上限，等待 ${when(status.gmailWriteResumeTime)}（本地时间）继续。每日额度于 UTC 00:00 重置。`
    else if (running && claude && status.claudeBudget === undefined) hold = 'Claude 用量未提供，请刷新进度或等待服务更新。'
    else if (running && modelError !== '') hold = `最近一次模型请求：${classifierErrorMessage(provider, modelError)}。`
    else if (running && (batch?.deferredCount ?? 0) > 0) hold = '部分邮件暂缓，等待下一批或后台继续处理。'
    fill(progress,
      batch === undefined ? el('p', { class: 'hint' }, '尚未开始整理。') : el('p', { class: 'hint' }, scanning ? `正在收集本轮邮件，已找到 ${String(batch.totalCount)} 封；总数尚未确定。` : completed ? '本轮整理已结束。' : '后台分批整理中。'),
      batch === undefined ? null : el('p', { class: 'hint' }, `总数 ${String(batch.totalCount)} · 待处理 ${String(batch.pendingCount)} · 已改标 ${String(batch.appliedCount)} · 重判未变 ${String(batch.unchangedCount)} · 未重判跳过 ${String(batch.skippedCount)} · 失败 ${String(batch.failedCount)} · 暂缓 ${String(batch.deferredCount)}`),
      hold === null ? null : el('p', { class: 'hint warn' }, hold),
      !running || status?.gmailWriteResumeTime !== undefined || !futureBatch ? null : el('p', { class: 'hint' }, `下批判断最早在 ${relative(nextBatch, ctx.host.now())}。`),
      running ? el('p', { class: 'meta' }, '进度每 30 秒自动更新。') : null,
    )
    start.disabled = busy || running || status === null
    recheck.disabled = start.disabled
    recheckInitial.disabled = start.disabled
    refresh.disabled = busy
    if (running && !busy && !left && !document.hidden) {
      timer = window.setTimeout(() => {
        if (!box.isConnected) leave()
        else if (!document.hidden) void load()
      }, PROGRESS_REFRESH_MS)
    }
  }

  const failure = (error: unknown) => {
    feedback.textContent = errorMessage(error)
    feedback.hidden = false
  }

  const readStatus = async () => {
    ctx.refreshStatus()
    try {
      status = await ctx.status()
      batch = status.unreadClassification
    } catch (error) {
      status = null
      failure(error)
      return
    }
    if (!left) await onStatusRefresh?.()
  }

  const load = async () => {
    if (busy || left) return
    busy = true
    feedback.hidden = true
    paint()
    await readStatus()
    busy = false
    paint()
  }

  const begin = async (recheckMode?: 'fallback' | 'initial100') => {
    if (start.disabled || left) return
    busy = true
    feedback.hidden = true
    paint()
    const requestId = newRequestId()
    try {
      batch = await withRetry(() => api.startUnreadClassification({ name: 'unreadClassification', requestId, ...(recheckMode === 'fallback' ? { recheckFallback: true } : {}), ...(recheckMode === 'initial100' ? { recheckInitial100: true } : {}) }))
      if (!left) await readStatus()
    } catch (error) {
      failure(error)
    }
    busy = false
    paint()
  }

  const box = el('section', { class: 'card unread-classification', 'aria-label': '批量分级' },
    el('h2', {}, '批量分级'),
    el('p', { class: 'hint' }, '整理当前未读邮件，包括已归档邮件，排除垃圾邮件和回收站；已有 P1–P4 标签的邮件会跳过。P1 留在收件箱，P2–P4 归档；保留邮件、未读状态、星标和其他标签。'),
    el('p', { class: 'hint' }, '重判保底 P1 只处理当前未读邮件；已读和已手动调整的邮件不动。'),
    el('p', { class: 'hint' }, '重判最初100封的对象是当前分级启用后最早成功自动分级的100封，固定按原始分级顺序选择。包括已读和已归档邮件；跳过已手动调整的邮件，保留已读状态。'),
    el('p', { class: 'hint' }, '点击后立即排队，在所选分类引擎的可用额度和 Gmail 写入额度内分批处理；额度受限时等待恢复。重判未变表示已完成分析，只更新判断证据，不再写入 Gmail；未重判跳过表示未进入本次模型判断。已改标只统计 Gmail 已确认的修改。'),
    progress,
    feedback,
    el('div', { class: 'actions' }, start, recheck, recheckInitial, refresh),
  )
  const visibilityChanged = () => {
    if (!box.isConnected) leave()
    else if (document.hidden) cancelRefresh()
    else if (active()) void load()
  }
  const leave = () => {
    left = true
    cancelRefresh()
    document.removeEventListener('visibilitychange', visibilityChanged)
  }
  document.addEventListener('visibilitychange', visibilityChanged)
  ctx.onLeave(leave)
  paint()
  return box
}
