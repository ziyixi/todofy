/**
 * 来源 (`/sources`, ../../docs/design.md §3.2, §10, §11): every source of the registry in its order, by section, with
 * a line of counts on top. A row: the name (with the registry's ID when several sources share it: six arXiv queries),
 * a chip for any state but 正常 (失败, 已暂停, 沉寂, 未抓取) and for a signal-only source, the last accepted item's
 * title, its recent volume and when it last brought an item, its learned weight and the votes behind it, and for a
 * problem one sentence on what happens next. Disabled sources are folded away. Read-only: the registry is edited in
 * the repository (content-config/sources.yaml).
 */
import { Section } from '@ziyixi/proto/brief/ui/v1/issue_pb'
import { Source_Role, Source_State, type Source } from '@ziyixi/proto/brief/ui/v1/source_pb'
import { api, listAll } from '../api.ts'
import { card, chip, disclosure, emptyState } from '../components.ts'
import { el, fill } from '../dom.ts'
import { pollError, relative, SECTION_NAMES, SOURCE_STATES, weight } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { frame } from './common.ts'

/** A gap in hours in words: `18 小时`, `3 天`. */
function gap(hours: number): string {
  return hours < 48 ? `${String(Math.max(1, Math.round(hours)))} 小时` : `${String(Math.round(hours / 24))} 天`
}

/** What happens to a source in trouble, in one sentence; null when it is fine. */
function trouble(source: Source, now: number): string | null {
  const error = source.lastErrorCode === '' ? '' : `（${pollError(source.lastErrorCode)}）`
  if (source.state === Source_State.FAILING) return `连续失败 ${String(source.failureCount)} 次${error}，照常再试`
  if (source.state === Source_State.PAUSED) return `连续失败 ${String(source.failureCount)} 次后暂停${error}，每天再试一次`
  if (source.state === Source_State.STALE) {
    const since = source.lastItemTime === undefined ? '很久' : relative(source.lastItemTime, now).replace(/前$/, '')
    return `${since}没有新条目${source.usualGapHours > 0 ? `，通常每 ${gap(source.usualGapHours)}一条` : ''}：可能换了地址或过滤太严`
  }
  return null
}

function row(source: Source, now: number, shared: ReadonlySet<string>): HTMLElement {
  const [state, problem] = SOURCE_STATES[source.state] ?? ['—', false]
  const problemText = trouble(source, now)
  const voted = source.shownCount > 0
  return el(
    'li',
    {},
    el(
      'div',
      { class: 'row-head' },
      el('span', { class: 'row-title' }, source.displayName, shared.has(source.displayName) ? el('span', { class: 'meta' }, ` ${source.name.replace(/^sources\//, '')}`) : null),
      source.role === Source_Role.SIGNAL_ONLY ? chip('仅信号', 'muted') : null,
      source.state === Source_State.OK || source.state === Source_State.DISABLED ? null : chip(state, problem ? 'warn' : 'muted'),
    ),
    source.lastItemTitle === '' ? null : el('p', { class: 'row-sub' }, `最新：${source.lastItemTitle}`),
    el(
      'p',
      { class: 'facts' },
      source.state === Source_State.DISABLED ? null : el('span', {}, `近 7 天 ${String(source.recentItemCount)} 条`),
      source.lastItemTime === undefined ? null : el('span', {}, `上次 ${relative(source.lastItemTime, now)}`),
      voted || source.weight !== 1 ? el('span', {}, `权重 ${weight(source.weight)}`) : null,
      voted ? el('span', {}, `上过 ${String(source.shownCount)} 条 · 👍 ${String(source.upCount)} · 👎 ${String(source.downCount)} · 多来点 ${String(source.moreCount)}`) : null,
    ),
    problemText === null ? null : el('p', { class: 'hint warn' }, problemText),
  )
}

/** The line of counts: how many sources are in use and how many are in each state. */
function summary(sources: readonly Source[]): HTMLElement {
  const states = [Source_State.OK, Source_State.FAILING, Source_State.PAUSED, Source_State.STALE, Source_State.NEW]
  return el(
    'p',
    { class: 'facts lead' },
    el('span', {}, `在用 ${String(sources.length)} 个`),
    ...states.map((state) => {
      const found = sources.filter((source) => source.state === state).length
      const [name, problem] = SOURCE_STATES[state] ?? ['', false]
      return found === 0 && state !== Source_State.OK ? null : el('span', problem ? { class: 'warn' } : {}, `${name} ${String(found)}`)
    }),
  )
}

export async function renderSources(ctx: ViewContext): Promise<void> {
  const now = ctx.host.now()
  await frame(ctx.main, '来源', async (body) => {
    const sources = await listAll(async (pageToken) => {
      const page = await api.listSources({ pageSize: 100, pageToken })
      return { items: page.sources, next: page.nextPageToken }
    }, 3)
    if (sources.length === 0) {
      body.replaceChildren(emptyState('还没有来源'))
      return
    }
    const names = sources.map((source) => source.displayName)
    const shared = new Set(names.filter((name, index) => names.indexOf(name) !== index))
    const used = sources.filter((source) => source.state !== Source_State.DISABLED)
    const off = sources.filter((source) => source.state === Source_State.DISABLED)
    const bySection = (section: Section) => used.filter((source) => source.section === section)
    fill(
      body,
      summary(used),
      ...[Section.RESEARCH, Section.WORLD].map((section) => {
        const own = bySection(section)
        return own.length === 0 ? null : card(SECTION_NAMES[section] ?? '', `${String(own.length)} 个`, el('ul', { class: 'rows' }, ...own.map((source) => row(source, now, shared))))
      }),
      off.length === 0 ? null : disclosure(`已停用 ${String(off.length)} 个`, el('ul', { class: 'rows' }, ...off.map((source) => row(source, now, shared)))),
      el('p', { class: 'hint center' }, '来源在仓库的 content-config/sources.yaml 中修改，随部署生效'),
    )
  })
}
