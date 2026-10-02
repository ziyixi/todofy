// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { create } from '@ziyixi/proto/protobuf'
import { Delivery_State, DeliveryPayloadSchema } from '@ziyixi/proto/mailhero/ui/v2/delivery_pb'
import { ResendDeliveryResponseSchema } from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import { installFakeServer } from '../test/fakeServer'
import { delivery, endpoint, ENDPOINT_ID, EVENT_ID, message, renderAt } from '../test/fixtures'
import DeliveryPage from './DeliveryPage'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const open = () => renderAt(<DeliveryPage/>, `/deliveries/${EVENT_ID}`, '/deliveries/:id')

it('warns before cancelling that an owner-resolved exception is later cleaned by the resolved retention period', async () => {
  const fake = installFakeServer({ deliveries: [delivery({ state: Delivery_State.FAILED, effectiveState: Delivery_State.FAILED, attemptCount: 2, lastError: 'retry_window_expired' })], messages: [message({ etag: '3' })] })
  open()
  fireEvent.click(await screen.findByRole('button', { name: '取消交付' }))
  const note = await screen.findByText(/已处理异常邮件保留天数/)
  // Like the Worker: only undelivered events created after the last delivered one must be owner-cancelled.
  expect(note.textContent).toContain('最后一次送达之后新建的其余未送达交付（从未送达时为全部其余交付）也都由你取消')
  expect(note.textContent).toContain('清理全部内容')
  // Mail already on a normal retention clock never switches to the resolved period.
  expect(note.textContent).toContain('若这封邮件尚未开始普通保留计时')
  expect(note.textContent).toContain('已开始普通保留计时的邮件（此前已达到安全终态）不适用此规则')
  expect(fake.callsOf('cancelDelivery')).toEqual([])
  fireEvent.click(screen.getAllByRole('button', { name: '取消交付' }).at(-1)!)
  await waitFor(() => expect(fake.callsOf('cancelDelivery')).toHaveLength(1))
  expect(fake.callsOf('cancelDelivery')[0]).toMatchObject({ name: `deliveries/${EVENT_ID}` })
  expect(fake.callsOf('cancelDelivery')[0]['requestId']).toMatch(/^[0-9a-f-]{36}$/)
})

it('shows the frozen request and its attempts, and resends as a new event with the message etag', async () => {
  const fake = installFakeServer({ deliveries: [delivery()], messages: [message({ etag: '3' })], endpoints: [endpoint()] })
  fake.state.payloads.set(`deliveries/${EVENT_ID}/payload`, create(DeliveryPayloadSchema, { name: `deliveries/${EVENT_ID}/payload`, body: '{"type":"mail.received.v1"}' }))
  fake.answer.resendDelivery = async request => create(ResendDeliveryResponseSchema, { delivery: { name: 'deliveries/new-event', endpoint: request.endpoint, sourceDelivery: request.name } })
  open()
  expect(await screen.findByText(/"type": "mail.received.v1"/)).toBeTruthy()
  await screen.findByText('Synthetic subject')
  fireEvent.click(screen.getByRole('button', { name: /重新发送为新事件/ }))
  fireEvent.click(await screen.findByRole('button', { name: '创建新事件' }))
  await waitFor(() => expect(fake.callsOf('resendDelivery')).toHaveLength(1))
  expect(fake.callsOf('resendDelivery')[0]).toMatchObject({ name: `deliveries/${EVENT_ID}`, endpoint: `endpoints/${ENDPOINT_ID}`, messageEtag: '3' })
  // The answer's delivery is the new event: the page opens it.
  await waitFor(() => expect(fake.callsOf('getDelivery').map(call => call['name'])).toContain('deliveries/new-event'))
})

it('marks a canary delivery as a synthetic ops event', async () => {
  installFakeServer({ deliveries: [delivery({ canary: true, message: 'messages/missing' })] })
  open()
  expect((await screen.findByText('金丝雀')).className).toBe('canary-tag')
  expect(screen.getByText(/运维合成事件/)).toBeTruthy()
  expect(await screen.findByText('邮件详情加载中或已不可用。')).toBeTruthy()
})
