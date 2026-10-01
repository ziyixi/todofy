/**
 * One watch (`/watches/<id>`): its health (the last and next check, what failed, the failures in a row, the masked
 * changes, a pending confirmation, the site's backoff, shadow mode), its actions (check now, pause or resume, delete),
 * its settings (saved with SAVE_MASK and the etag: only what the form edits is written, and an edit made elsewhere
 * meanwhile is refused and the latest is loaded), its ignored lines with 取消忽略, and its changes, with the
 * suppressed ones and their "忽略这一行" (or 取消忽略 for a line already ignored).
 */
import { Change_State } from '@ziyixi/proto/watch/ui/v1/change_pb'
import { Watch_State, type Watch } from '@ziyixi/proto/watch/ui/v1/watch_pb'
import { api, ApiError, errorMessage, newRequestId, withRetry } from '../api.ts'
import { button, el, fill, toast } from '../dom.ts'
import { failureText, relative, watchState, when } from '../format.ts'
import { draftOf, SAVE_MASK, settingsForm, watchOf } from '../settings.ts'
import type { ViewContext } from '../app.ts'
import { changeCard, setIgnored } from './changes.ts'
import { lastCheck } from './watches.ts'

const FILTERS: readonly (readonly [string, string])[] = [
  ['', '全部'],
  ['state = NEW', '新'],
  ['state = PENDING_CONFIRMATION', '待确认'],
  ['state = SUPPRESSED', '已过滤'],
]

export async function renderDetail(ctx: ViewContext, id = ''): Promise<void> {
  const name = `watches/${id}`
  let filter = ''
  const head = el('div', {})
  const changes = el('section', { class: 'list', 'aria-label': '变化' })
  const tabs = el('div', { class: 'row filters' })
  const settings = el('details', { class: 'more-settings' }, el('summary', {}, '设置'))
  ctx.main.replaceChildren(head, settings, el('h2', {}, '变化'), tabs, changes)

  let ignoredLines: readonly string[] = []
  const loadChanges = async () => {
    tabs.replaceChildren(...FILTERS.map(([value, label]) => button(label, () => {
      filter = value
      void loadChanges()
    }, { class: 'small', 'aria-pressed': String(filter === value) })))
    try {
      const page = await api.listChanges({ parent: name, filter, pageSize: 50 })
      changes.replaceChildren(
        ...page.changes.map((change) => changeCard(ctx, change, { showWatch: false, ignorable: change.state === Change_State.SUPPRESSED || change.shadow, ignoredLines, onChange: () => void load() })),
      )
      if (page.changes.length === 0) changes.append(el('p', { class: 'empty' }, '没有变化。'))
    } catch (error) {
      changes.replaceChildren(el('p', { class: 'status' }, errorMessage(error)))
    }
  }

  const act = (label: string, run: (requestId: string) => Promise<Watch>, done: string) =>
    button(label, () => {
      const requestId = newRequestId()
      void withRetry(() => run(requestId)).then(
        () => {
          toast(done)
          void load()
        },
        (error: unknown) => toast(errorMessage(error)),
      )
    }, { class: 'small' })

  const renderHead = (watch: Watch) => {
    const now = ctx.host.now()
    const state = watchState(watch)
    const health = watch.health
    const facts: (readonly [string, string])[] = [
      ['网址', watch.uri],
      ['上次检查', lastCheck(watch, now)],
      ['下次检查', health?.nextCheckTime === undefined ? '暂停中' : `${when(health.nextCheckTime)}（${relative(health.nextCheckTime, now)}）`],
    ]
    if ((health?.consecutiveFailureCount ?? 0) > 0) facts.push(['连续失败', `${String(health?.consecutiveFailureCount ?? 0)} 次，自 ${when(health?.failureStartTime)}：${failureText(health?.lastFailure ?? 0, health?.lastHttpStatus ?? 0)}`])
    if (health?.backoffEndTime !== undefined) facts.push(['网站要求放慢', `直到 ${when(health.backoffEndTime)}`])
    if ((health?.maskedChangeCount ?? 0) > 0) facts.push(['被遮盖的变化', `${String(health?.maskedChangeCount ?? 0)} 次（相对时间、时间戳等）`])
    if (watch.shadowMode) facts.push(['影子模式', `到 ${when(watch.shadowEndTime)}`])
    const paused = watch.state === Watch_State.PAUSED
    fill(
      head,
      el('div', { class: 'row' }, el('h1', {}, watch.displayName), el('span', { class: `chip ${state.tone}` }, state.label)),
      el('dl', { class: 'facts' }, ...facts.flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)])),
      health?.pendingConfirmation === true ? el('p', { class: 'hint' }, '有一个变化等待约 15 分钟后的二次确认。') : null,
      el(
        'div',
        { class: 'actions' },
        act('立即检查', (requestId) => api.checkWatch({ name, requestId }), '已安排检查'),
        paused ? act('恢复', (requestId) => api.resumeWatch({ name, etag: watch.etag, requestId }), '已恢复') : act('暂停', (requestId) => api.pauseWatch({ name, etag: watch.etag, requestId }), '已暂停'),
        button('删除', () => {
          if (!ctx.host.confirm(`删除“${watch.displayName}”和它的全部变化记录？`)) return
          const requestId = newRequestId()
          void withRetry(() => api.deleteWatch({ name, etag: watch.etag, requestId })).then(
            () => {
              toast('已删除')
              ctx.go('/watches')
            },
            (error: unknown) => toast(errorMessage(error)),
          )
        }, { class: 'small danger' }),
      ),
    )
  }

  const renderSettings = (watch: Watch) => {
    const draft = draftOf(watch)
    const unignore = async (line: string) => {
      try {
        await setIgnored(name, line, false)
        toast('已取消忽略这一行')
        await load()
      } catch (error) {
        toast(errorMessage(error))
      }
    }
    const form = settingsForm(draft, () => undefined, { onUnignore: unignore })
    const uri = el('input', { type: 'url', 'aria-label': '网址', autocapitalize: 'none', spellcheck: 'false' })
    uri.value = draft.uri
    uri.addEventListener('input', () => {
      draft.uri = uri.value.trim()
    })
    const requestId = newRequestId()
    const save = button('保存设置', () => {
      // Only what the form edits (SAVE_MASK): a field it does not show, and the ignored lines, stay as stored.
      void withRetry(() => api.updateWatch({ watch: watchOf(draft), updateMask: { paths: [...SAVE_MASK] }, requestId })).then(
        () => {
          toast('已保存')
          void load()
        },
        (error: unknown) => {
          toast(errorMessage(error))
          if (error instanceof ApiError && error.watch !== null) void load()
        },
      )
    }, { class: 'primary' })
    settings.replaceChildren(el('summary', {}, '设置'), el('label', { class: 'field' }, el('span', { class: 'label' }, '网址'), uri), form.element, el('div', { class: 'actions' }, save))
  }

  const load = async () => {
    try {
      const watch = await api.getWatch({ name })
      ignoredLines = watch.normalize?.ignoredLines ?? []
      renderHead(watch)
      renderSettings(watch)
      await loadChanges()
    } catch (error) {
      head.replaceChildren(el('p', { class: 'status' }, errorMessage(error)))
    }
  }
  await load()
}
