import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AttentionItem } from '../../../worker/src/api-types.ts'
import { apiError, json, renderApp, serve } from '../test/harness'
import { healthy, NOW } from '../test/fixtures'
import { attentionFor } from './AttentionActions'

const item: AttentionItem = {
  source: 'newsletter', code: 'newsletter_unknown', severity: 'warning', since: null,
  metrics: { unknown_count: 32 }, target: { view: 'flows', flow: 'daily-newsletter', stage: 'fetch', entry: 'newsletter' },
  name: 'attentionItems/synthetic-newsletter', etag: 'a1-0d8f7a9e-1c2b-4d3e-8f4a-5b6c7d8e9f0a',
}
const path = `/api/v1/${item.name}:dismiss`

function warned() {
  const scenario = healthy()
  scenario.home = { ...scenario.home, attention: { level: 'warning', items: [item], info: [], held: [] }, badges: { ...scenario.home.badges, flows: 1 } }
  return scenario
}

describe('owner reminder actions', () => {
  it('closes a current occurrence through the typed API, clears badges, and can restore it from the saved list', async () => {
    const user = userEvent.setup()
    const scenario = warned()
    const dismissed = { ...item, dismissed_at: NOW.toISOString() }
    const calls = serve(scenario, call => {
      if (call.path === path) {
        scenario.home = { ...scenario.home, attention: { level: 'ok', items: [], info: [], held: [], dismissed_items: [dismissed] }, badges: { ...scenario.home.badges, flows: 0 } }
        return json(dismissed)
      }
      if (call.path === `/api/v1/${item.name}:restore`) {
        scenario.home = { ...scenario.home, attention: { level: 'warning', items: [item], info: [], held: [] }, badges: { ...scenario.home.badges, flows: 1 } }
        return json(item)
      }
      return apiError(404, 'not_found')
    })
    const page = renderApp()
    await user.click(await screen.findByRole('button', { name: '不再提醒这批 32 条记录' }))
    expect(await screen.findByText('暂无未处理提醒')).toBeInTheDocument()
    expect(screen.getByText('本次提醒已关闭，刷新和重启后仍有效。')).toHaveFocus()
    expect(screen.queryByText('全部正常')).toBeNull()
    expect(screen.getByRole('link', { name: '业务流程' })).toBeInTheDocument()
    const post = calls.find(call => call.path === path)
    expect(post?.headers['x-csrf-token']).toBe('token-1')
    const body = JSON.parse(post?.body ?? '{}') as { etag: string; request_id: string }
    expect(body.etag).toBe(item.etag)
    expect(body.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // A new query client/page reads the server result; there is no localStorage dismissal.
    page.unmount()
    renderApp()
    expect(await screen.findByText('暂无未处理提醒')).toBeInTheDocument()
    await user.click(screen.getByText('已忽略 1 项提醒 · 可恢复'))
    await user.click(screen.getByRole('button', { name: '恢复提醒' }))
    expect(await screen.findByRole('button', { name: '不再提醒这批 32 条记录' })).toBeInTheDocument()
  })

  it('keeps a changed alert visible on CAS rejection and reports the next step', async () => {
    const user = userEvent.setup()
    const scenario = warned()
    const calls = serve(scenario, () => apiError(409, 'attention_changed', '这项提醒已发生变化，请刷新后重新查看'))
    renderApp()
    await user.click(await screen.findByRole('button', { name: '不再提醒这批 32 条记录' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请刷新后重新查看')
    expect(screen.queryByText('暂无未处理提醒')).toBeNull()
    expect(calls.filter(call => call.path === path)).toHaveLength(1)
    expect(within(screen.getByRole('list', { name: '需关注的项目' })).getByText(/它不等于失败邮件数/)).toBeInTheDocument()
  })

  it('retries CSRF expiry with the identical occurrence and request ID', async () => {
    const user = userEvent.setup()
    const scenario = warned()
    let count = 0
    const calls = serve(scenario, () => {
      if (++count === 1) return apiError(403, 'csrf_failed')
      const dismissed = { ...item, dismissed_at: NOW.toISOString() }
      scenario.home = { ...scenario.home, attention: { level: 'ok', items: [], info: [], held: [], dismissed_items: [dismissed] } }
      return json(dismissed)
    })
    renderApp()
    await user.click(await screen.findByRole('button', { name: '不再提醒这批 32 条记录' }))
    await waitFor(() => expect(screen.getByText('暂无未处理提醒')).toBeInTheDocument())
    const posts = calls.filter(call => call.path === path)
    expect(posts).toHaveLength(2)
    expect(posts[0]?.body).toBe(posts[1]?.body)
    expect(posts.map(call => call.headers['x-csrf-token'])).toEqual(['token-1', 'token-2'])
  })

  it('keeps a confirmed dismissal visible even if the following read fails', async () => {
    const user = userEvent.setup()
    const scenario = warned()
    let saved = false
    serve(call => {
      if (saved && call.path === '/api/v1/homeView') throw new TypeError('synthetic read failure')
      return scenario
    }, () => {
      saved = true
      return json({ ...item, etag: 'a1-0d8f7a9e-1c2b-4d3e-8f4a-5b6c7d8e9f0b', dismissed_at: NOW.toISOString() })
    })
    renderApp()
    await user.click(await screen.findByRole('button', { name: '不再提醒这批 32 条记录' }))
    expect(await screen.findByText('暂无未处理提醒')).toBeInTheDocument()
    expect(await screen.findByText(/自动更新失败/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '不再提醒这批 32 条记录' })).toBeNull()
    expect(screen.getByText('已忽略 1 项提醒 · 可恢复')).toBeInTheDocument()
  })

  it('never chooses a mutation target when a partial match is ambiguous', () => {
    const attention = { level: 'warning' as const, items: [item, { ...item, name: 'attentionItems/other', target: { ...item.target, stage: 'other' } }], info: [], held: [] }
    expect(attentionFor(attention, 'newsletter', 'newsletter_unknown', { entry: 'newsletter' })).toBeUndefined()
    expect(attentionFor(attention, 'newsletter', 'newsletter_unknown', { stage: 'fetch' })).toBe(item)
  })
})
