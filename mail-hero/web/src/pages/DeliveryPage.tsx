import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { AlertCircle, ArrowLeft, ArrowRight, Ban, Clock3, RefreshCw, Repeat2, Send } from 'lucide-react'
import { DeliveryAttempt_Outcome, Delivery_State } from '@ziyixi/proto/mailhero/ui/v2/delivery_pb'
import { Message_ParseState } from '@ziyixi/proto/mailhero/ui/v2/message_pb'
import { api, deliveryName, endpointName, enumName, idOf, loadDelivery, newRequestId, timeOf } from '../api/client'
import { endpointsQuery } from '../api/queries'
import { Button, Card, CopyButton, ErrorState, formatDate, InfoRow, Loading, Modal, PageHead, SectionTitle, Status } from '../components/UI'

/** The frozen request pretty-printed for reading (its bytes as sent when they are not JSON). */
function pretty(body: string): string {
  try { return JSON.stringify(JSON.parse(body), null, 2) } catch { return body }
}

export default function DeliveryPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const result = useQuery({ queryKey: ['delivery', id], queryFn: () => loadDelivery(id), enabled: !!id })
  const endpoints = useQuery(endpointsQuery)
  // The related message (a synthetic test's or canary's is NOT_FOUND: the card says it is not available).
  const messageID = result.data ? idOf(result.data.delivery.message) : ''
  const message = useQuery({ queryKey: ['message', messageID, 'related'], queryFn: () => api.getMessage({ name: result.data!.delivery.message }), enabled: !!messageID })
  const [modal, setModal] = useState<'retry' | 'cancel' | 'replay' | null>(null)
  const [requestId, setRequestId] = useState('')
  const [endpointId, setEndpointId] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  function open(kind: 'retry' | 'cancel' | 'replay') { setRequestId(newRequestId()); setEndpointId(idOf(result.data?.delivery.endpoint || endpoints.data?.[0]?.name || '')); setActionError(''); setModal(kind) }
  async function act<T>(work: () => Promise<T>, success: string, next?: (value: T) => string | null) {
    setBusy(true); setActionError(''); setNotice('')
    try { const value = await work(); setModal(null); setNotice(success); await Promise.all([queryClient.invalidateQueries({ queryKey: ['delivery', id] }), queryClient.invalidateQueries({ queryKey: ['deliveries'] }), queryClient.invalidateQueries({ queryKey: ['message'] }), queryClient.invalidateQueries({ queryKey: ['overview'] })]); const target = next?.(value); if (target) navigate(target) }
    catch (error) { setActionError(error instanceof Error ? error.message : '操作失败，请重试') }
    finally { setBusy(false) }
  }
  if (result.isPending) return <Loading label="正在读取投递详情…"/>
  if (result.isError) return <ErrorState error={result.error} retry={() => result.refetch()}/>
  const { delivery, attempts, payload } = result.data
  const state = enumName(Delivery_State, delivery.state)
  const name = deliveryName(id)
  const mutable = ['pending', 'retry_wait', 'failed', 'sending'].includes(state)
  const canRetry = ['failed', 'retry_wait'].includes(state)
  const canReplay = !!message.data && !message.data.contentDeleteTime && message.data.parseState === Message_ParseState.READY

  return <><div className="back-line"><Link to={`/deliveries${location.search}`}><ArrowLeft size={16}/> 返回投递记录</Link><span>事件 / {id.slice(0, 8)}</span></div>
    <PageHead eyebrow="WEBHOOK · 事件详情" title="投递详情" description="同一事件重试始终使用相同的请求内容与事件 ID。" action={<div className="head-actions">{canRetry && <Button onClick={() => open('retry')}><RefreshCw size={16}/> 重试原事件</Button>}{mutable && <Button variant="secondary" onClick={() => open('cancel')}><Ban size={16}/> 取消交付</Button>}</div>}/>
    {notice && <div className="success-banner" role="status">{notice}</div>}{actionError && <div className="inline-error" role="alert">{actionError}</div>}
    <div className="detail-grid"><div className="detail-main">
      <Card><div className="delivery-hero"><div><span className="eyebrow">当前状态</span><h2><Status state={enumName(Delivery_State, delivery.effectiveState) || state}/></h2><p>{state === 'delivered' ? '消费者已持久接管此事件。后续业务结果请在消费者服务查看。' : delivery.lastError || 'Mail Hero 将按当前状态处理此事件。'}</p></div><div className="delivery-count"><strong>{delivery.attemptCount}</strong><span>次尝试</span></div></div><dl className="info-grid"><InfoRow label="事件 ID"><code>{id}</code><CopyButton value={id}/></InfoRow>{delivery.canary && <InfoRow label="类型"><span className="canary-tag">金丝雀</span> 运维合成事件，带 canary 标记；消费者不应据此创建任务或发送消息</InfoRow>}<InfoRow label="目标">{delivery.endpointDisplayName || idOf(delivery.endpoint) || '—'}</InfoRow><InfoRow label="创建时间">{formatDate(timeOf(delivery.createTime))}</InfoRow><InfoRow label="下次尝试">{formatDate(timeOf(delivery.nextAttemptTime))}</InfoRow><InfoRow label="完成时间">{formatDate(timeOf(delivery.deliverTime))}</InfoRow>{delivery.sourceDelivery && <InfoRow label="重发自"><Link to={`/deliveries/${encodeURIComponent(idOf(delivery.sourceDelivery))}`}>{idOf(delivery.sourceDelivery).slice(0, 8)}…</Link></InfoRow>}</dl></Card>
      <Card><SectionTitle title="尝试时间线" detail="连接失败、HTTP 响应与重试安排都会留下记录。"/>{attempts.length ? <div className="attempt-list">{attempts.map(attempt => { const ok = attempt.httpStatus >= 200 && attempt.httpStatus < 300; return <div className="attempt-item" key={attempt.name}><div className={`attempt-icon ${ok ? 'attempt-ok' : ''}`}>{ok ? <Send size={17}/> : <AlertCircle size={17}/>}</div><div><div className="attempt-line"><strong>第 {idOf(attempt.name)} 次尝试</strong><time>{formatDate(timeOf(attempt.startTime))}</time></div><div className="attempt-meta"><span>{attempt.httpStatus ? `HTTP ${attempt.httpStatus}` : enumName(DeliveryAttempt_Outcome, attempt.outcome) || '未收到响应'}</span>{attempt.durationMs > 0 && <span>{attempt.durationMs} ms</span>}{attempt.errorCode && <span>{attempt.errorCode}</span>}</div>{attempt.responsePreview && <pre className="response-preview">{attempt.responsePreview}</pre>}</div></div> })}</div> : <div className="mini-empty"><Clock3 size={20}/><p>尚无尝试记录。</p></div>}</Card>
      <Card><SectionTitle title="冻结请求" detail="普通重试会发送相同的 JSON，不会使用最新的邮件正文。"/>{payload.body ? <pre className="json-preview">{pretty(payload.body)}</pre> : <p className="muted">请求内容不可用，可能已随邮件删除。</p>}</Card>
    </div><aside className="detail-side"><Card><SectionTitle title="相关邮件"/>{message.data ? <><strong className="related-subject">{message.data.subject || '（无主题）'}</strong><p className="muted">{message.data.sender || '未知发件人'}</p><Link to={`/messages/${encodeURIComponent(messageID)}`} className="text-link">打开邮件 <ArrowRight size={15}/></Link></> : <p className="muted">邮件详情加载中或已不可用。</p>}</Card><Card><SectionTitle title="其他操作"/><div className="action-list"><button disabled={!canReplay} onClick={() => open('replay')}><Repeat2 size={17}/> 重新发送为新事件 <ArrowRight size={15}/></button>{!canReplay && <p className="muted small">需要仍保留的可解析邮件正文。</p>}{canRetry && <button onClick={() => open('retry')}><RefreshCw size={17}/> 重试原事件 <ArrowRight size={15}/></button>}</div><p className="subtle-note">新事件可能再次触发消费者业务。已交付事件不能用普通重试重复执行。</p></Card></aside></div>
    {modal === 'retry' && <Modal title="重试原事件" onClose={() => !busy && setModal(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setModal(null)}>取消</Button><Button loading={busy} onClick={() => act(() => api.retryDelivery({ name, requestId }), '已安排一次受限重试。')}>确认重试</Button></>}><p>保留事件 ID、请求正文和目标版本；仍遵守限流与重放期限。</p>{actionError && <p className="inline-error">{actionError}</p>}</Modal>}
    {modal === 'cancel' && <Modal title="取消未完成的交付？" danger onClose={() => !busy && setModal(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setModal(null)}>返回</Button><Button variant="danger" loading={busy} onClick={() => act(() => api.cancelDelivery({ name, requestId }), '后续尝试已取消。')}>取消交付</Button></>}><p>尚未开始的尝试会被阻止；已经发出的 HTTP 请求可能仍到达目标。</p><p className="muted">取消后，若这封邮件尚未开始普通保留计时、没有进行中的交付，且最后一次送达之后新建的其余未送达交付（从未送达时为全部其余交付）也都由你取消，它会按设置页的“已处理异常邮件保留天数”在最后一次处理后清理全部内容。已开始普通保留计时的邮件（此前已达到安全终态）不适用此规则，取消后在全部交付送达前不会自动清理。</p>{actionError && <p className="inline-error">{actionError}</p>}</Modal>}
    {modal === 'replay' && <Modal title="重新发送为新事件？" danger onClose={() => !busy && setModal(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setModal(null)}>取消</Button><Button variant="danger" loading={busy} disabled={!endpointId || !message.data?.etag} onClick={() => act(() => api.resendDelivery({ name, endpoint: endpointName(endpointId), messageEtag: message.data!.etag, requestId }), '已创建新的投递事件。', value => value.delivery ? `/deliveries/${encodeURIComponent(idOf(value.delivery.name))}` : null)}>创建新事件</Button></>}><p><strong>这可能再次触发目标服务的业务操作。</strong> 新事件会获得新的 ID，可选择不同目标；普通网络重试请选择“重试原事件”。</p><label className="field"><span>目标</span><select value={endpointId} onChange={event => setEndpointId(event.target.value)}>{endpoints.data?.map(endpoint => <option key={endpoint.name} value={idOf(endpoint.name)}>{endpoint.displayName} · {endpoint.uri}</option>)}</select></label>{actionError && <p className="inline-error">{actionError}</p>}</Modal>}
  </>
}
