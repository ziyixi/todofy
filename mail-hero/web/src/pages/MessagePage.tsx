import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { AlertTriangle, ArrowLeft, ArrowRight, Download, FileText, Mail, Paperclip, RefreshCw, Send, Trash2 } from 'lucide-react'
import { Delivery_State } from '@ziyixi/proto/mailhero/ui/v2/delivery_pb'
import { Attachment_OmittedReason, Attachment_StorageState, Message_DeliveryState, Message_ParseState, type Address, type Attachment, type Header } from '@ziyixi/proto/mailhero/ui/v2/message_pb'
import { api, endpointName, enumName, idOf, loadMessage, messageName, newRequestId, timeOf } from '../api/client'
import { endpointsQuery, settingsQuery } from '../api/queries'
import { messageParseNotice, messageSender, messageSubject } from '../components/messageDisplay'
import { Button, Card, Empty, ErrorState, formatBytes, formatDate, InfoRow, Loading, Modal, PageHead, SectionTitle, Status } from '../components/UI'

function addressText(value: readonly Address[] | string): string {
  if (typeof value === 'string') return value || '—'
  return value.map(item => `${item.displayName ? `${item.displayName} ` : ''}<${item.address}>`).join(', ') || '—'
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

const OMISSIONS: Partial<Record<Attachment_OmittedReason, string>> = {
  [Attachment_OmittedReason.SIZE_LIMIT]: '单个附件超过 2 MiB', [Attachment_OmittedReason.MESSAGE_SIZE_LIMIT]: '每封附件副本超过 5 MiB',
  [Attachment_OmittedReason.INLINE_IMAGE]: '内嵌图片', [Attachment_OmittedReason.CAPACITY]: '容量保护',
}
function attachmentOmission(attachment: Attachment): string {
  return OMISSIONS[attachment.omittedReason] ?? '容量保护'
}

function HeaderDetails({ headers }: { headers: readonly Header[] }) {
  if (!headers.length) return <p className="muted">没有可显示的 headers。</p>
  return <dl className="header-list">{headers.map(({ key, value }, index) => <div key={`${key}-${index}`}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
}

export default function MessagePage() {
  const { id = '' } = useParams()
  const queryClient = useQueryClient()
  const result = useQuery({ queryKey: ['message', id], queryFn: () => loadMessage(id), enabled: !!id })
  const endpoints = useQuery(endpointsQuery)
  const settings = useQuery(settingsQuery)
  const [bodyTab, setBodyTab] = useState<'text' | 'html' | 'headers'>('text')
  const [modal, setModal] = useState<'send' | 'delete' | null>(null)
  const [endpointId, setEndpointId] = useState('')
  const [requestId, setRequestId] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const message = result.data?.message
  const content = result.data?.content
  const deliveries = result.data?.deliveries || []
  const liveEndpoints = useMemo(() => endpoints.data || [], [endpoints.data])
  const activeEndpoint = liveEndpoints.find(endpoint => idOf(endpoint.name) === endpointId)

  function openSend() { setEndpointId(idOf(settings.data?.currentEndpoint || liveEndpoints[0]?.name || '')); setRequestId(newRequestId()); setActionError(''); setModal('send') }
  function openDelete() { setRequestId(newRequestId()); setActionError(''); setModal('delete') }
  async function act(work: () => Promise<unknown>, success: string) {
    setBusy(true); setActionError(''); setNotice('')
    try { await work(); setNotice(success); setModal(null); await Promise.all([queryClient.invalidateQueries({ queryKey: ['message', id] }), queryClient.invalidateQueries({ queryKey: ['messages'] }), queryClient.invalidateQueries({ queryKey: ['deliveries'] }), queryClient.invalidateQueries({ queryKey: ['overview'] })]) }
    catch (error) { setActionError(error instanceof Error ? error.message : '操作失败，请重试') }
    finally { setBusy(false) }
  }

  if (result.isPending) return <Loading label="正在读取邮件详情…" />
  if (result.isError || !message || !content) return <ErrorState error={result.error} retry={() => result.refetch()}/>
  const deleted = !!message.contentDeleteTime
  const rawAvailable = !deleted && !!message.rawDownloadUri
  const parseNotice = messageParseNotice(message)
  const hasHeaders = content.headers.length > 0
  const canSend = !deleted && message.parseState === Message_ParseState.READY && deliveries.length === 0
  // The latest delivery's effective state says whether it waits paused (the message's own is the stored one).
  const deliveryState = deliveries[0] ? enumName(Delivery_State, deliveries[0].effectiveState) : enumName(Message_DeliveryState, message.deliveryState)
  const name = messageName(id)

  return <>
    <div className="back-line"><Link to="/inbox"><ArrowLeft size={16}/> 返回收件箱</Link><span>邮件 / {id.slice(0, 8)}</span></div>
    <PageHead eyebrow={`邮件详情 · ${formatDate(timeOf(message.receiveTime))}`} title={messageSubject(message)} description={messageSender(message)} action={<div className="head-actions">{canSend && <Button onClick={openSend}><Send size={16}/> 发送到目标</Button>}{rawAvailable && <a className="button button-secondary" href={message.rawDownloadUri} download><Download size={16}/> 下载原件</a>}</div>}/>
    {notice && <div className="success-banner" role="status">{notice}</div>}
    {!deleted && message.parseError && <div className="inline-error" role="alert">处理未完成：{message.parseError}。{rawAvailable ? '原件仍保留，可下载检查后重新解析。' : '原件已过期，请检查来源邮箱。'}</div>}
    {!deleted && content.needsReview && <div className="warning-banner" role="status"><AlertTriangle size={17}/><div><strong>这封邮件需要人工检查。</strong><p>确认正文与附件内容后，再决定是否手动投递；自动交付不会猜测未展开的内容。</p>{content.warnings.map((warning, index) => <p key={`${warning}-${index}`}>{parsingWarning(warning)}</p>)}</div></div>}
    {!deleted && message.searchIndexTruncated && <p className="fact-callout">这封邮件较长，搜索只包含正文前 16 KiB。保存正文的范围以下方提示为准。</p>}
    {!deleted && message.rawExpireTime && <p className="fact-callout">原件已按保留策略过期，不能下载或重新解析。下方已保存的正文和附件仍可查看；完整来源请到原邮箱查找。</p>}
    {!deleted && content.textTruncated && <p className="fact-callout">正文不完整：原始纯文本 {formatBytes(content.originalTextBytes)}，此处最多保存前 1 MiB；webhook 最多发送前 256 KiB，消费者会收到截断标记。</p>}
    {!deleted && !content.needsReview && content.warnings.length > 0 && <div className="warning-banner" role="status"><AlertTriangle size={17}/><div>{content.warnings.map((warning, index) => <p key={`${warning}-${index}`}>{parsingWarning(warning)}</p>)}</div></div>}
    {actionError && <div className="inline-error" role="alert">{actionError}</div>}
    <div className="detail-grid"><div className="detail-main">
      <Card><div className="message-info-header"><div className="avatar avatar-large">{(message.sender || '?').charAt(0).toUpperCase()}</div><div><strong>{messageSender(message)}</strong><span>发送给 {addressText(content.recipients)}</span></div><time>{formatDate(timeOf(message.receiveTime))}</time></div><dl className="info-grid"><InfoRow label="接收状态"><span className="plain-status">已保存 {message.arrivalCount > 1 ? `· 重复到达 ${message.arrivalCount} 次` : ''}</span></InfoRow><InfoRow label="解析状态"><Status state={enumName(Message_ParseState, message.parseState)} kind="parse"/></InfoRow><InfoRow label="交付状态"><Status state={deliveryState}/></InfoRow><InfoRow label="邮件大小">{formatBytes(message.sizeBytes)}</InfoRow></dl></Card>
      <Card className="mail-body-card"><div className="tabs" role="tablist" aria-label="邮件内容"><button role="tab" aria-selected={bodyTab === 'text'} className={bodyTab === 'text' ? 'active' : ''} onClick={() => setBodyTab('text')}>纯文本</button><button role="tab" aria-selected={bodyTab === 'html'} className={bodyTab === 'html' ? 'active' : ''} onClick={() => setBodyTab('html')}>安全 HTML</button><button role="tab" aria-selected={bodyTab === 'headers'} className={bodyTab === 'headers' ? 'active' : ''} onClick={() => setBodyTab('headers')}>邮件头</button></div>
        {deleted ? <Empty title="邮件内容已删除" detail="保留了最少的收件与交付记录；原件和附件不可再下载。"/> : bodyTab === 'text' ? <div role="tabpanel" className="mail-body">{content.text ? <pre>{content.text}</pre> : <Empty title={parseNotice?.title || "没有纯文本正文"} detail={parseNotice?.detail || "可以查看安全 HTML、邮件头或下载原件。"}/>}</div> : bodyTab === 'html' ? <div role="tabpanel" className="html-pane">{content.html ? <><div className="privacy-note"><AlertTriangle size={16}/> HTML 在隔离窗口中展示，远程资源被禁用。</div><iframe title="邮件安全 HTML 预览" sandbox="" referrerPolicy="no-referrer" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; font-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">${content.html}`}/></> : <Empty title={parseNotice?.title || (content.htmlOmitted ? "HTML 预览已省略" : "没有 HTML 正文")} detail={parseNotice?.detail || (content.htmlOmitted ? "HTML 超出安全处理预算，请查看纯文本或来源邮箱。" : "未提供可显示的 HTML 内容。")}/>}</div> : <div role="tabpanel" className="headers-pane">{parseNotice && !hasHeaders ? <Empty title="邮件头尚未解析" detail={parseNotice.detail}/> : <HeaderDetails headers={content.headers}/>}</div>}
      </Card>
      <Card><SectionTitle title="附件" detail="仅供下载；文件未进行病毒扫描。"/>{deleted ? <p className="muted">内容已删除。</p> : content.attachments.length ? <div className="attachment-list">{content.attachments.map(attachment => attachment.storageState === Attachment_StorageState.OMITTED || !attachment.downloadUri ? <div className="attachment" key={attachment.partId}><div className="attachment-icon"><Paperclip size={18}/></div><div><strong>{attachment.filename || '未命名附件'}</strong><span>{attachment.mimeType} · {formatBytes(attachment.sizeBytes)}</span><span>未保存独立副本：{attachmentOmission(attachment)}。{rawAvailable ? '可在原件中查找。' : '请回到来源邮箱查找。'}</span></div></div> : <a className="attachment" key={attachment.partId} href={attachment.downloadUri} download><div className="attachment-icon"><Paperclip size={18}/></div><div><strong>{attachment.filename || '未命名附件'}</strong><span>{attachment.mimeType} · {formatBytes(attachment.sizeBytes)}</span></div><Download size={17}/></a>)}</div> : <p className="muted">{parseNotice ? "附件信息尚未解析。" : "没有附件。"}</p>}{!deleted && content.omittedAttachmentCount > 0 && <p className="fact-callout">另有 {content.omittedAttachmentCount} 个附件未列出，超过 100 项元信息上限；请检查原件或来源邮箱。</p>}</Card>
      <Card><SectionTitle title="原始信息" detail="实际 SMTP envelope 与邮件 Header 可能不同。"/><dl className="info-grid"><InfoRow label="Envelope From">{message.envelopeSender || '（空退信地址）'}</InfoRow><InfoRow label="Envelope To">{addressText(message.envelopeRecipient)}</InfoRow><InfoRow label="Message-ID">{content.rfcMessageId || '—'}</InfoRow><InfoRow label="发送时间">{formatDate(timeOf(content.sendTime))}</InfoRow><InfoRow label="Mail Hero ID"><code>{id}</code></InfoRow></dl></Card>
    </div><aside className="detail-side"><Card><SectionTitle title="交付时间线" detail="已交付表示目标服务接管，不代表任务已完成。"/>{deliveries.length ? <div className="timeline">{deliveries.map(delivery => <Link className="timeline-item" key={delivery.name} to={`/deliveries/${encodeURIComponent(idOf(delivery.name))}`}><span className="timeline-marker"/><div><Status state={enumName(Delivery_State, delivery.state)}/><strong>{delivery.endpointDisplayName || 'Webhook 目标'}</strong><small>{formatDate(timeOf(delivery.createTime))} · 尝试 {delivery.attemptCount} 次</small>{delivery.lastError && <em>{delivery.lastError}</em>}</div><ArrowRight size={16}/></Link>)}</div> : <div className="mini-empty"><Mail size={20}/><p>尚未安排投递。</p><span>{parseNotice ? "自动投递需等待邮件解析成功。" : "手动发送或开启自动投递后，这里会显示历史。"}</span></div>}</Card>
      <Card><SectionTitle title="邮件操作"/><div className="action-list"><button disabled={busy} onClick={() => act(() => api.updateMessage({ message: { name, read: !message.read, etag: message.etag }, updateMask: { paths: ['read', 'etag'] } }), message.read ? '已标记为未读。' : '已标记为已读。')}><Mail size={17}/> {message.read ? '标记为未读' : '标记为已读'} <ArrowRight size={15}/></button>{message.parseState === Message_ParseState.FAILED && rawAvailable && <button disabled={busy} onClick={() => act(() => api.reparseMessage({ name, requestId: newRequestId() }), '已安排重新解析。')}><RefreshCw size={17}/> 重新解析 <ArrowRight size={15}/></button>}{canSend && <button onClick={openSend}><Send size={17}/> 发送到 webhook <ArrowRight size={15}/></button>}{deliveries.length > 0 && <Link to={`/deliveries/${encodeURIComponent(idOf(deliveries[deliveries.length - 1].name))}`}><FileText size={17}/> 查看投递详情 <ArrowRight size={15}/></Link>}{!deleted && <button className="danger-action" onClick={openDelete}><Trash2 size={17}/> 删除邮件内容 <ArrowRight size={15}/></button>}</div></Card>
    </aside></div>
    {modal === 'send' && <Modal title="发送到 webhook 目标" onClose={() => !busy && setModal(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setModal(null)}>取消</Button><Button loading={busy} disabled={!endpointId} onClick={() => act(() => api.sendMessage({ name, endpoint: endpointName(endpointId), requestId }), '邮件已加入交付队列。')}>确认发送</Button></>}><p>将这封邮件的主题、正文与附件元信息发送到选定目标。附件文件本身不会发送。</p><label className="field"><span>目标</span><select value={endpointId} onChange={event => setEndpointId(event.target.value)}>{liveEndpoints.map(endpoint => <option key={endpoint.name} value={idOf(endpoint.name)}>{endpoint.displayName} · {endpoint.uri}</option>)}</select></label>{!liveEndpoints.length && <p className="inline-error">尚无可用目标。请先在 Webhook 目标中配置。</p>}{activeEndpoint && <p className="muted">接收地址仅保留在 Mail Hero，不会自动包含在 webhook payload 中。</p>}{actionError && <p className="inline-error">{actionError}</p>}</Modal>}
    {modal === 'delete' && <Modal title="删除这封邮件的内容？" danger onClose={() => !busy && setModal(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setModal(null)}>保留邮件</Button><Button variant="danger" loading={busy} onClick={() => act(() => api.clearMessageContent({ name, etag: message.etag, requestId }), '邮件内容已删除。')}>永久删除内容</Button></>}><p>原件、正文、附件和未交付的请求内容会一起删除；最少的去重和状态记录会保留。已经发出的 HTTP 请求无法撤回。</p>{actionError && <p className="inline-error">{actionError}</p>}</Modal>}
  </>
}
