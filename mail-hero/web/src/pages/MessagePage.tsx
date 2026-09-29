import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { AlertTriangle, ArrowLeft, ArrowRight, Download, FileText, Mail, Paperclip, RefreshCw, Send, Trash2 } from 'lucide-react'
import { actionId, api, apiDownload } from '../api/client'
import type { Attachment, MailboxAddress } from '../api/types'
import { messageParseNotice, messageSender, messageSubject } from '../components/messageDisplay'
import { Button, Card, Empty, ErrorState, formatBytes, formatDate, InfoRow, Loading, Modal, PageHead, SectionTitle, Status } from '../components/UI'

function addressText(value?: MailboxAddress[] | string[] | string): string {
  if (!value) return '—'
  if (typeof value === 'string') return value
  return value.map(item => typeof item === 'string' ? item : `${item.name ? `${item.name} ` : ''}<${item.address}>`).join(', ') || '—'
}

function parsingWarning(value: string): string {
  if (value === 'attached_or_opaque_message') return '邮件包含嵌套邮件或尚未展开的附件格式，请检查附件或下载原件。'
  if (value === 'no_readable_body') return '未安全提取到可读正文，请检查原件或来源邮箱。'
  if (value === 'text_truncated') return '正文超过保存预算，已保留前部；后续摘要可能遗漏尾部内容。'
  if (value === 'html_omitted') return 'HTML 超出安全处理预算，未保存 HTML 预览；请查看纯文本。'
  if (value === 'attachment_copies_omitted') return '部分附件未保存独立副本，原因见下方附件列表。'
  if (value === 'attachment_metadata_limit') return '附件数量超过上限，只列出前 100 项。'
  return value
}

function attachmentOmission(attachment: Attachment): string {
  return ({size_limit:'单个附件超过 2 MiB',message_size_limit:'每封附件副本超过 5 MiB',inline_image:'内嵌图片',capacity:'容量保护'} as const)[attachment.omitted_reason ?? 'capacity']
}

