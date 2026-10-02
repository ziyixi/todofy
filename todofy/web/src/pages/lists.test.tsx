import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { EVENT_ID, eventSummary, OTHER_EVENT_ID } from '../test/fixtures'
import { apiError, mockApi, renderApp } from '../test/harness'

describe('shell', () => {
  it('lands on the attention page with four tabs and the attention badge', async () => {
    mockApi({ 'GET /api/v1/mailEvents': {} })
    const { router } = renderApp('/')
    expect(await screen.findByRole('heading', { name: '需要关注' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/attention')
    const [, tabbar] = screen.getAllByRole('navigation', { name: '主导航' })
    expect(await within(tabbar!).findByLabelText('2 个需关注')).toBeInTheDocument()
    const tabs = within(tabbar!).getAllByRole('link')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['2关注', '事件', '日报', '更多'])
  })
})

describe('attention page', () => {
  it('shows cards with the short ID, state and the Chinese error explanation', async () => {
    const { calls } = mockApi({
      'GET /api/v1/mailEvents': {
        mail_events: [
          eventSummary(),
          eventSummary({ name: `mailEvents/${OTHER_EVENT_ID}`, state: 'failed_summary', error_code: 'llm_request_rejected' }),
        ],
      },
    })
    renderApp('/attention')
    const cards = await screen.findAllByRole('link', { name: /f8c1e9a0/ })
    expect(cards).toHaveLength(2)
    expect(cards[0]).toHaveAttribute('href', `/events/${EVENT_ID}`)
    expect(cards[0]).toHaveTextContent('结果不明')
    expect(cards[0]).toHaveTextContent('建任务结果不明')
    expect(cards[1]).toHaveTextContent('Gemini 拒绝请求')
    expect(calls.find((call) => call.path === '/api/v1/mailEvents')?.search).toBe('?page_size=50&filter=attention%20%3D%20true')
  })

  it('shows the reason and request ID when the list fails', async () => {
    mockApi({ 'GET /api/v1/mailEvents': apiError(503, 'UNAVAILABLE', 'req-503') })
    renderApp('/attention')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('UNAVAILABLE')
    expect(alert).toHaveTextContent('req-503')
    expect(within(alert).getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('says so when nothing needs attention', async () => {
    mockApi({ 'GET /api/v1/mailEvents': {} })
    renderApp('/attention')
    expect(await screen.findByText('一切正常')).toBeInTheDocument()
  })
})

describe('events page', () => {
  it('filters by state and pages with the page token', async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({
      'GET /api/v1/mailEvents': (call) =>
        call.search.includes('page_token=')
          ? { mail_events: [eventSummary({ name: `mailEvents/${OTHER_EVENT_ID}`, state: 'complete', error_code: undefined })] }
          : { mail_events: [eventSummary({ state: 'complete', error_code: undefined })], next_page_token: 'next-1' },
    })
    const { router } = renderApp('/events')
    await screen.findByRole('link', { name: /f8c1e9a0/ })

    await user.click(screen.getByRole('button', { name: '已完成' }))
    expect(router.state.location.search).toBe('?state=complete')
    expect(screen.getByRole('button', { name: '已完成' })).toHaveAttribute('aria-pressed', 'true')
    await screen.findByRole('button', { name: '加载更多' })

    await user.click(screen.getByRole('button', { name: '加载更多' }))
    expect(await screen.findAllByRole('link', { name: /f8c1e9a0/ })).toHaveLength(2)
    const searches = calls.filter((call) => call.path === '/api/v1/mailEvents').map((call) => call.search)
    expect(searches).toContain('?page_size=50&filter=state%20%3D%20COMPLETE')
    expect(searches).toContain('?page_size=50&page_token=next-1&filter=state%20%3D%20COMPLETE')
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument()
  })
})
