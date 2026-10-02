import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ServiceStatusSchema } from '@ziyixi/proto/todofy/ui/v1/status_pb'
import { message, overview } from '../test/fixtures'
import { bannerNotices, StatusBanner } from './StatusBanner'

describe('StatusBanner', () => {
  it('stays hidden while everything is normal', () => {
    const { container } = render(<StatusBanner overview={message(ServiceStatusSchema, overview())} />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ['maintenance', overview({ switches: { ...overview().switches, maintenance_mode: true } }), '维护模式'],
    ['processing_paused', overview({ switches: { ...overview().switches, processing_paused: true } }), '处理已暂停'],
    ['todoist_paused', overview({ switches: { ...overview().switches, force_pause_todoist: true } }), 'Todoist 已暂停'],
    ['gemini_budget', overview({ gemini: { ...overview().gemini, used_tokens: 2_999_000, reserved_tokens: 1000 } }), '今日 Gemini 预算已用完'],
    ['todoist_auth', overview({ todoist: { ...overview().todoist, block_expire_time: '2026-09-28T18:00:00Z' } }), 'Todoist 认证被拒'],
  ] as const)('explains %s', (kind, wire, title) => {
    const data = message(ServiceStatusSchema, wire)
    expect(bannerNotices(data).map((notice) => notice.kind)).toEqual([kind])
    render(<StatusBanner overview={data} />)
    expect(screen.getByRole('status')).toHaveTextContent(title)
  })

  it('ignores a Todoist block that has already expired', () => {
    const wire = overview({ todoist: { ...overview().todoist, block_expire_time: '2026-09-28T11:00:00Z' } })
    expect(bannerNotices(message(ServiceStatusSchema, wire))).toEqual([])
  })
})
