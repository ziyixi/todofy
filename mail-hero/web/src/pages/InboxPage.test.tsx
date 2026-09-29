// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { api } from '../api/client'
import type { MessageDetail, ParseState } from '../api/types'
import InboxPage from './InboxPage'

vi.mock('../api/client', () => ({
  api: {messages:vi.fn(), message:vi.fn(), overview:vi.fn(), settings:vi.fn()},
}))
afterEach(() => { cleanup(); vi.clearAllMocks() })

function response(message: MessageDetail) {
  vi.mocked(api.messages).mockResolvedValue({items:[message],next_cursor:null})
  vi.mocked(api.message).mockResolvedValue({message,deliveries:[]})
}

function open(parse_state: ParseState) {
  const message: MessageDetail = {
    id:'synthetic-message',subject:'',from:'',text:'',html:'',headers:[],attachments:[],
    received_at:'2026-09-26T00:00:00Z',parse_state,version:1,delivery_state:'unarranged',
  }
  response(message)
  vi.mocked(api.overview).mockResolvedValue({message_count:1})
  vi.mocked(api.settings).mockResolvedValue({version:1,mode:'forward',receive_address:'hero@example.test',send_paused:false})
  const client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/inbox?selected=synthetic-message']}><InboxPage/></MemoryRouter></QueryClientProvider>)
  return message
}

it.each([
  ['pending', '（主题待解析）', '发件人待解析', '待解析'],
  ['parsing', '（正在解析主题）', '正在解析发件人', '解析中'],
  ['failed', '（主题解析未完成）', '发件人解析未完成', '需处理'],
] as const)('shows %s parsing status in both the list and preview without claiming absent content', async (state, subject, sender, status) => {
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
  const message = open('pending')
  await screen.findByRole('heading', {name:'（主题待解析）'})
  response({...message,parse_state:'ready',from:'sender@example.test',text:'Synthetic parsed body',preview:'Synthetic parsed body'})
  await waitFor(() => expect((screen.getByRole('button', {name:'刷新'}) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', {name:'刷新'}))
  await screen.findByRole('heading', {name:'（无主题）'})
  expect(screen.getAllByText('Synthetic parsed body')).toHaveLength(2)
  expect(screen.getAllByText('sender@example.test')).toHaveLength(2)
  expect(screen.queryByText('（主题待解析）')).toBeNull()
  expect(screen.queryByText(/自动投递需等待解析成功/)).toBeNull()
})
