/**
 * The change inbox (`/`): confirmed changes not read yet, across every watch, newest first (ListChanges on watches/-
 * with `state = NEW`), and below it the suppressed drawer: what the rules dropped, each with its reason and an
 * "忽略这一行" per line. Changes waiting for their confirmation fetch are counted, not listed.
 */
import { api, errorMessage } from '../api.ts'
import { button, el } from '../dom.ts'
import type { ViewContext } from '../app.ts'
import { changeCard } from './changes.ts'

const PAGE = 20

export async function renderInbox(ctx: ViewContext): Promise<void> {
  const list = el('section', { class: 'list', 'aria-label': '新变化' })
  const status = el('p', { class: 'status', role: 'status' }, '加载中…')
  const drawerList = el('div', { class: 'list' })
  const drawer = el('details', { class: 'drawer' }, el('summary', {}, '被过滤的变化'), drawerList)
  ctx.main.replaceChildren(el('h1', {}, '新变化'), status, list, drawer)

  const loadInbox = async (pageToken = ''): Promise<void> => {
    try {
      const page = await api.listChanges({ parent: 'watches/-', filter: 'state = NEW', pageSize: PAGE, pageToken })
      if (pageToken === '') list.replaceChildren()
      list.querySelector('.more')?.remove()
      for (const change of page.changes) list.append(changeCard(ctx, change, { showWatch: true, ignorable: false, onChange: () => void loadInbox() }))
      if (page.nextPageToken !== '') list.append(el('p', { class: 'more' }, button('更多', () => void loadInbox(page.nextPageToken))))
      if (list.childElementCount === 0) list.append(el('p', { class: 'empty' }, '没有新变化。'))
      const service = await api.getServiceStatus({ name: 'serviceStatus' })
      const notes = [
        service.pendingChangeCount > 0 ? `${String(service.pendingChangeCount)} 个变化等待确认` : '',
        service.brokenWatchCount > 0 ? `${String(service.brokenWatchCount)} 个监视失效` : '',
        service.browserQuotaExhausted ? '今日 JS 配额已用完' : '',
      ].filter((note) => note !== '')
      status.textContent = notes.join(' · ')
      drawer.querySelector('summary')?.replaceChildren(`被过滤的变化（${String(service.suppressedChangeCount)}）`)
    } catch (error) {
      status.textContent = errorMessage(error)
    }
  }

  const loadDrawer = async (): Promise<void> => {
    drawerList.replaceChildren(el('p', { class: 'status' }, '加载中…'))
    try {
      const page = await api.listChanges({ parent: 'watches/-', filter: 'state = SUPPRESSED', pageSize: PAGE })
      drawerList.replaceChildren(...page.changes.map((change) => changeCard(ctx, change, { showWatch: true, ignorable: true, onChange: () => void loadDrawer() })))
      if (page.changes.length === 0) drawerList.append(el('p', { class: 'empty' }, '没有被过滤的变化。'))
    } catch (error) {
      drawerList.replaceChildren(el('p', { class: 'status' }, errorMessage(error)))
    }
  }
  drawer.addEventListener('toggle', () => {
    if (drawer.open) void loadDrawer()
  })
  await loadInbox()
}
