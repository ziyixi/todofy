import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router'
import { AlertCircle, ArrowLeft, ArrowRight, Ban, Clock3, RefreshCw, Repeat2, Send } from 'lucide-react'
import { actionId, api } from '../api/client'
import { Button, Card, CopyButton, ErrorState, formatDate, InfoRow, Loading, Modal, PageHead, SectionTitle, Status } from '../components/UI'

export default function DeliveryPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const result = useQuery({ queryKey: ['delivery', id], queryFn: () => api.delivery(id), enabled: !!id })
  const endpoints = useQuery({ queryKey: ['endpoints'], queryFn: api.endpoints })
  const message = useQuery({ queryKey: ['message', result.data?.delivery.message_id], queryFn: () => api.message(result.data!.delivery.message_id), enabled: !!result.data?.delivery.message_id })
  const [modal, setModal] = useState<'retry' | 'cancel' | 'replay' | null>(null)
  const [requestId, setRequestId] = useState('')
  const [endpointId, setEndpointId] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  function open(kind: 'retry' | 'cancel' | 'replay') { setRequestId(actionId()); setEndpointId(result.data?.delivery.endpoint_id || endpoints.data?.items[0]?.id || ''); setActionError(''); setModal(kind) }
  async function act(work: () => Promise<unknown>, success: string) {
    setBusy(true); setActionError(''); setNotice('')
    try { const value = await work(); setModal(null); setNotice(success); await Promise.all([queryClient.invalidateQueries({ queryKey: ['delivery', id] }), queryClient.invalidateQueries({ queryKey: ['deliveries'] }), queryClient.invalidateQueries({ queryKey: ['message'] }), queryClient.invalidateQueries({ queryKey: ['overview'] })]); if (modal === 'replay' && value && typeof value === 'object' && 'event_id' in value) navigate(`/deliveries/${(value as { event_id: string }).event_id}`) }
    catch (error) { setActionError(error instanceof Error ? error.message : '操作失败，请重试') }
    finally { setBusy(false) }
  }
  if (result.isPending) return <Loading label="正在读取投递详情…"/>
  if (result.isError) return <ErrorState error={result.error} retry={() => result.refetch()}/>
  const { delivery, attempts } = result.data
  const mutable = ['pending', 'retry_wait', 'failed', 'sending'].includes(delivery.state)
  const canRetry = ['failed', 'retry_wait'].includes(delivery.state)
  const canReplay = !!message.data?.message && !message.data.message.content_deleted_at && message.data.message.parse_state === 'ready'

  return <><div className="back-line"><Link to="/deliveries"><ArrowLeft size={16}/> 返回投递记录</Link><span>事件 / {id.slice(0, 8)}</span></div>
    <PageHead eyebrow="WEBHOOK · 事件详情" title="投递详情" description="同一事件重试始终使用相同的请求内容与事件 ID。" action={<div className="head-actions">{canRetry && <Button onClick={() => open('retry')}><RefreshCw size={16}/> 重试原事件</Button>}{mutable && <Button variant="secondary" onClick={() => open('cancel')}><Ban size={16}/> 取消交付</Button>}</div>}/>
    {notice && <div className="success-banner" role="status">{notice}</div>}{actionError && <div className="inline-error" role="alert">{actionError}</div>}
    <div className="detail-grid"><div className="detail-main">
      <Card><div className="delivery-hero"><div><span className="eyebrow">当前状态</span><h2><Status state={delivery.paused ? 'paused' : delivery.state}/></h2><p>{delivery.state === 'delivered' ? '消费者已持久接管此事件。后续业务结果请在消费者服务查看。' : delivery.last_error || 'Mail Hero 将按当前状态处理此事件。'}</p></div><div className="delivery-count"><strong>{delivery.attempt_count}</strong><span>次尝试</span></div></div><dl className="info-grid"><InfoRow label="事件 ID"><code>{delivery.event_id}</code><CopyButton value={delivery.event_id}/></InfoRow><InfoRow label="目标">{delivery.endpoint_label || delivery.endpoint_id || '—'}</InfoRow><InfoRow label="创建时间">{formatDate(delivery.created_at)}</InfoRow><InfoRow label="下次尝试">{formatDate(delivery.next_attempt_at)}</InfoRow><InfoRow label="完成时间">{formatDate(delivery.delivered_at)}</InfoRow>{delivery.replay_of_event_id && <InfoRow label="重发自"><Link to={`/deliveries/${encodeURIComponent(delivery.replay_of_event_id)}`}>{delivery.replay_of_event_id.slice(0, 8)}…</Link></InfoRow>}</dl></Card>
      <Card><SectionTitle title="尝试时间线" detail="连接失败、HTTP 响应与重试安排都会留下记录。"/>{attempts?.length ? <div className="attempt-list">{attempts.map((attempt, index) => <div className="attempt-item" key={attempt.id || index}><div className={`attempt-icon ${attempt.http_status && attempt.http_status >= 200 && attempt.http_status < 300 ? 'attempt-ok' : ''}`}>{attempt.http_status && attempt.http_status >= 200 && attempt.http_status < 300 ? <Send size={17}/> : <AlertCircle size={17}/>}</div><div><div className="attempt-line"><strong>第 {attempt.attempt_no || index + 1} 次尝试</strong><time>{formatDate(attempt.started_at)}</time></div><div className="attempt-meta"><span>{attempt.http_status ? `HTTP ${attempt.http_status}` : attempt.outcome || '未收到响应'}</span>{attempt.duration_ms != null && <span>{attempt.duration_ms} ms</span>}{attempt.error_code && <span>{attempt.error_code}</span>}</div>{attempt.response_preview && <pre className="response-preview">{attempt.response_preview}</pre>}</div></div>)}</div> : <div className="mini-empty"><Clock3 size={20}/><p>尚无尝试记录。</p></div>}</Card>
      <Card><SectionTitle title="冻结请求" detail="普通重试会发送相同的 JSON，不会使用最新的邮件正文。"/>{delivery.payload ? <pre className="json-preview">{JSON.stringify(delivery.payload, null, 2)}</pre> : <p className="muted">请求内容不可用，可能已随邮件删除。</p>}</Card>
    </div><aside className="detail-side"><Card><SectionTitle title="相关邮件"/>{message.data?.message ? <><strong className="related-subject">{message.data.message.subject || '（无主题）'}</strong><p className="muted">{message.data.message.from || '未知发件人'}</p><Link to={`/messages/${encodeURIComponent(delivery.message_id)}`} className="text-link">打开邮件 <ArrowRight size={15}/></Link></> : <p className="muted">邮件详情加载中或已不可用。</p>}</Card><Card><SectionTitle title="其他操作"/><div className="action-list"><button disabled={!canReplay} onClick={() => open('replay')}><Repeat2 size={17}/> 重新发送为新事件 <ArrowRight size={15}/></button>{!canReplay && <p className="muted small">需要仍保留的可解析邮件正文。</p>}{canRetry && <button onClick={() => open('retry')}><RefreshCw size={17}/> 重试原事件 <ArrowRight size={15}/></button>}</div><p className="subtle-note">新事件可能再次触发消费者业务。已交付事件不能用普通重试重复执行。</p></Card></aside></div>
    {modal === 'retry' && <Modal title="重试原事件" onClose={() => !busy && setModal(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setModal(null)}>取消</Button><Button loading={busy} onClick={() => act(() => api.retryDelivery(id, requestId), '已安排一次受限重试。')}>确认重试</Button></>}><p>保留事件 ID、请求正文和目标版本；仍遵守限流与重放期限。</p>{actionError && <p className="inline-error">{actionError}</p>}</Modal>}
    {modal === 'cancel' && <Modal title="取消未完成的交付？" danger onClose={() => !busy && setModal(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setModal(null)}>返回</Button><Button variant="danger" loading={busy} onClick={() => act(() => api.cancelDelivery(id, requestId), '后续尝试已取消。')}>取消交付</Button></>}><p>尚未开始的尝试会被阻止；已经发出的 HTTP 请求可能仍到达目标。</p>{actionError && <p className="inline-error">{actionError}</p>}</Modal>}
    {modal === 'replay' && <Modal title="重新发送为新事件？" danger onClose={() => !busy && setModal(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setModal(null)}>取消</Button><Button variant="danger" loading={busy} disabled={!endpointId || !message.data?.message.version} onClick={() => act(() => api.replayDelivery(id, endpointId, message.data!.message.version, requestId), '已创建新的投递事件。')}>创建新事件</Button></>}><p><strong>这可能再次触发目标服务的业务操作。</strong> 新事件会获得新的 ID，可选择不同目标；普通网络重试请选择“重试原事件”。</p><label className="field"><span>目标</span><select value={endpointId} onChange={event => setEndpointId(event.target.value)}>{endpoints.data?.items.filter(endpoint => !endpoint.archived_at).map(endpoint => <option key={endpoint.id} value={endpoint.id}>{endpoint.label} · {endpoint.url}</option>)}</select></label>{actionError && <p className="inline-error">{actionError}</p>}</Modal>}
  </>
}
