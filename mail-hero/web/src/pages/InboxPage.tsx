import { useEffect, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ArrowRight, ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, Filter, Inbox, Paperclip, RefreshCw, Search, Send, X } from 'lucide-react'
import { Delivery_State } from '@ziyixi/proto/mailhero/ui/v2/delivery_pb'
import { Message_DeliveryState, Message_ParseState, type Message } from '@ziyixi/proto/mailhero/ui/v2/message_pb'
import { api, enumName, filterOf, idOf, loadMessage, timeOf } from '../api/client'
import { overviewQuery, settingsQuery } from '../api/queries'
import { Button, Card, CopyButton, Empty, ErrorState, formatBytes, formatDate, Loading, PageHead, Status } from '../components/UI'
import { messageParseNotice, messageSender, messageSubject } from '../components/messageDisplay'

function MessageRow({ message, active, onSelect }: { message: Message; active: boolean; onSelect: () => void }) {
  const parseNotice = messageParseNotice(message)
  return <button type="button" className={`message-row ${active ? 'message-row-active' : ''} ${!message.read ? 'message-row-unread' : ''}`} onClick={onSelect}>
    <span className="avatar">{(message.sender || '?').trim().charAt(0).toUpperCase()}</span>
    <span className="message-row-main"><span className="message-row-top"><span className="sender">{messageSender(message)}</span><time>{formatDate(timeOf(message.receiveTime))}</time></span><span className="message-subject">{messageSubject(message)}{message.hasAttachments && <Paperclip size={14} aria-label="有附件"/>}</span><span className="message-preview">{message.snippet || parseNotice?.detail || '点击查看邮件内容'}</span></span>
    <span className="message-row-state">{parseNotice ? <Status state={enumName(Message_ParseState, message.parseState)} kind="parse"/> : <Status state={enumName(Message_DeliveryState, message.deliveryState)}/>}</span>
  </button>
}

/** The inbox's filter (ListMessages, mail_hero_ui_service.proto): the search box and the three selects. */
function inboxFilter(q: string, status: string, parseState: string, attachment: boolean): string {
  return filterOf(q, [status && `delivery_state = ${status.toUpperCase()}`, parseState && `parse_state = ${parseState.toUpperCase()}`, attachment && 'has_attachments = true'])
}

