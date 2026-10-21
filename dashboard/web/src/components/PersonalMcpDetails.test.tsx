import { render, screen, within } from '@testing-library/react'
import type { OpsStatus } from '../../../worker/src/api-types.ts'
import { PersonalMcpDetails } from './PersonalMcpDetails'

const NOW = new Date('2026-10-01T12:00:00Z')
const status = (changes: Partial<OpsStatus> = {}): OpsStatus => ({
  version: 'ops-v1', app: 'personal-mcp', generated_at: NOW.toISOString(), health: 'ok', modes: { maintenance: false },
  guard: { level: 'normal', reason: null, until: null, set_at: null, deferred: [] }, signals: [],
  counters: { active_subscriptions: 0, pending_deliveries: 0, accepted_deliveries: 0, failed_deliveries: 0 },
  last_backup_at: null, ui_url: null, capabilities: [], ...changes,
})

describe('Personal MCP observations', () => {
  it('keeps an unused connection and zero subscriptions neutral', () => {
    render(<PersonalMcpDetails status={status()} now={NOW} />)
    expect(screen.getByText('暂无订阅。可在 ChatGPT 对话中创建订阅。')).toBeInTheDocument()
    expect(screen.getAllByText('尚无记录')).toHaveLength(5)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the observed clocks and accepted/pending counts without claiming Dot completion', () => {
    const viewed = status({ counters: { active_subscriptions: 2, accepted_deliveries: 3, pending_deliveries: 1,
      failed_deliveries: 0, last_tool_at_ms: NOW.getTime(), last_event_at_ms: NOW.getTime() - 1_000,
      last_delivery_at_ms: NOW.getTime() - 500 } })
    const { container } = render(<PersonalMcpDetails status={viewed} now={NOW} />)
    expect(within(screen.getByText('当前订阅').parentElement as HTMLElement).getByText('2')).toBeInTheDocument()
    expect(within(screen.getByText('回调已接收').parentElement as HTMLElement).getByText('3')).toBeInTheDocument()
    expect(container.querySelectorAll('time')).toHaveLength(3)
    expect(screen.getByText(/后续处理结果请在对应对话查看/)).toBeInTheDocument()
  })

  it('keeps an unread store unknown instead of showing zero subscriptions', () => {
    render(<PersonalMcpDetails status={status({ health: 'down', counters: {} })} now={NOW} />)
    expect(screen.getAllByText('未读取')).toHaveLength(9)
    expect(screen.queryByText(/暂无订阅/)).not.toBeInTheDocument()
  })
})
