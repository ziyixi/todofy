// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { create, type MessageInitShape } from '@ziyixi/proto/protobuf'
import { Attachment_OmittedReason, Attachment_StorageState, Message_ParseState, MessageContentSchema, ReceiveMode, type MessageSchema } from '@ziyixi/proto/mailhero/ui/v2/message_pb'
import { timestamp } from '../api/client'
import { installFakeServer, type FakeServer } from '../test/fakeServer'
import { endpoint, ENDPOINT_ID, MESSAGE_ID, message, renderAt, settings } from '../test/fixtures'
import MessagePage from './MessagePage'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function open(fields: MessageInitShape<typeof MessageSchema>, body: MessageInitShape<typeof MessageContentSchema> = { text: 'Synthetic retained text' }): FakeServer {
  const fake = installFakeServer({ messages: [message({ subject: 'Synthetic body policy', ...fields })], settings: settings({ mode: ReceiveMode.ARCHIVE, sendPaused: true }) })
  fake.state.contents.set(`messages/${MESSAGE_ID}/content`, create(MessageContentSchema, { name: `messages/${MESSAGE_ID}/content`, ...body }))
  renderAt(<MessagePage/>, `/messages/${MESSAGE_ID}`, '/messages/:id')
  return fake
}

it('makes incomplete body and omitted attachment visible without a broken download link', async () => {
  open({}, { text: 'Synthetic retained text', textTruncated: true, originalTextBytes: 2_000_000, htmlOmitted: true, omittedAttachmentCount: 2,
    warnings: ['html_omitted', 'attachment_copies_omitted'], attachments: [
      { partId: '1.1', filename: 'large.bin', mimeType: 'application/octet-stream', sizeBytes: 3_000_000, storageState: Attachment_StorageState.OMITTED, omittedReason: Attachment_OmittedReason.SIZE_LIMIT },
      { partId: '1.2', filename: 'small.pdf', mimeType: 'application/pdf', sizeBytes: 10, storageState: Attachment_StorageState.STORED, downloadUri: `/api/v2/messages/${MESSAGE_ID}/attachments/1.2` },
    ] })
  await screen.findByText('Synthetic retained text')
  expect(screen.getByText(/正文不完整：原始纯文本/)).toBeTruthy()
  expect(screen.getByText(/另有 2 个附件未列出/)).toBeTruthy()
  expect(screen.getByText('large.bin').closest('a')).toBeNull()
  expect(screen.getByText(/单个附件超过 2 MiB/)).toBeTruthy()
  expect(screen.getByText('small.pdf').closest('a')?.getAttribute('href')).toBe(`/api/v2/messages/${MESSAGE_ID}/attachments/1.2`)
  expect(screen.getByRole('link', {name:/下载原件/}).getAttribute('href')).toBe(`/api/v2/messages/${MESSAGE_ID}/raw`)
  fireEvent.click(screen.getByRole('tab', {name:'安全 HTML'}))
  expect(screen.getByText('HTML 预览已省略')).toBeTruthy()
})

it('raw expiry removes download and reparse but preserves the retained body', async () => {
  open({ parseState: Message_ParseState.FAILED, parseError: 'synthetic_error', rawExpireTime: timestamp('2026-09-26T00:00:00Z'), rawDownloadUri: '' })
  await screen.findByText('Synthetic retained text')
  expect(screen.queryByRole('link',{name:'下载原件'})).toBeNull()
  expect(screen.queryByRole('button',{name:/重新解析/})).toBeNull()
  expect(screen.getByText(/原件已按保留策略过期/)).toBeTruthy()
  expect(screen.getByText(/处理未完成：synthetic_error/)).toBeTruthy()
})

it.each([
  [Message_ParseState.PENDING, '（主题待解析）', '发件人待解析', '正文尚未解析'],
  [Message_ParseState.PARSING, '（正在解析主题）', '正在解析发件人', '正在提取正文'],
  [Message_ParseState.FAILED, '（主题解析未完成）', '发件人解析未完成', '正文解析未完成'],
] as const)('distinguishes parse state %s from a parsed empty email', async (parseState, subject, sender, body) => {
  open({ parseState, subject: '', sender: '' }, {})
  await screen.findByRole('heading', {level:1,name:subject})
  expect(screen.getAllByText(sender)).toHaveLength(2)
  expect(screen.getByRole('heading', {name:body})).toBeTruthy()
  expect(screen.getByText('自动投递需等待邮件解析成功。')).toBeTruthy()
  expect(screen.queryByRole('button', {name:/发送到目标/})).toBeNull()
  expect(screen.queryByText('（无主题）')).toBeNull()
  expect(screen.queryByText('未知发件人')).toBeNull()
  expect(screen.queryByText('没有纯文本正文')).toBeNull()
  expect(screen.queryByText('没有附件。')).toBeNull()
  fireEvent.click(screen.getByRole('tab', {name:'安全 HTML'}))
  expect(screen.getByRole('heading', {name:body})).toBeTruthy()
  expect(screen.queryByText('没有 HTML 正文')).toBeNull()
  fireEvent.click(screen.getByRole('tab', {name:'邮件头'}))
  expect(screen.getByRole('heading', {name:'邮件头尚未解析'})).toBeTruthy()
})

it('preserves the genuine subjectless and empty-body states after parsing succeeds', async () => {
  open({ subject: '' }, {})
  await screen.findByRole('heading', {level:1,name:'（无主题）'})
  expect(screen.getByRole('heading', {name:'没有纯文本正文'})).toBeTruthy()
  expect(screen.getByText('没有附件。')).toBeTruthy()
  expect(screen.queryByText('自动投递需等待邮件解析成功。')).toBeNull()
})

it('shows needs-review warnings as plain text, and marks read, sends and deletes with the etag and a request ID', async () => {
  const fake = open({ etag: '5' }, { text: 'Synthetic retained text', needsReview: true, warnings: ['attached_or_opaque_message', 'a_future_code'] })
  fake.state.endpoints = [endpoint()]
  await screen.findByText('Synthetic retained text')
  expect(screen.getByText('这封邮件需要人工检查。')).toBeTruthy()
  expect(screen.getByText(/邮件包含嵌套邮件/)).toBeTruthy()
  expect(screen.getByText('a_future_code')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', {name:/标记为已读/}))
  await waitFor(() => expect(fake.callsOf('updateMessage')).toHaveLength(1))
  expect(fake.callsOf('updateMessage')[0]).toMatchObject({ message: { name: `messages/${MESSAGE_ID}`, read: true, etag: '5' }, updateMask: { paths: ['read', 'etag'] } })
  fireEvent.click(screen.getAllByRole('button', {name:/发送到/})[0])
  fireEvent.click(await screen.findByRole('button', {name:'确认发送'}))
  await waitFor(() => expect(fake.callsOf('sendMessage')).toHaveLength(1))
  expect(fake.callsOf('sendMessage')[0]).toMatchObject({ name: `messages/${MESSAGE_ID}`, endpoint: `endpoints/${ENDPOINT_ID}` })
  expect(fake.callsOf('sendMessage')[0]['requestId']).toMatch(/^[0-9a-f-]{36}$/)
  fireEvent.click(screen.getByRole('button', {name:/删除邮件内容/}))
  fireEvent.click(await screen.findByRole('button', {name:'永久删除内容'}))
  await waitFor(() => expect(fake.callsOf('clearMessageContent')).toHaveLength(1))
  expect(fake.callsOf('clearMessageContent')[0]).toMatchObject({ name: `messages/${MESSAGE_ID}`, etag: '5' })
})