export default function InboxPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [search, setSearch] = useState(params.get('q') || '')
  const [cursorHistory, setCursorHistory] = useState<string[]>([])
  const selected = params.get('selected')
  const q = params.get('q') || ''
  const status = params.get('status') || ''
  const parseState = params.get('parse_state') || ''
  const attachment = params.get('has_attachment') === 'true'
  const cursor = params.get('page') || ''
  const messages = useQuery({ queryKey: ['messages', q, status, parseState, attachment, cursor], queryFn: () => api.listMessages({ filter: inboxFilter(q, status, parseState, attachment), pageToken: cursor, pageSize: 50 }) })
  const overview = useQuery(overviewQuery)
  const settings = useQuery(settingsQuery)
  // The preview pane: the message, its content and its latest delivery (whose effective state says whether it waits paused).
  const detail = useQuery({ queryKey: ['message', selected, 'preview'], queryFn: () => loadMessage(selected!, 1), enabled: !!selected })
  const items = messages.data?.messages || []
  const nextCursor = messages.data?.nextPageToken || ''
  const previewNotice = detail.data?.message ? messageParseNotice(detail.data.message) : null
  const latest = detail.data?.deliveries[0]
  const previewState = latest ? enumName(Delivery_State, latest.effectiveState) : detail.data ? enumName(Message_DeliveryState, detail.data.message.deliveryState) : ''

  useEffect(() => { setSearch(q) }, [q])
  function update(key: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value); else next.delete(key)
    next.delete('page'); next.delete('selected')
    setCursorHistory([]); setParams(next)
  }
  function select(id: string) {
    if (window.matchMedia('(max-width: 900px)').matches) { navigate(`/messages/${encodeURIComponent(id)}`); return }
    const next = new URLSearchParams(params); next.set('selected', id); setParams(next)
  }
  function submitSearch(event: FormEvent) { event.preventDefault(); update('q', search.trim()) }
  function nextPage() { if (!nextCursor) return; setCursorHistory([...cursorHistory, cursor]); const next = new URLSearchParams(params); next.set('page', nextCursor); next.delete('selected'); setParams(next) }
  function previousPage() { if (!cursorHistory.length) return; const stack = [...cursorHistory]; const previous = stack.pop() || ''; setCursorHistory(stack); const next = new URLSearchParams(params); if (previous) next.set('page', previous); else next.delete('page'); next.delete('selected'); setParams(next) }

  return <>
    <PageHead eyebrow="INBOX · 个人邮件入口" title="收件箱" description="转发到你的专属地址，所有邮件与投递结果都在这里。" action={<div className="head-actions"><Button variant="secondary" disabled={messages.isFetching || overview.isFetching} onClick={() => { void messages.refetch(); void overview.refetch(); if (selected) void detail.refetch() }}><RefreshCw size={16}/> 刷新</Button><Link to="/setup" className="button button-secondary"><ArrowUpRight size={16}/> 接入邮箱</Link></div>} />
    <div className="metric-grid">
      <div className="metric-card"><span className="metric-label">已收邮件</span><strong>{overview.data?.messageCount ?? '—'}</strong><span>原件与处理状态已保存</span><Inbox size={21}/></div>
      <div className="metric-card"><span className="metric-label">等待交付</span><strong>{overview.data?.pendingDeliveryCount ?? '—'}</strong><span>按限流计划处理</span><Send size={21}/></div>
      <div className="metric-card"><span className="metric-label">需要处理</span><strong>{overview.data?.failedDeliveryCount ?? '—'}</strong><span>失败邮件和投递</span><Filter size={21}/></div>
      <div className="metric-card"><span className="metric-label">邮件存储</span><strong>{formatBytes(overview.data?.logicalBytes)}</strong><span>{overview.data?.logicalLimitBytes ? `上限 ${formatBytes(overview.data.logicalLimitBytes)}` : '原件与投递记录'}</span><CalendarDays size={21}/></div>
    </div>
    <div className="inbox-toolbar"><form onSubmit={submitSearch} className="search-box"><Search size={18}/><input aria-label="搜索邮件" aria-describedby="mail-search-scope" placeholder="搜索主题、发件人或正文开头…" value={search} onChange={event => setSearch(event.target.value)}/>{search && <button type="button" aria-label="清空搜索" onClick={() => { setSearch(''); update('q', '') }}><X size={16}/></button>}<button type="submit" className="search-submit">搜索</button></form>
      <div className="filter-row"><select aria-label="投递状态" value={status} onChange={event => update('status', event.target.value)}><option value="">全部投递状态</option><option value="unarranged">未安排</option><option value="pending">等待交付</option><option value="retry_wait">等待重试</option><option value="failed">已停止</option><option value="delivered">已交付</option></select><select aria-label="解析状态" value={parseState} onChange={event => update('parse_state', event.target.value)}><option value="">全部解析状态</option><option value="ready">可阅读</option><option value="failed">需处理</option><option value="pending">待解析</option></select><label className="check-filter"><input type="checkbox" checked={attachment} onChange={event => update('has_attachment', event.target.checked ? 'true' : '')}/> 有附件</label></div>
    </div>
    <p id="mail-search-scope" className="muted small">搜索主题、发件人及正文前 16 KiB；邮件详情保留完整正文。</p>
    <div className="inbox-grid"><Card className="inbox-list-card"><div className="list-caption"><div><h2>邮件列表</h2><span>{q || status || parseState || attachment ? '筛选结果' : '最近收到的邮件'}</span></div><span>{items.length} 封</span></div>
      {messages.isPending ? <Loading label="正在读取邮件…"/> : messages.isError ? <ErrorState error={messages.error} retry={() => messages.refetch()}/> : items.length === 0 ? <Empty title={q || status || parseState || attachment ? '没有符合条件的邮件' : '等待第一封邮件'} detail={q || status || parseState || attachment ? '调整搜索词或筛选条件后再试。' : '复制收信地址，并在 Gmail 或 Exchange 中设置转发。'} action={!q && !status && !parseState && !attachment && settings.data?.receiveAddress ? <CopyButton value={settings.data.receiveAddress} label="复制收信地址"/> : <Button variant="secondary" onClick={() => { setSearch(''); setParams({}) }}>清除筛选</Button>} /> : <div className="message-list">{items.map(message => <MessageRow key={message.name} message={message} active={selected === idOf(message.name)} onSelect={() => select(idOf(message.name))}/>)}</div>}
      {(cursorHistory.length > 0 || nextCursor) && <div className="pagination"><Button variant="quiet" disabled={!cursorHistory.length} onClick={previousPage}><ChevronLeft size={16}/> 上一页</Button><span>每页最多 50 封</span><Button variant="quiet" disabled={!nextCursor} onClick={nextPage}>下一页 <ChevronRight size={16}/></Button></div>}
    </Card>
      <Card className="preview-card">{!selected ? <div className="preview-placeholder"><div className="preview-placeholder-icon"><MailPreviewIcon/></div><h2>选择一封邮件</h2><p>这里会显示正文、附件和投递状态。<br/>邮件详情中还有原件与完整时间线。</p></div> : detail.isPending ? <Loading label="正在读取邮件…"/> : detail.isError ? <ErrorState error={detail.error} retry={() => detail.refetch()}/> : <><div className="preview-top"><Status state={enumName(Message_ParseState, detail.data.message.parseState)} kind="parse"/><Link to={`/messages/${encodeURIComponent(selected)}`} className="text-link">完整详情 <ArrowRight size={15}/></Link></div><h2 className="preview-subject">{messageSubject(detail.data.message)}</h2><div className="preview-meta"><div><strong>发件人</strong><span>{messageSender(detail.data.message)}</span></div><div><strong>收到时间</strong><span>{formatDate(timeOf(detail.data.message.receiveTime))}</span></div></div><div className="preview-body">{detail.data.message.contentDeleteTime ? <p>内容已删除。</p> : detail.data.content.text ? <pre>{detail.data.content.text}</pre> : <p>{previewNotice?.detail || "暂无可显示的纯文本正文。请打开完整详情查看原件或安全 HTML。"}</p>}</div><div className="preview-bottom"><Status state={previewState}/>{detail.data.content.attachments.length ? <span><Paperclip size={15}/> {detail.data.content.attachments.length} 个附件</span> : <span>{previewNotice ? "附件信息尚未解析" : "无附件"}</span>}</div></>}
      </Card>
    </div>
  </>
}

function MailPreviewIcon() { return <Inbox size={29} strokeWidth={1.6}/> }
