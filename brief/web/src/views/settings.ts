/**
 * 设置 (`/settings`, ../../docs/design.md §11, §13, §15): two cards and the build.
 *
 * - 运行: the deployment's mode (BRIEF_MODE, not the owner's to change here: design §19), the Claude key (恢复调用
 *   after a refusal that repeats, once the owner fixed what it named), mail, the next run or the issue being made,
 *   today's counts, the sources' health, and 暂停 (no model call and no send; fetching and the archive go on), the
 *   emergency stop.
 * - 预算: the month's spend and reservations against the monthly budget (5 to 100 dollars), and the budget itself.
 *
 * Every change names only its field and the settings' etag in the mask; a stale etag reloads the page's values.
 */
import { create } from '@ziyixi/proto/protobuf'
import { Mode, ServiceStatus_KeyState, SettingsSchema, type ServiceStatus, type Settings } from '@ziyixi/proto/brief/ui/v1/status_pb'
import { api } from '../api.ts'
import { card, disclosure, meter, toggle } from '../components.ts'
import { button, el, toast, type Child } from '../dom.ts'
import { budget, count, dayText, issueDay, MODE_HINTS, MODE_NAMES, relative, stepName, usd } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { act, frame } from './common.ts'

/** The monthly budget's range (Settings.monthly_budget_usd). */
const BUDGET_MIN = 5
const BUDGET_MAX = 100

/** One fact of 运行: its name, then its value and an optional quiet line under it. */
function fact(name: string, value: Child, hint: Child = null): HTMLElement[] {
  return [el('dt', {}, name), el('dd', {}, value, hint === null || hint === false ? null : el('span', { class: 'hint' }, hint))]
}

function update(settings: Settings, change: Partial<Pick<Settings, 'paused' | 'monthlyBudgetUsd'>>, requestId: string): Promise<Settings> {
  const paths = [...('paused' in change ? ['paused'] : []), ...('monthlyBudgetUsd' in change ? ['monthly_budget_usd'] : []), 'etag']
  return api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', etag: settings.etag, ...change }), updateMask: { paths }, requestId })
}

function runCard(settings: Settings, status: ServiceStatus, ctx: ViewContext, after: () => Promise<void>): HTMLElement {
  const now = ctx.host.now()
  const sending = status.mode === Mode.SHADOW || status.mode === Mode.LIVE
  const resume = () => {
    if (!ctx.host.confirm('恢复模型调用？请先在 Console 处理好它拒绝的原因（额度、密钥或模型权限），否则下一次调用会再被拒。')) return
    void act((requestId) => api.resumeModelCalls({ name: 'serviceStatus', requestId }), '已恢复调用', after)
  }
  const key =
    status.keyState === ServiceStatus_KeyState.REJECTED
      ? el(
          'span',
          { class: 'key' },
          el('span', { class: 'warn' }, `被拒（HTTP ${String(status.rejectedStatus)}${status.rejectedErrorType === '' ? '' : ` · ${status.rejectedErrorType}`}），模型调用已全部停止`),
          button('恢复调用', resume, { class: 'primary small' }),
        )
      : status.keyState === ServiceStatus_KeyState.NOT_CONFIGURED
        ? el('span', { class: 'warn' }, '未设置：owner 在本机用 wrangler secret put 写入')
        : el('span', {}, '正常')
  const current = issueDay(status.currentIssue)
  const run =
    current === ''
      ? el('span', {}, status.nextAlarmTime === undefined ? '—' : relative(status.nextAlarmTime, now))
      : el('span', {}, `正在制作 ${dayText(current, now)} · ${stepName(status.currentStep)}`)
  const [pause, input] = toggle('暂停', settings.paused, '停止所有模型调用和发信，抓取与归档照常；暂停期间到期的期刊不会生成')
  input.addEventListener('change', () => {
    const paused = input.checked
    void act((requestId) => update(settings, { paused }, requestId), paused ? '已暂停' : '已取消暂停', after).then(async (answer) => {
      if (answer === null) await after()
    })
  })
  return card(
    '运行',
    '',
    el(
      'dl',
      { class: 'kv' },
      ...fact('模式', MODE_NAMES[status.mode] ?? '—', `${MODE_HINTS[status.mode] ?? ''}（部署变量 BRIEF_MODE）`),
      ...fact('Claude 密钥', key),
      ...fact('发信', el('span', !status.mailConfigured && sending ? { class: 'warn' } : {}, status.mailConfigured ? '已配置' : '未配置')),
      ...fact(current === '' ? '下次运行' : '进行中', run),
      ...fact('今日', `抓取 ${count(status.todayItemCount)} 条 · 初筛 ${count(status.todayCandidateCount)} 条 · 向量 ${count(Math.round(status.todayNeurons))} 神经元`),
      ...fact(
        '来源',
        el(
          'span',
          {},
          `正常 ${String(status.okSourceCount)}`,
          status.failingSourceCount > 0 ? el('span', { class: 'warn' }, ` · 失败 ${String(status.failingSourceCount)}`) : null,
          status.staleSourceCount > 0 ? el('span', { class: 'warn' }, ` · 沉寂 ${String(status.staleSourceCount)}`) : null,
        ),
      ),
    ),
    pause,
    status.recentErrorCodes.length === 0 ? null : disclosure(`最近的错误代码（${String(status.recentErrorCodes.length)}）`, el('ul', { class: 'codes' }, ...status.recentErrorCodes.map((code) => el('li', { class: 'mono' }, code)))),
  )
}

