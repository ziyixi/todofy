// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { Delivery_State } from '@ziyixi/proto/mailhero/ui/v2/delivery_pb'
import { Message_DeliveryState, Message_ParseState } from '@ziyixi/proto/mailhero/ui/v2/message_pb'
import { installFakeServer, type FakeServer } from '../test/fakeServer'
import { content, delivery, MESSAGE_ID, message, overview, renderAt, settings } from '../test/fixtures'
import InboxPage from './InboxPage'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function open(parseState: Message_ParseState, route = `/inbox?selected=${MESSAGE_ID}`): FakeServer {
  const fake = installFakeServer({ messages: [message({ subject: '', sender: '', parseState, rawDownloadUri: '' })], overview: overview({ messageCount: 1 }), settings: settings() })
  renderAt(<InboxPage/>, route)
  return fake
}

it.each([
  [Message_ParseState.PENDING, '（主题待解析）', '发件人待解析', '待解析'],
  [Message_ParseState.PARSING, '（正在解析主题）', '正在解析发件人', '解析中'],
  [Message_ParseState.FAILED, '（主题解析未完成）', '发件人解析未完成', '需处理'],
] as const)('shows parse state %s in both the list and preview without claiming absent content', async (state, subject, sender, status) => {
  open(state)
  await screen.findByRole('heading', {name:subject})
  expect(screen.getByRole('button', {name:new RegExp(`${sender}.*${status}`)})).toBeTruthy()
  expect(screen.getAllByText(sender)).toHaveLength(2)
  expect(screen.getAllByText(/自动投递需等待解析成功/)).toHaveLength(2)
  expect(screen.queryByText('（无主题）')).toBeNull()
  expect(screen.queryByText('未知发件人')).toBeNull()
  expect(screen.queryByText('无附件')).toBeNull()
  expect(screen.queryByText(/暂无可显示的纯文本正文/)).toBeNull()
})

it('refreshes pending placeholders to the parsed subjectless email and actual content', async () => {
  const fake = open(Message_ParseState.PENDING)
  await screen.findByRole('heading', {name:'（主题待解析）'})
  fake.state.messages = [message({ subject: '', sender: 'sender@example.test', snippet: 'Synthetic parsed body' })]
  fake.state.contents.set(`messages/${MESSAGE_ID}/content`, content({ text: 'Synthetic parsed body' }))
  await waitFor(() => expect((screen.getByRole('button', {name:'刷新'}) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', {name:'刷新'}))
  await screen.findByRole('heading', {name:'（无主题）'})
  expect(screen.getAllByText('Synthetic parsed body')).toHaveLength(2)
  expect(screen.getAllByText('sender@example.test')).toHaveLength(2)
  expect(screen.queryByText('（主题待解析）')).toBeNull()
  expect(screen.queryByText(/自动投递需等待解析成功/)).toBeNull()
})

it('sends the search box and the selects as one AIP-160 filter, and pages with the page token', async () => {
  const fake = open(Message_ParseState.READY, '/inbox?q=%E7%8B%AC%E7%AB%8B&status=retry_wait&parse_state=ready&has_attachment=true')
  fake.answer.listMessages = async request => ({ $typeName: 'mailhero.ui.v2.ListMessagesResponse', messages: [message()], nextPageToken: request.pageToken ? '' : 'page-2' })
  await screen.findByText('Synthetic subject')
  expect(fake.callsOf('listMessages')[0]).toMatchObject({ filter: '"独立" AND delivery_state = RETRY_WAIT AND parse_state = READY AND has_attachments = true', pageSize: 50, pageToken: '' })
  fireEvent.click(await screen.findByRole('button', {name:/下一页/}))
  await waitFor(() => expect(fake.callsOf('listMessages').at(-1)).toMatchObject({ pageToken: 'page-2' }))
})

it("shows the preview's delivery state as its latest delivery's effective one (a paused wait reads paused)", async () => {
  const fake = installFakeServer({ messages: [message({ deliveryState: Message_DeliveryState.RETRY_WAIT })], overview: overview(), settings: settings(),
    deliveries: [delivery({ state: Delivery_State.RETRY_WAIT, effectiveState: Delivery_State.PAUSED })] })
  renderAt(<InboxPage/>, `/inbox?selected=${MESSAGE_ID}`)
  await screen.findByRole('heading', {name:'Synthetic subject'})
  // The list shows the stored state; the preview, the effective one.
  expect(screen.getByRole('button', {name:/Synthetic subject.*等待重试/})).toBeTruthy()
  expect(await screen.findByText('已暂停')).toBeTruthy()
  expect(fake.callsOf('listDeliveries')[0]).toMatchObject({ filter: `message = "messages/${MESSAGE_ID}"`, pageSize: 1 })
})
