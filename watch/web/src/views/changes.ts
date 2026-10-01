/**
 * A change as a card (the inbox, the suppressed drawer and a watch's own list): what the rules said, the changed lines,
 * and its actions. "已读" acknowledges a new change. In the drawer each line can be ignored ("忽略这一行": the line goes
 * into the watch's normalize.ignored_lines, and is dropped from both sides of every comparison from the next check on;
 * the notified state stays). The toast offers 撤销 at once; any ignored line can be taken back later on the watch's
 * page (its settings list them, each with 取消忽略; its own suppressed changes offer 取消忽略 on such a line).
 *
 * For a screen reader each line says 新增 or 删除 in words (the +/− glyph is hidden), and each line's button names it.
 */
import { Change_State, DiffLine_Kind, type Change } from '@ziyixi/proto/watch/ui/v1/change_pb'
import { api, errorMessage, newRequestId, withRetry } from '../api.ts'
import { button, el, toast } from '../dom.ts'
import { CHANGE_STATES, relative, SUPPRESSION, TRIGGERS, values, watchIdOf } from '../format.ts'
import type { ViewContext } from '../app.ts'

/** Lines a card shows before "展开". */
export const LINES_SHOWN = 8
/** The most ignored lines a watch keeps (limits.ts IGNORED_LINES_MAX). */
const IGNORED_MAX = 100

/** Adds or removes `line` in the watch's ignored lines (the etag in the mask: a concurrent edit is refused). */
export async function setIgnored(watchName: string, line: string, ignore: boolean): Promise<void> {
  const watch = await api.getWatch({ name: watchName })
  const current = watch.normalize?.ignoredLines ?? []
  const next = ignore ? [...new Set([...current, line])].slice(-IGNORED_MAX) : current.filter((item) => item !== line)
  const requestId = newRequestId()
  await withRetry(() =>
    api.updateWatch({ watch: { name: watchName, etag: watch.etag, normalize: { ignoredLines: next } }, updateMask: { paths: ['normalize.ignored_lines', 'etag'] }, requestId }),
  )
}

export interface CardOptions {
  /** Show the watch's name (lists across watches). */
  readonly showWatch: boolean
  /** Offer "忽略这一行" on each line (the drawer). */
  readonly ignorable: boolean
  /** The watch's ignored lines, when known (its own page): such a line offers 取消忽略 instead. */
  readonly ignoredLines?: readonly string[]
  /** Called after an action changed the change (the list re-renders). */
  readonly onChange: () => void
}

/** The card of a change. */
export function changeCard(ctx: ViewContext, change: Change, options: CardOptions): HTMLElement {
  const watchName = `watches/${watchIdOf(change.name)}`
  const badges = [
    el('span', { class: `chip state-${String(change.state)}` }, CHANGE_STATES[change.state] ?? ''),
    change.shadow && el('span', { class: 'chip warn' }, '影子模式'),
    change.reverted && el('span', { class: 'chip' }, '已恢复原样'),
    change.state === Change_State.SUPPRESSED || change.shadow ? el('span', { class: 'chip muted' }, SUPPRESSION[change.suppressionReason] ?? '') : null,
    el('span', { class: 'chip muted' }, TRIGGERS[change.triggerKind] ?? ''),
  ]
  const title = options.showWatch ? el('a', { href: `/${watchName}`, class: 'watch-name' }, change.watchDisplayName) : null
  title?.addEventListener('click', (event) => {
    event.preventDefault()
    ctx.go(`/${watchName}`)
  })
  const valueText = values(change)
  const lines = el('ul', { class: 'diff' })
  const renderLines = (all: boolean) => {
    const shown = all ? change.diffLines : change.diffLines.slice(0, LINES_SHOWN)
    lines.replaceChildren(
      ...shown.map((line) => {
        const added = line.kind === DiffLine_Kind.ADDED
        const row = el(
          'li',
          { class: added ? 'added' : 'removed' },
          el('span', { class: 'sign', 'aria-hidden': 'true' }, added ? '+' : '−'),
          el('span', { class: 'visually-hidden' }, added ? '新增：' : '删除：'),
          el('span', { class: 'text' }, line.text),
        )
        const short = line.text.slice(0, 40)
        if (options.ignorable && (options.ignoredLines ?? []).includes(line.text)) {
          row.append(
            button('取消忽略', () => {
              void unignore(line.text)
            }, { class: 'link small', 'aria-label': `取消忽略：${short}` }),
          )
        } else if (options.ignorable) {
          row.append(
            button('忽略这一行', () => {
              void ignore(line.text)
            }, { class: 'link small', 'aria-label': `忽略这一行：${short}` }),
          )
        }
        return row
      }),
    )
    if (!all && change.diffLines.length > LINES_SHOWN) lines.append(el('li', { class: 'more' }, button(`展开全部 ${String(change.diffLines.length)} 行`, () => renderLines(true), { class: 'link' })))
  }
  const ignore = async (line: string) => {
    try {
      await setIgnored(watchName, line, true)
      toast('已忽略这一行（比较时两边都不再计入；可在监视的设置里取消）', {
        label: '撤销',
        run: () => {
          void setIgnored(watchName, line, false).then(
            () => toast('已撤销'),
            (error: unknown) => toast(errorMessage(error)),
          )
        },
      })
      options.onChange()
    } catch (error) {
      toast(errorMessage(error))
    }
  }
  const unignore = async (line: string) => {
    try {
      await setIgnored(watchName, line, false)
      toast('已取消忽略这一行')
      options.onChange()
    } catch (error) {
      toast(errorMessage(error))
    }
  }
  renderLines(false)
  const actions = el('div', { class: 'actions' })
  if (change.state === Change_State.CONFIRMED) {
    actions.append(
      button('已读', () => {
        const requestId = newRequestId()
        void withRetry(() => api.acknowledgeChange({ name: change.name, requestId })).then(
          () => options.onChange(),
          (error: unknown) => toast(errorMessage(error)),
        )
      }, { class: 'primary small' }),
    )
  }
  return el(
    'article',
    { class: 'card change', 'data-change': change.name },
    el('div', { class: 'card-head' }, title, el('span', { class: 'time' }, relative(change.detectTime, ctx.host.now()))),
    el('p', { class: 'summary' }, change.summary),
    el('div', { class: 'chips' }, ...badges),
    valueText === '' ? null : el('p', { class: 'values' }, valueText),
    lines,
    change.diffTruncated ? el('p', { class: 'hint' }, '变化行太多，只保留了前 200 行。') : null,
    actions.childElementCount > 0 ? actions : null,
  )
}
