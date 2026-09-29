import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { EVENT_ID, eventDetail } from '../test/fixtures'
import { apiError, mockApi, renderApp, type Call } from '../test/harness'

const DETAIL = `GET /api/v1/events/${EVENT_ID}`
const RECONCILE = `POST /api/v1/events/${EVENT_ID}/reconcile`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function posts(calls: Call[]) {
  return calls.filter((call) => call.method === 'POST').map((call) => call.body as Record<string, unknown>)
}

describe('event detail', () => {
  it('shows the state, the explained error code, content as plain text and the timeline', async () => {
    mockApi({ [DETAIL]: eventDetail({ summary: '<b>not html</b>' }) })
    renderApp(`/events/${EVENT_ID}`)
    expect(await screen.findByRole('heading', { name: 'Quarterly tax reminder' })).toBeInTheDocument()
    const status = screen.getByRole('region', { name: '状态' })
    expect(status).toHaveTextContent('建任务结果不明')
    expect(status).toHaveTextContent('任务可能已创建；不会自动重发')
    expect(screen.getByText('<b>not html</b>')).toBeInTheDocument()
    const timeline = screen.getByRole('region', { name: '时间线' })
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText(`Mail Hero event: ${EVENT_ID}`, { selector: 'code' })).toBeInTheDocument()
  })

  it('links a known Todoist task without leaking the referrer', async () => {
    mockApi({ [DETAIL]: eventDetail({ state: 'complete', error_code: null, task_id: '6X7rM8997g3RQmvh', allowed_actions: [] }) })
    renderApp(`/events/${EVENT_ID}`)
    const link = await screen.findByRole('link', { name: /6X7rM8997g3RQmvh/ })
    expect(link).toHaveAttribute('href', 'https://app.todoist.com/app/task/6X7rM8997g3RQmvh')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.queryByRole('region', { name: '需要你处理' })).not.toBeInTheDocument()
  })

  it('loads the imported legacy text only on request', async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({
      [DETAIL]: eventDetail({ has_legacy_text: true, imported: true }),
      [`GET /api/v1/legacy_text/${EVENT_ID}`]: { event_id: EVENT_ID, created_at: '2026-01-01T00:00:00Z', expires_at: null, text: '旧版全文' },
    })
    renderApp(`/events/${EVENT_ID}`)
    await user.click(await screen.findByRole('button', { name: '显示全文' }))
    expect(await screen.findByText('旧版全文')).toBeInTheDocument()
    expect(calls.filter((call) => call.path.startsWith('/api/v1/legacy_text'))).toHaveLength(1)
  })

  it('marks a canary event and offers no action on it', async () => {
    mockApi({
      [DETAIL]: eventDetail({ state: 'complete', error_code: null, allowed_actions: [], canary: true, subject: 'Mail Hero canary' }),
    })
    renderApp(`/events/${EVENT_ID}`)
    const status = await screen.findByRole('region', { name: '状态' })
    expect(status).toHaveTextContent('金丝雀事件')
    expect(status).toHaveTextContent('不会创建 Todoist')
    expect(status).toHaveTextContent('金丝雀（合成检查）')
    expect(screen.queryByRole('region', { name: '需要你处理' })).not.toBeInTheDocument()
  })

  it('shows the code and request ID for a missing event', async () => {
    mockApi({ [DETAIL]: apiError(404, 'not_found', 'req-404') })
    renderApp(`/events/${EVENT_ID}`)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('not_found')
    expect(alert).toHaveTextContent('req-404')
  })
})