function budgetCard(settings: Settings, status: ServiceStatus, after: () => Promise<void>): HTMLElement {
  const limit = settings.monthlyBudgetUsd
  const spent = status.monthCostUsd + status.reservedUsd
  const field = el('input', { type: 'number', inputmode: 'decimal', min: String(BUDGET_MIN), max: String(BUDGET_MAX), step: '1', value: String(limit), 'aria-label': '每月预算（美元）' })
  const form = el('form', { class: 'actions budget' }, el('span', { 'aria-hidden': 'true' }, '$'), field, button('保存', () => undefined, { type: 'submit' }))
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const value = Number(field.value)
    if (field.value.trim() === '' || !Number.isFinite(value) || value < BUDGET_MIN || value > BUDGET_MAX) {
      toast(`每月预算须在 ${String(BUDGET_MIN)} 到 ${String(BUDGET_MAX)} 美元之间`)
      return
    }
    if (value === limit) return
    void act((requestId) => update(settings, { monthlyBudgetUsd: value }, requestId), `每月预算改为 ${budget(value)}`, after).then(async (answer) => {
      if (answer === null) await after()
    })
  })
  return card(
    '预算',
    `本月 ${usd(status.monthCostUsd)} / ${budget(limit)}`,
    meter(spent, limit, '本月花费与预留', limit > 0 && spent >= 0.8 * limit ? 'warn' : ''),
    el(
      'p',
      { class: 'facts' },
      el('span', {}, `今日 ${usd(status.todayCostUsd)}`),
      status.reservedUsd > 0 ? el('span', {}, `预留 ${usd(status.reservedUsd)}`) : null,
      el('span', spent >= limit ? { class: 'warn' } : {}, `剩余 ${usd(Math.max(0, limit - spent))}`),
    ),
    el('p', { class: 'hint' }, '按 Claude API 报告的用量计费，每次调用前按上限预留；超出后不再开始新的调用，直到下月或调高预算。Console 工作区的花费上限是最外一道墙。'),
    form,
  )
}

export async function renderSettings(ctx: ViewContext): Promise<void> {
  const reload: () => Promise<void> = await frame(ctx.main, '设置', async (body) => {
    const [settings, status] = await Promise.all([api.getSettings({ name: 'settings' }), ctx.status()])
    const after = async () => {
      ctx.refreshStatus()
      await reload()
    }
    body.replaceChildren(runCard(settings, status, ctx, after), budgetCard(settings, status, after), ...(status.build === '' ? [] : [el('p', { class: 'meta build' }, `版本 ${status.build.slice(0, 7)}`)]))
  })
}
