/**
 * 运行状态 (`/status`): the Gmail grant, the mode in force, the last sync, the queue, today's Gmail and Workers AI use
 * (estimated neurons against the budget, the decision model in use) and the latest error codes.
 */
import { api } from '../api.ts'
import { el, fill } from '../dom.ts'
import { AUTH_STATES, MODE_NAMES, relative } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { frame } from './common.ts'

export async function renderStatus(ctx: ViewContext): Promise<void> {
  await frame(ctx.main, '运行状态', async (body) => {
    const status = await api.getServiceStatus({ name: 'serviceStatus' })
    const now = ctx.host.now()
    const facts: (readonly [string, string])[] = [
      ['模式', MODE_NAMES[status.effectiveMode] ?? '—'],
      ['Gmail 授权', `${AUTH_STATES[status.authState] ?? '—'}${status.writeScope ? '（可打标签）' : '（只读）'}`],
      ['上次同步', relative(status.lastSyncTime, now)],
      ['下次运行', status.nextAlarmTime === undefined ? '未设定（打开页面即会设定）' : relative(status.nextAlarmTime, now)],
      ['待处理', `${String(status.pendingCount)} 封${status.deferredCount > 0 ? `，${String(status.deferredCount)} 封等明天的模型额度` : ''}`],
      ['待审', String(status.reviewCount)],
      ['今天', `判断 ${String(status.decidedTodayCount)} · 打标签 ${String(status.appliedTodayCount)} · 拿不准 ${String(status.unsureTodayCount)}`],
      ['Gmail 请求', String(status.gmailCallTodayCount)],
      ['模型调用', `${String(status.aiCallTodayCount)} 次，约 ${String(Math.round(status.neuronsToday))} / ${String(status.dailyNeuronBudget)} neurons`],
      ['决策模型', `${status.decisionModel}${status.aiQuotaExhausted ? '（今日 Workers AI 额度已用完）' : ''}`],
      ['待生成向量', String(status.unembeddedExampleCount)],
      ['最近错误', status.recentErrorCodes.length === 0 ? '无' : status.recentErrorCodes.join(', ')],
      ['版本', status.build],
    ]
    fill(body, el('dl', { class: 'facts' }, ...facts.flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)])))
  })
}
