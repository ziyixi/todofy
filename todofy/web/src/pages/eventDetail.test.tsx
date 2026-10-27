import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { EVENT_ID, eventDetail } from '../test/fixtures'
import { apiError, mockApi, renderApp, type Call } from '../test/harness'

const DETAIL = `GET /api/v1/mailEvents/${EVENT_ID}`
const RECONCILE = `POST /api/v1/mailEvents/${EVENT_ID}:reconcile`
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
    expect(status).toHaveTextContent('模型暂时不可用')
    expect(status).toHaveTextContent('会按退避自动重试最多 7 天')
    expect(screen.getByText('<b>not html</b>')).toBeInTheDocument()
    const timeline = screen.getByRole('region', { name: '时间线' })
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(2)
  })

  it('links a known task through the Tasks redirect without leaking the referrer', async () => {
    mockApi({ [DETAIL]: eventDetail({ state: 'complete', error_code: undefined, task_id: '6X7rM8997g3RQmvh', allowed_actions: [] }) })
    renderApp(`/events/${EVENT_ID}`)
    const link = await screen.findByRole('link', { name: /6X7rM8997g3RQmvh/ })
    expect(link).toHaveAttribute('href', '/task/6X7rM8997g3RQmvh')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.queryByRole('region', { name: '需要你处理' })).not.toBeInTheDocument()
  })

  it('loads the imported legacy text only on request', async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({
      [DETAIL]: eventDetail({ legacy_text: `legacyTexts/${EVENT_ID}`, imported: true }),
      [`GET /api/v1/legacyTexts/${EVENT_ID}`]: { name: `legacyTexts/${EVENT_ID}`, create_time: '2026-01-01T00:00:00Z', text: '旧版全文' },
    })
    renderApp(`/events/${EVENT_ID}`)
    await user.click(await screen.findByRole('button', { name: '显示全文' }))
    expect(await screen.findByText('旧版全文')).toBeInTheDocument()
    expect(calls.filter((call) => call.path.startsWith('/api/v1/legacyTexts'))).toHaveLength(1)
  })

  it('marks a canary event and offers no action on it', async () => {
    mockApi({
      [DETAIL]: eventDetail({ state: 'complete', error_code: undefined, allowed_actions: [], canary: true, subject: 'Mail Hero canary' }),
    })
    renderApp(`/events/${EVENT_ID}`)
    const status = await screen.findByRole('region', { name: '状态' })
    expect(status).toHaveTextContent('金丝雀事件')
    expect(status).toHaveTextContent('不会创建任务')
    expect(status).toHaveTextContent('金丝雀（合成检查）')
    expect(screen.queryByRole('region', { name: '需要你处理' })).not.toBeInTheDocument()
  })

  it('shows the reason and request ID for a missing event', async () => {
    mockApi({ [DETAIL]: apiError(404, 'NOT_FOUND', 'req-404') })
    renderApp(`/events/${EVENT_ID}`)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('NOT_FOUND')
    expect(alert).toHaveTextContent('req-404')
  })
})

describe('reconcile dialogs', () => {
  it('retry_summary sends the action with the etag and no task ID', async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({
      [DETAIL]: eventDetail(),
      [RECONCILE]: eventDetail({ state: 'pending', error_code: undefined, allowed_actions: [], version: 6, etag: '6' }),
    })
    renderApp(`/events/${EVENT_ID}`)
    await user.click(await screen.findByRole('button', { name: '重试摘要' }))

    const dialog = screen.getByRole('dialog', { name: '重新生成摘要' })
    expect(dialog).toHaveTextContent('计入当日 token 预算')
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '重新生成摘要' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText(/已提交：重新生成摘要/)).toBeInTheDocument()
    const [body] = posts(calls)
    expect(body).toMatchObject({ action: 'retry_summary', etag: '5' })
    expect(body?.request_id).toMatch(UUID)
    expect(body).not.toHaveProperty('task_id')
    expect(body).not.toHaveProperty('name')
  })

  it('reuses the action ID when resending the same request and renews it for a different one', async () => {
    const user = userEvent.setup()
    let attempt = 0
    const { calls } = mockApi({
      [DETAIL]: eventDetail(),
      [RECONCILE]: () => (++attempt < 3 ? new TypeError('Failed to fetch') : eventDetail({ state: 'pending' })),
    })
    renderApp(`/events/${EVENT_ID}`)
    await user.click(await screen.findByRole('button', { name: '重试摘要' }))
    const retry = within(screen.getByRole('dialog')).getByRole('button', { name: '重新生成摘要' })
    await user.click(retry)
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('NETWORK_ERROR')
    await user.click(retry)
    await waitFor(() => expect(posts(calls)).toHaveLength(2))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    await user.click(screen.getByRole('button', { name: '放弃' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '放弃事件' }))
    await waitFor(() => expect(posts(calls)).toHaveLength(3))

    const ids = posts(calls).map((body) => body.request_id)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[1])
  })

  it('dismiss says the ledger keeps the event, and Escape closes without sending', async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({ [DETAIL]: eventDetail() })
    renderApp(`/events/${EVENT_ID}`)
    const trigger = await screen.findByRole('button', { name: '放弃' })
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: '放弃此事件' })).toHaveTextContent('账本保留去重记录')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(posts(calls)).toHaveLength(0)
  })

  it('moves focus to the outcome when the action button disappears', async () => {
    const user = userEvent.setup()
    mockApi({
      [DETAIL]: eventDetail(),
      [RECONCILE]: eventDetail({ state: 'ignored', error_code: 'dismissed_by_owner', allowed_actions: [], version: 6, etag: '6' }),
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

  it('shows the event as it is now after a stale etag, and offers a refresh', async () => {
    const user = userEvent.setup()
    const failed = eventDetail({ state: 'failed_summary', error_code: 'summary_failed', allowed_actions: ['retry_summary', 'dismiss'] })
    const current = { '@type': 'type.googleapis.com/todofy.ui.v1.MailEvent', ...eventDetail({ state: 'pending', error_code: undefined, allowed_actions: [], version: 6, etag: '6' }) }
    const { calls } = mockApi({ [DETAIL]: failed, [RECONCILE]: apiError(409, 'ETAG_MISMATCH', 'req-409', [current]) })
    renderApp(`/events/${EVENT_ID}`)
    await user.click(await screen.findByRole('button', { name: '重试摘要' }))
    const dialog = screen.getByRole('dialog', { name: '重新生成摘要' })
    await user.click(within(dialog).getByRole('button', { name: '重新生成摘要' }))
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent('ETAG_MISMATCH')
    expect(alert).toHaveTextContent('req-409')
    expect(alert).toHaveTextContent('事件在你查看后已被更新')
    // The page already shows the event the error carried: no action is offered any more.
    await waitFor(() => expect(screen.queryByRole('region', { name: '需要你处理' })).not.toBeInTheDocument())
    await user.click(within(dialog).getByRole('button', { name: '刷新事件' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(calls.filter((call) => call.path === `/api/v1/mailEvents/${EVENT_ID}`)).toHaveLength(2))
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
