// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { create } from '@ziyixi/proto/protobuf'
import { ListDeliveriesResponseSchema } from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import { timestamp } from '../api/client'
import { installFakeServer } from '../test/fakeServer'
import { delivery, renderAt } from '../test/fixtures'
import DeliveriesPage from './DeliveriesPage'

beforeAll(() => { vi.stubEnv('TZ', 'America/Los_Angeles') })
afterAll(() => { vi.unstubAllEnvs() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('keeps the selected attempt result and exact interval while paging, labelled in the browser zone', async () => {
  const fake = installFakeServer()
  const pages = [
    create(ListDeliveriesResponseSchema, { deliveries: [delivery({ name: 'deliveries/event-1', attemptCount: 3, createTime: timestamp('2026-11-01T10:00:00Z') })], nextPageToken: 'next-token' }),
    create(ListDeliveriesResponseSchema, {}),
  ]
  fake.answer.listDeliveries = async () => pages.shift() ?? create(ListDeliveriesResponseSchema, {})
  const { container } = renderAt(<DeliveriesPage/>, '/deliveries?attempt_result=retried&from=2026-11-01T07%3A00%3A00.000Z&to=2026-11-02T08%3A00%3A00.000Z')
  await screen.findByText('event-1…')
  expect(screen.getByText(/^尝试完成时间：/).textContent).toBe('尝试完成时间：2026/11/01 00:00 PDT 至 2026/11/02 00:00 PST（不含结束时刻）')
  expect(container.querySelector('.delivery-history-filter')?.textContent).not.toContain('UTC')
  expect(screen.getByRole('link', { name: 'event-1…' }).getAttribute('href')).toContain('attempt_result=retried')
  expect(screen.getByText(/按事件创建时间排序/)).toBeTruthy()
  expect(screen.getByRole('link', { name: '清除筛选' }).getAttribute('href')).toBe('/deliveries')
  expect(screen.queryByRole('combobox', { name: '筛选投递状态' })).toBeNull()
  const filter = 'attempt_result = RETRIED AND attempt_finish_time >= "2026-11-01T07:00:00.000Z" AND attempt_finish_time < "2026-11-02T08:00:00.000Z"'
  expect(fake.callsOf('listDeliveries')[0]).toMatchObject({ filter, pageToken: '', pageSize: 50 })
  fireEvent.click(screen.getByRole('button', { name: /下一页/ }))
  await waitFor(() => expect(fake.callsOf('listDeliveries')).toHaveLength(2))
  expect(fake.callsOf('listDeliveries')[1]).toMatchObject({ filter, pageToken: 'next-token' })
})

it('filters by the stored state', async () => {
  const fake = installFakeServer({ deliveries: [delivery()] })
  renderAt(<DeliveriesPage/>, '/deliveries')
  fireEvent.change(await screen.findByRole('combobox', { name: '筛选投递状态' }), { target: { value: 'retry_wait' } })
  await waitFor(() => expect(fake.callsOf('listDeliveries').at(-1)).toMatchObject({ filter: 'state = RETRY_WAIT' }))
  expect(fake.callsOf('listDeliveries')[0]).toMatchObject({ filter: '' })
})

it('labels an ops canary event so it is never mistaken for mail', async () => {
  installFakeServer({ deliveries: [delivery({ name: 'deliveries/canary-1', canary: true }), delivery({ name: 'deliveries/realmail', message: 'messages/message-2' })] })
  const { container } = renderAt(<DeliveriesPage/>, '/deliveries')
  await screen.findByText('canary-1…')
  const tags = container.querySelectorAll('.canary-tag')
  expect(tags.length).toBe(1)
  expect(tags[0].textContent).toBe('金丝雀')
  expect(tags[0].closest('tr')?.textContent).toContain('canary-1')
})
