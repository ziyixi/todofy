/**
 * The health view (`/status`): the scheduler (the last and the next alarm, today's requests), the browser ledger ("JS
 * quota exhausted today" until 00:00 UTC), the counts, and every watch that is not well, grouped: BROKEN, blocked by a
 * bot challenge, refused by robots.txt, asked to slow down, out of JS quota, or failing its last check.
 */
import { api, errorMessage, listAllWatches } from '../api.ts'
import { el, fill } from '../dom.ts'
import { HEALTH_GROUPS, healthGroup, relative, when, type HealthGroup } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { watchRow } from './watches.ts'

const ORDER: readonly HealthGroup[] = ['broken', 'blocked', 'robots', 'rate_limited', 'js_quota', 'failing']

export async function renderHealth(ctx: ViewContext): Promise<void> {
  const body = el('div', {}, el('p', { class: 'status' }, '加载中…'))
  ctx.main.replaceChildren(el('h1', {}, '健康'), body)
  const load = async () => {
    try {
      const [status, watches] = await Promise.all([api.getServiceStatus({ name: 'serviceStatus' }), listAllWatches()])
      const now = ctx.host.now()
      const browser = !status.browserEnabled
        ? '未开放'
        : status.browserQuotaExhausted
          ? `今日 JS 配额已用完（${when(status.browserQuotaResetTime)} 重置）`
          : `已用 ${String(Math.round(status.browserUsedMs / 1000))} / ${String(Math.round(status.browserLimitMs / 1000))} 秒`
      const facts: (readonly [string, string])[] = [
        ['监视', `${String(status.activeWatchCount)} 正常 · ${String(status.brokenWatchCount)} 失效 · ${String(status.pausedWatchCount)} 已暂停`],
        ['变化', `${String(status.newChangeCount)} 新 · ${String(status.pendingChangeCount)} 待确认 · ${String(status.suppressedChangeCount)} 已过滤`],
        ['上次调度', relative(status.lastAlarmTime, now)],
        ['下次调度', status.nextAlarmTime === undefined ? '未设定（打开页面即会设定）' : relative(status.nextAlarmTime, now)],
        ['今日请求', String(status.fetchCountToday)],
        ['浏览器（JS）', browser],
        ['版本', status.build],
      ]
      const groups = new Map<HealthGroup, typeof watches>()
      for (const watch of watches) {
        const group = healthGroup(watch)
        if (group !== null) groups.set(group, [...(groups.get(group) ?? []), watch])
      }
      fill(
        body,
        el('dl', { class: 'facts' }, ...facts.flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)])),
        ...ORDER.filter((group) => groups.has(group)).map((group) =>
          el('section', { class: `group group-${group}` }, el('h2', {}, `${HEALTH_GROUPS[group]}（${String(groups.get(group)?.length ?? 0)}）`), ...(groups.get(group) ?? []).map((watch) => watchRow(ctx, watch, () => void load()))),
        ),
        groups.size === 0 ? el('p', { class: 'empty' }, '所有监视都正常。') : null,
      )
    } catch (error) {
      body.replaceChildren(el('p', { class: 'status' }, errorMessage(error)))
    }
  }
  await load()
}
