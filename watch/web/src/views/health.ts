/**
 * The health view (`/status`): the scheduler (the last and the next alarm, today's requests), the browser ledger ("JS
 * quota exhausted today" until 00:00 UTC), the daily backup, the counts, and every watch that is not well, grouped:
 * BROKEN, blocked by a bot challenge, refused by robots.txt, asked to slow down, out of JS quota, or failing its last
 * check. On an empty store (a new object after a disaster) it offers the restore of a backup (docs/backup.md), and it
 * shows a restore's progress and its verification.
 */
import { BackupRestore_State, type ServiceStatus } from '@ziyixi/proto/watch/ui/v1/watch_ui_service_pb'
import type { Watch } from '@ziyixi/proto/watch/ui/v1/watch_pb'
import { api, errorMessage, listAllWatches } from '../api.ts'
import { button, el, fill, toast } from '../dom.ts'
import { HEALTH_GROUPS, healthGroup, relative, when, type HealthGroup } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { watchRow } from './watches.ts'

const ORDER: readonly HealthGroup[] = ['broken', 'blocked', 'robots', 'rate_limited', 'js_quota', 'failing']

function backupText(status: ServiceStatus, now: number): string {
  const failed = status.backupFailed ? '上次失败，稍后自动重试' : ''
  if (status.lastBackupTime === undefined) return failed === '' ? '尚无备份' : failed
  return failed === '' ? relative(status.lastBackupTime, now) : `${relative(status.lastBackupTime, now)}（${failed}）`
}

/** A restore's progress and verification, and on an empty store (or after a failed restore) the way to start one. */
function restoreSection(ctx: ViewContext, status: ServiceStatus, watches: readonly Watch[], reload: () => void): HTMLElement | null {
  const restore = status.restore
  const running = restore?.state === BackupRestore_State.RUNNING
  const canStart = restore?.state === BackupRestore_State.FAILED || (!running && watches.length === 0)
  if (restore === undefined && !canStart) return null
  const lines: HTMLElement[] = []
  if (restore !== undefined) {
    const state = running
      ? `正在从 ${restore.backup} 恢复，完成前不能修改；刷新查看进度`
      : restore.state === BackupRestore_State.SUCCEEDED
        ? `已从 ${restore.backup} 恢复（${when(restore.endTime)}）`
        : `从 ${restore.backup} 恢复失败（${restore.errorCode}），可以重新开始`
    lines.push(el('p', {}, state))
    if (restore.tables.length > 0) {
      lines.push(el('ul', { class: 'restore-check' }, ...restore.tables.map((table) => el('li', {}, `${table.table} ${String(table.restoredRowCount)} / ${String(table.expectedRowCount)} 行`))))
      lines.push(el('p', {}, `页面证据：恢复 ${String(restore.evidenceRestoredCount)} · 已有 ${String(restore.evidencePresentCount)} · 缺失 ${String(restore.evidenceMissingCount)} · 校验不符 ${String(restore.evidenceMismatchedCount)}`))
    }
  }
  if (canStart) {
    const input = el('input', { type: 'text', name: 'backup', 'aria-label': '备份名称', placeholder: '留空恢复最新备份，或 backups/2026-10-28T112300Z/' })
    const start = button('从备份恢复', () => {
      if (!ctx.host.confirm('把备份恢复到这个空的存储？恢复完成前不能修改。')) return
      start.disabled = true
      api.restoreBackup({ name: 'serviceStatus', backup: input.value.trim() }).then(reload, (error: unknown) => {
        start.disabled = false
        toast(errorMessage(error))
      })
    })
    lines.push(el('div', { class: 'field' }, input, start))
  }
  return el('section', { class: 'restore' }, el('h2', {}, '从备份恢复'), ...lines)
}

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
        ['备份', backupText(status, now)],
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
        restoreSection(ctx, status, watches, () => void load()),
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