function HeaderDetails({ headers }: { headers?: Array<{ key: string; value: string }> | Record<string, string | string[]> | string }) {
  if (!headers) return <p className="muted">没有可显示的 headers。</p>
  if (typeof headers === 'string') return <pre className="headers-pre">{headers}</pre>
  if (Array.isArray(headers)) return <dl className="header-list">{headers.map(({ key, value }, index) => <div key={`${key}-${index}`}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
  return <dl className="header-list">{Object.entries(headers).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{Array.isArray(value) ? value.join(', ') : value}</dd></div>)}</dl>
}

export default function MessagePage() {
  const { id = '' } = useParams()
  const queryClient = useQueryClient()
  const result = useQuery({ queryKey: ['message', id], queryFn: () => api.message(id), enabled: !!id })
  const endpoints = useQuery({ queryKey: ['endpoints'], queryFn: api.endpoints })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const [bodyTab, setBodyTab] = useState<'text' | 'html' | 'headers'>('text')
  const [modal, setModal] = useState<'send' | 'delete' | null>(null)
  const [endpointId, setEndpointId] = useState('')
  const [requestId, setRequestId] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const message = result.data?.message
  const deliveries = result.data?.deliveries || []
  const liveEndpoints = useMemo(() => endpoints.data?.items.filter(endpoint => !endpoint.archived_at) || [], [endpoints.data])
  const activeEndpoint = liveEndpoints.find(endpoint => endpoint.id === endpointId)

  function openSend() { setEndpointId(settings.data?.current_endpoint_id || liveEndpoints[0]?.id || ''); setRequestId(actionId()); setActionError(''); setModal('send') }
  function openDelete() { setRequestId(actionId()); setActionError(''); setModal('delete') }
  async function act(work: () => Promise<unknown>, success: string) {
    setBusy(true); setActionError(''); setNotice('')
    try { await work(); setNotice(success); setModal(null); await Promise.all([queryClient.invalidateQueries({ queryKey: ['message', id] }), queryClient.invalidateQueries({ queryKey: ['messages'] }), queryClient.invalidateQueries({ queryKey: ['deliveries'] }), queryClient.invalidateQueries({ queryKey: ['overview'] })]) }
    catch (error) { setActionError(error instanceof Error ? error.message : '操作失败，请重试') }
    finally { setBusy(false) }
  }

  if (result.isPending) return <Loading label="正在读取邮件详情…" />
  if (result.isError || !message) return <ErrorState error={result.error} retry={() => result.refetch()}/>
  const deleted = !!message.content_deleted_at
  const rawAvailable = !deleted && !message.raw_expired_at
  const parseNotice = messageParseNotice(message)
  const hasHeaders = !!message.headers && (typeof message.headers === 'string' ? !!message.headers : Object.keys(message.headers).length > 0)
  const canSend = !deleted && message.parse_state === 'ready' && deliveries.length === 0

  return <>
    <div className="back-line"><Link to="/inbox"><ArrowLeft size={16}/> 返回收件箱</Link><span>邮件 / {message.id.slice(0, 8)}</span></div>
    <PageHead eyebrow={`邮件详情 · ${formatDate(message.received_at)}`} title={messageSubject(message)} description={messageSender(message)} action={<div className="head-actions">{canSend && <Button onClick={openSend}><Send size={16}/> 发送到目标</Button>}{rawAvailable && <a className="button button-secondary" href={apiDownload(`/messages/${encodeURIComponent(id)}/raw`)} download><Download size={16}/> 下载原件</a>}</div>}/>
    {notice && <div className="success-banner" role="status">{notice}</div>}
    {!deleted && message.parse_error && <div className="inline-error" role="alert">处理未完成：{message.parse_error}。{rawAvailable ? '原件仍保留，可下载检查后重新解析。' : '原件已过期，请检查来源邮箱。'}</div>}
    {!deleted && message.needs_review && <div className="warning-banner" role="status"><AlertTriangle size={17}/><div><strong>这封邮件需要人工检查。</strong><p>确认正文与附件内容后，再决定是否手动投递；自动交付不会猜测未展开的内容。</p>{message.warnings?.map((warning, index) => <p key={`${warning}-${index}`}>{parsingWarning(warning)}</p>)}</div></div>}
    {!deleted && message.search_index_truncated && <p className="fact-callout">这封邮件较长，搜索只包含正文前 16 KiB。保存正文的范围以下方提示为准。</p>}
    {!deleted && message.raw_expired_at && <p className="fact-callout">原件已按保留策略过期，不能下载或重新解析。下方已保存的正文和附件仍可查看；完整来源请到原邮箱查找。</p>}
    {!deleted && message.text_truncated && <p className="fact-callout">正文不完整：原始纯文本 {formatBytes(message.original_text_bytes)}，此处最多保存前 1 MiB；webhook 最多发送前 256 KiB，消费者会收到截断标记。</p>}
    {!deleted && !message.needs_review && !!message.warnings?.length && <div className="warning-banner" role="status"><AlertTriangle size={17}/><div>{message.warnings.map((warning, index) => <p key={`${warning}-${index}`}>{parsingWarning(warning)}</p>)}</div></div>}
    {actionError && <div className="inline-error" role="alert">{actionError}</div>}
    <div className="detail-grid"><div className="detail-main">
      <Card><div className="message-info-header"><div className="avatar avatar-large">{(message.from || '?').charAt(0).toUpperCase()}</div><div><strong>{messageSender(message)}</strong><span>发送给 {addressText(message.to)}</span></div><time>{formatDate(message.received_at)}</time></div><dl className="info-grid"><InfoRow label="接收状态"><span className="plain-status">已保存 {message.arrival_count && message.arrival_count > 1 ? `· 重复到达 ${message.arrival_count} 次` : ''}</span></InfoRow><InfoRow label="解析状态"><Status state={message.parse_state} kind="parse"/></InfoRow><InfoRow label="交付状态"><Status state={message.delivery_state}/></InfoRow><InfoRow label="邮件大小">{formatBytes(message.size_bytes)}</InfoRow></dl></Card>
      <Card className="mail-body-card"><div className="tabs" role="tablist" aria-label="邮件内容"><button role="tab" aria-selected={bodyTab === 'text'} className={bodyTab === 'text' ? 'active' : ''} onClick={() => setBodyTab('text')}>纯文本</button><button role="tab" aria-selected={bodyTab === 'html'} className={bodyTab === 'html' ? 'active' : ''} onClick={() => setBodyTab('html')}>安全 HTML</button><button role="tab" aria-selected={bodyTab === 'headers'} className={bodyTab === 'headers' ? 'active' : ''} onClick={() => setBodyTab('headers')}>邮件头</button></div>
        {deleted ? <Empty title="邮件内容已删除" detail="保留了最少的收件与交付记录；原件和附件不可再下载。"/> : bodyTab === 'text' ? <div role="tabpanel" className="mail-body">{message.text ? <pre>{message.text}</pre> : <Empty title={parseNotice?.title || "没有纯文本正文"} detail={parseNotice?.detail || "可以查看安全 HTML、邮件头或下载原件。"}/>}</div> : bodyTab === 'html' ? <div role="tabpanel" className="html-pane">{message.html ? <><div className="privacy-note"><AlertTriangle size={16}/> HTML 在隔离窗口中展示，远程资源被禁用。</div><iframe title="邮件安全 HTML 预览" sandbox="" referrerPolicy="no-referrer" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; font-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">${message.html}`}/></> : <Empty title={parseNotice?.title || (message.html_omitted ? "HTML 预览已省略" : "没有 HTML 正文")} detail={parseNotice?.detail || (message.html_omitted ? "HTML 超出安全处理预算，请查看纯文本或来源邮箱。" : "未提供可显示的 HTML 内容。")}/>}</div> : <div role="tabpanel" className="headers-pane">{parseNotice && !hasHeaders ? <Empty title="邮件头尚未解析" detail={parseNotice.detail}/> : <HeaderDetails headers={message.headers}/>}</div>}
      </Card>
      <Card><SectionTitle title="附件" detail="仅供下载；文件未进行病毒扫描。"/>{deleted ? <p className="muted">内容已删除。</p> : message.attachments?.length ? <div className="attachment-list">{message.attachments.map(attachment => attachment.storage_status === 'omitted' ? <div className="attachment" key={attachment.part_id}><div className="attachment-icon"><Paperclip size={18}/></div><div><strong>{attachment.filename || '未命名附件'}</strong><span>{attachment.content_type} · {formatBytes(attachment.size_bytes ?? attachment.size)}</span><span>未保存独立副本：{attachmentOmission(attachment)}。{rawAvailable ? '可在原件中查找。' : '请回到来源邮箱查找。'}</span></div></div> : <a className="attachment" key={attachment.part_id} href={apiDownload(`/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachment.part_id)}`)} download><div className="attachment-icon"><Paperclip size={18}/></div><div><strong>{attachment.filename || '未命名附件'}</strong><span>{attachment.content_type} · {formatBytes(attachment.size_bytes ?? attachment.size)}</span></div><Download size={17}/></a>)}</div> : <p className="muted">{parseNotice ? "附件信息尚未解析。" : "没有附件。"}</p>}{!deleted && !!message.attachments_omitted_count && <p className="fact-callout">另有 {message.attachments_omitted_count} 个附件未列出，超过 100 项元信息上限；请检查原件或来源邮箱。</p>}</Card>
      <Card><SectionTitle title="原始信息" detail="实际 SMTP envelope 与邮件 Header 可能不同。"/><dl className="info-grid"><InfoRow label="Envelope From">{message.envelope_from || '（空退信地址）'}</InfoRow><InfoRow label="Envelope To">{addressText(message.envelope_to)}</InfoRow><InfoRow label="Message-ID">{message.rfc_message_id || '—'}</InfoRow><InfoRow label="发送时间">{formatDate(message.sent_at)}</InfoRow><InfoRow label="Mail Hero ID"><code>{message.id}</code></InfoRow></dl></Card>
    </div><aside className="detail-side"><Card><SectionTitle title="交付时间线" detail="已交付表示目标服务接管，不代表任务已完成。"/>{deliveries.length ? <div className="timeline">{deliveries.map(delivery => <Link className="timeline-item" key={delivery.event_id} to={`/deliveries/${encodeURIComponent(delivery.event_id)}`}><span className="timeline-marker"/><div><Status state={delivery.state}/><strong>{delivery.endpoint_label || 'Webhook 目标'}</strong><small>{formatDate(delivery.created_at)} · 尝试 {delivery.attempt_count} 次</small>{delivery.last_error && <em>{delivery.last_error}</em>}</div><ArrowRight size={16}/></Link>)}</div> : <div className="mini-empty"><Mail size={20}/><p>尚未安排投递。</p><span>{parseNotice ? "自动投递需等待邮件解析成功。" : "手动发送或开启自动投递后，这里会显示历史。"}</span></div>}</Card>
      <Card><SectionTitle title="邮件操作"/><div className="action-list"><button disabled={busy} onClick={() => act(() => api.markRead(id, message.version, !message.read_at), message.read_at ? '已标记为未读。' : '已标记为已读。')}><Mail size={17}/> {message.read_at ? '标记为未读' : '标记为已读'} <ArrowRight size={15}/></button>{message.parse_state === 'failed' && rawAvailable && <button disabled={busy} onClick={() => act(() => api.reparse(id), '已安排重新解析。')}><RefreshCw size={17}/> 重新解析 <ArrowRight size={15}/></button>}{canSend && <button onClick={openSend}><Send size={17}/> 发送到 webhook <ArrowRight size={15}/></button>}{deliveries.length > 0 && <Link to={`/deliveries/${encodeURIComponent(deliveries[deliveries.length - 1].event_id)}`}><FileText size={17}/> 查看投递详情 <ArrowRight size={15}/></Link>}{!deleted && <button className="danger-action" onClick={openDelete}><Trash2 size={17}/> 删除邮件内容 <ArrowRight size={15}/></button>}</div></Card>
    </aside></div>
    {modal === 'send' && <Modal title="发送到 webhook 目标" onClose={() => !busy && setModal(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setModal(null)}>取消</Button><Button loading={busy} disabled={!endpointId} onClick={() => act(async () => { await api.sendMessage(id, endpointId, requestId) }, '邮件已加入交付队列。')}>确认发送</Button></>}><p>将这封邮件的主题、正文与附件元信息发送到选定目标。附件文件本身不会发送。</p><label className="field"><span>目标</span><select value={endpointId} onChange={event => setEndpointId(event.target.value)}>{liveEndpoints.map(endpoint => <option key={endpoint.id} value={endpoint.id}>{endpoint.label} · {endpoint.url}</option>)}</select></label>{!liveEndpoints.length && <p className="inline-error">尚无可用目标。请先在 Webhook 目标中配置。</p>}{activeEndpoint && <p className="muted">接收地址仅保留在 Mail Hero，不会自动包含在 webhook payload 中。</p>}{actionError && <p className="inline-error">{actionError}</p>}</Modal>}
    {modal === 'delete' && <Modal title="删除这封邮件的内容？" danger onClose={() => !busy && setModal(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setModal(null)}>保留邮件</Button><Button variant="danger" loading={busy} onClick={() => act(() => api.deleteContent(id, message.version, requestId), '邮件内容已删除。')}>永久删除内容</Button></>}><p>原件、正文、附件和未交付的请求内容会一起删除；最少的去重和状态记录会保留。已经发出的 HTTP 请求无法撤回。</p>{actionError && <p className="inline-error">{actionError}</p>}</Modal>}
  </>
}
