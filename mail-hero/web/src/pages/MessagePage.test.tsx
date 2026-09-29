// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { api } from '../api/client'
import type { MessageDetail } from '../api/types'
import MessagePage from './MessagePage'

vi.mock('../api/client', () => ({
  api: {message:vi.fn(), endpoints:vi.fn(), settings:vi.fn()},
  apiDownload:(path:string) => `/api/v1${path}`, actionId:() => 'action-test',
}))
afterEach(() => { cleanup(); vi.clearAllMocks() })

function open(message: Partial<MessageDetail>) {
  vi.mocked(api.message).mockResolvedValue({message:{
    id:'synthetic-message',subject:'Synthetic body policy',from:'sender@example.test',
    received_at:'2026-09-26T00:00:00Z',parse_state:'ready',version:1,text:'Synthetic retained text',...message,
  },deliveries:[]})
  vi.mocked(api.endpoints).mockResolvedValue({items:[]})
  vi.mocked(api.settings).mockResolvedValue({version:1,mode:'archive',receive_address:'hero@example.test',send_paused:true})
  const client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/messages/synthetic-message']}><Routes><Route path="/messages/:id" element={<MessagePage/>}/></Routes></MemoryRouter></QueryClientProvider>)
}

it('makes incomplete body and omitted attachment visible without a broken download link', async () => {
  open({text_truncated:true,original_text_bytes:2_000_000,html_omitted:true,attachments_omitted_count:2,
    warnings:['html_omitted','attachment_copies_omitted'],attachments:[
      {part_id:'1.1',filename:'large.bin',content_type:'application/octet-stream',size:3_000_000,storage_status:'omitted',omitted_reason:'size_limit'},
      {part_id:'1.2',filename:'small.pdf',content_type:'application/pdf',size:10,storage_status:'stored'},
    ]})
  await screen.findByText('Synthetic retained text')
  expect(screen.getByText(/正文不完整：原始纯文本/)).toBeTruthy()
  expect(screen.getByText(/另有 2 个附件未列出/)).toBeTruthy()
  expect(screen.getByText('large.bin').closest('a')).toBeNull()
  expect(screen.getByText('small.pdf').closest('a')?.getAttribute('href')).toContain('/attachments/1.2')
  fireEvent.click(screen.getByRole('tab', {name:'安全 HTML'}))
  expect(screen.getByText('HTML 预览已省略')).toBeTruthy()
})

it('raw expiry removes download and reparse but preserves the retained body', async () => {
  open({parse_state:'failed',parse_error:'synthetic_error',raw_expired_at:'2026-09-26T00:00:00Z'})
  await screen.findByText('Synthetic retained text')
  expect(screen.queryByRole('link',{name:'下载原件'})).toBeNull()
  expect(screen.queryByRole('button',{name:/重新解析/})).toBeNull()
  expect(screen.getByText(/原件已按保留策略过期/)).toBeTruthy()
})

it.each([
  ['pending', '（主题待解析）', '发件人待解析', '正文尚未解析'],
  ['parsing', '（正在解析主题）', '正在解析发件人', '正在提取正文'],
  ['failed', '（主题解析未完成）', '发件人解析未完成', '正文解析未完成'],
] as const)('distinguishes %s content from a parsed empty email', async (parse_state, subject, sender, body) => {
  open({parse_state,subject:'',from:'',text:'',html:'',headers:[],attachments:[]})
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
  open({parse_state:'ready',subject:'',text:'',html:'',attachments:[]})
  await screen.findByRole('heading', {level:1,name:'（无主题）'})
  expect(screen.getByRole('heading', {name:'没有纯文本正文'})).toBeTruthy()
  expect(screen.getByText('没有附件。')).toBeTruthy()
  expect(screen.queryByText('自动投递需等待邮件解析成功。')).toBeNull()
})