describe('reconcile dialogs', () => {
  it('task_not_created needs the typed short ID and warns about a duplicate task', async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({ [DETAIL]: eventDetail(), [RECONCILE]: eventDetail({ state: 'summarized', error_code: null, allowed_actions: [], version: 6 }) })
    renderApp(`/events/${EVENT_ID}`)
    await user.click(await screen.findByRole('button', { name: '任务没有建成' }))

    const dialog = screen.getByRole('dialog', { name: '确认没有建任务' })
    expect(dialog).toHaveTextContent('会再次调用 Todoist，可能重复建任务')
    const confirm = within(dialog).getByRole('button', { name: '重新建任务' })
    expect(confirm).toBeDisabled()
    const input = within(dialog).getByRole('textbox')
    expect(input).toHaveFocus()
    await user.type(input, 'f8c1e9a1')
    expect(confirm).toBeDisabled()
    await user.clear(input)
    await user.type(input, 'F8C1E9A0{Enter}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText(/已提交：确认没有建任务/)).toBeInTheDocument()
    const [body] = posts(calls)
    expect(body).toMatchObject({ action: 'task_not_created', version: 5 })
    expect(body?.action_request_id).toMatch(UUID)
    expect(body).not.toHaveProperty('task_id')
  })

  it('task_created sends the typed task ID', async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({ [DETAIL]: eventDetail(), [RECONCILE]: eventDetail({ state: 'todo_created', task_id: 'abc_123' }) })
    renderApp(`/events/${EVENT_ID}`)
    await user.click(await screen.findByRole('button', { name: '我找到了任务' }))
    const dialog = screen.getByRole('dialog', { name: '标记为已建任务' })
    const confirm = within(dialog).getByRole('button', { name: '确认已建任务' })
    await user.type(within(dialog).getByRole('textbox'), 'not valid!')
    expect(confirm).toBeDisabled()
    await user.clear(within(dialog).getByRole('textbox'))
    await user.type(within(dialog).getByRole('textbox'), ' abc_123 ')
    await user.click(confirm)
    await waitFor(() => expect(posts(calls)).toHaveLength(1))
    expect(posts(calls)[0]).toMatchObject({ action: 'task_created', version: 5, task_id: 'abc_123' })
  })

  it('reuses the action ID when resending the same request and renews it for a different one', async () => {
    const user = userEvent.setup()
    let attempt = 0
    const { calls } = mockApi({
      [DETAIL]: eventDetail(),
      [RECONCILE]: () => (++attempt < 3 ? new TypeError('Failed to fetch') : eventDetail({ state: 'todo_created' })),
    })
    renderApp(`/events/${EVENT_ID}`)
    await user.click(await screen.findByRole('button', { name: '我找到了任务' }))
    const dialog = screen.getByRole('dialog')
    const input = within(dialog).getByRole('textbox')
    const confirm = within(dialog).getByRole('button', { name: '确认已建任务' })

    await user.type(input, 'task1')
    await user.click(confirm)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('network_error')
    await user.click(confirm)
    await waitFor(() => expect(posts(calls)).toHaveLength(2))
    await user.type(input, 'b')
    await user.click(confirm)
    await waitFor(() => expect(posts(calls)).toHaveLength(3))

    const ids = posts(calls).map((body) => body.action_request_id)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[1])
  })

  it('dismiss says Todoist is not checked, and Escape closes without sending', async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({ [DETAIL]: eventDetail() })
    renderApp(`/events/${EVENT_ID}`)
    const trigger = await screen.findByRole('button', { name: '放弃' })
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: '放弃此事件' })).toHaveTextContent('不会检查 Todoist')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(posts(calls)).toHaveLength(0)
  })

  it('moves focus to the outcome when the action button disappears', async () => {
    const user = userEvent.setup()
    mockApi({
      [DETAIL]: eventDetail(),
      [RECONCILE]: eventDetail({ state: 'ignored', error_code: 'dismissed_by_owner', allowed_actions: [], version: 6 }),
    })
    renderApp(`/events/${EVENT_ID}`)
    const trigger = await screen.findByRole('button', { name: '放弃' })
    trigger.focus()
    await user.keyboard('{Enter}')
    const dialog = screen.getByRole('dialog', { name: '放弃此事件' })
    await user.click(within(dialog).getByRole('button', { name: '放弃事件' }))
    const notice = await screen.findByRole('status')
    await waitFor(() => expect(notice).toHaveFocus())
    expect(trigger.isConnected).toBe(false)
    expect(document.activeElement).not.toBe(document.body)
  })

  it('offers a refresh after a version conflict', async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({ [DETAIL]: eventDetail({ state: 'failed_summary', error_code: 'summary_failed', allowed_actions: ['retry_summary', 'dismiss'] }), [RECONCILE]: apiError(409, 'version_conflict', 'req-409') })
    renderApp(`/events/${EVENT_ID}`)
    await user.click(await screen.findByRole('button', { name: '重试摘要' }))
    const dialog = screen.getByRole('dialog', { name: '重新生成摘要' })
    await user.click(within(dialog).getByRole('button', { name: '重新生成摘要' }))
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('version_conflict')
    expect(alert).toHaveTextContent('req-409')
    await user.click(within(dialog).getByRole('button', { name: '刷新事件' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(calls.filter((call) => call.path === `/api/v1/events/${EVENT_ID}`)).toHaveLength(2))
  })

  it('keeps Tab focus inside the dialog', async () => {
    const user = userEvent.setup()
    mockApi({ [DETAIL]: eventDetail() })
    renderApp(`/events/${EVENT_ID}`)
    await user.click(await screen.findByRole('button', { name: '放弃' }))
    const dialog = screen.getByRole('dialog')
    for (let i = 0; i < 5; i++) {
      await user.tab()
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    }
  })
})
