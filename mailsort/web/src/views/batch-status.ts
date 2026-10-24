/** The hourly runner's evidence, separate from the Gmail writes it handed over. */
import type { ServiceStatus } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { Mode } from '@ziyixi/proto/mailsort/ui/v2/status_pb'
import { card } from '../components.ts'
import { el } from '../dom.ts'
import { ms, relative, when } from '../format.ts'

export const BATCH_ERRORS: Readonly<Record<string, string>> = {
  codex_not_logged_in: 'Codex 登录失效，请重新登录 Runner 的专用账号；邮件保持未分类。',
  codex_model_unavailable: '当前账号或运行时无法使用 6.1 Sol，请检查 Runner 的登录和版本。',
  codex_quota_exhausted: 'Codex 订阅额度暂不可用，下一次小时检查会继续；邮件保持未分类。',
  codex_failed: '模型本次未完成有效判断，下一次小时检查会继续；邮件保持未分类。',
  claim_failed: '读取本轮邮件失败，请检查 Mailsort 和 Gmail 授权。',
  report_failed: '提交判断失败，请检查 Runner 与 Mailsort 的连接。',
}

export function batchStatusCard(status: ServiceStatus, now: number): HTMLElement {
  const batch = status.batchStatus
  if (batch === undefined) return card('每小时分类', '', el('p', { class: 'hint' }, '等待首次小时检查。每小时整点处理尚未分类的未读邮件。'))
  const names: Readonly<Record<string, string>> = { running: '正在分类', completed: '本轮检查完成', failed: '本轮失败' }
  const last = ms(batch.completedTime) ?? ms(batch.startedTime)
  const stale = status.effectiveMode !== Mode.OFF && last !== null && now - last > 2 * 3_600_000
  const tokens = batch.inputTokens === undefined || batch.outputTokens === undefined
    ? '本轮模型用量未提供'
    : `本轮 token：输入 ${batch.inputTokens.toLocaleString()} · 输出 ${batch.outputTokens.toLocaleString()}${batch.usagePartial ? '（记录不完整）' : ''}`
  return card('每小时分类', `${batch.model || 'gpt-6.1-sol'} · ${batch.effort || 'medium'}`,
    el('p', { class: batch.state === 'failed' ? 'hint warn' : 'hint' }, names[batch.state] ?? '等待检查'),
    el('p', { class: 'hint' }, `最近开始：${when(batch.startedTime)} · 最近完成：${when(batch.completedTime)}`),
    el('p', { class: 'hint' }, `本轮选中 ${String(batch.selectedCount)} 封 · 判断已保存 ${String(batch.judgedCount)} 封 · 待写入 Gmail ${String(batch.pendingWriteCount)} 封`),
    batch.state === 'completed' && batch.selectedCount === 0 ? el('p', { class: 'hint' }, '本轮没有需要模型判断的邮件，未调用模型。') : null,
    batch.errorCode === '' ? null : el('p', { class: 'hint warn' }, BATCH_ERRORS[batch.errorCode] ?? `本轮失败（${batch.errorCode}），请检查 Runner 状态。`),
    stale ? el('p', { class: 'hint warn' }, `超过两小时没有完整检查，最近完成 ${relative(batch.completedTime, now)}；请检查 VPS 的 mailsort-runner 小时任务。`) : null,
    el('p', { class: 'hint' }, tokens),
    batch.promptSha === '' ? null : el('p', { class: 'hint' }, `Prompt ${batch.promptSha.slice(0, 12)}`),
    el('p', { class: 'hint' }, '每小时整点检查；已保存的判断会继续写入 Gmail。模型失败时保留未分类状态。'),
  )
}
