import { useEffect, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Activity, ArrowRight, CheckCircle2, CirclePause, EyeOff, KeyRound, LockKeyhole, LockOpen, Plus, Send, ShieldCheck, Webhook } from 'lucide-react'
import { actionId, api, ApiError } from '../api/client'
import type { Endpoint } from '../api/types'
import { Button, Card, Empty, ErrorState, formatDate, Loading, Modal, PageHead, SectionTitle } from '../components/UI'

function blockedReasonText(code: string): string {
  if (code === 'http_404') return '目标返回 404（路径不存在）'
  if (code === 'http_405') return '目标返回 405（方法不被允许）'
  if (/^http_3\d\d$/.test(code)) return '目标返回重定向'
  if (code === 'http_401' || code === 'http_403') return '认证被拒绝，请轮换凭据后解除'
  if (code === 'credential_or_target_invalid') return '凭据或目标地址无效'
  return code
}
// Mirrors the Worker: route-class blocks get at most 8 six-hour rechecks, then stay until the owner unblocks.
const ROUTE_BLOCK_MAX_RECHECKS = 8
function isRouteBlock(code: string): boolean { return code === 'http_404' || code === 'http_405' || /^http_3\d\d$/.test(code) }
function recheckText(endpoint: Endpoint): string {
  const armed = endpoint.blocked_rechecks
  if (typeof armed !== 'number' || !endpoint.blocked_reason || !isRouteBlock(endpoint.blocked_reason)) return ''
  if (!endpoint.blocked_until) return armed >= ROUTE_BLOCK_MAX_RECHECKS ? `自动复查已用完（${ROUTE_BLOCK_MAX_RECHECKS} 次，约 2 天），请核查目标后手动解除阻断。` : ''
  // The Worker counts a recheck when it arms the cooldown, so the scheduled one
  // is included; zero means a cooldown set without counting (an older block).
  const next = Math.min(armed, ROUTE_BLOCK_MAX_RECHECKS)
  if (next < 1) return `自动复查已用 0/${ROUTE_BLOCK_MAX_RECHECKS} 次；这次复查不计入上限。`
  return `自动复查已用 ${next - 1}/${ROUTE_BLOCK_MAX_RECHECKS} 次，${next >= ROUTE_BLOCK_MAX_RECHECKS ? '下一次是最后一次；仍返回同类错误时将保持阻断，直到你手动解除。' : `下一次是第 ${next} 次。`}`
}
// The Worker writes retry_after_over_24h; retry_after_too_long is an older spelling.
function pausedReasonText(reason: string): string {
  return reason === 'retry_after_over_24h' || reason === 'retry_after_too_long' ? '接收方要求等待超过 24 小时；请核查后手动恢复。' : reason
}

interface EndpointDraft { label: string; url: string; auth_type: 'bearer' | 'basic'; credential: string; rate_per_minute: string; timeout_seconds: string }
const blank: EndpointDraft = { label: '', url: '', auth_type: 'bearer', credential: '', rate_per_minute: '2', timeout_seconds: '20' }

export default function EndpointsPage() {
  const queryClient = useQueryClient()
  const endpoints = useQuery({ queryKey: ['endpoints'], queryFn: api.endpoints })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview, staleTime: 300_000 })
  const [selectedId, setSelectedId] = useState('')
  const [modal, setModal] = useState<'create' | 'edit' | 'rotate' | 'check' | 'test' | null>(null)
  const [draft, setDraft] = useState<EndpointDraft>(blank)
  const [requestId, setRequestId] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [unblocked, setUnblocked] = useState<{ id: string; at: number } | null>(null)
  const items = endpoints.data?.items || []
  const selected = items.find(item => item.id === selectedId) || items[0]
  let needsNewCredential = false
  if (modal === 'edit' && selected) {
    try { needsNewCredential = new URL(draft.url).origin !== new URL(selected.url).origin || draft.auth_type !== selected.auth_type } catch { /* Invalid URL is reported by the field. */ }
  }
  useEffect(() => { if (!selectedId && items.length) setSelectedId(items[0].id) }, [items, selectedId])
  function open(kind: typeof modal, endpoint?: Endpoint) {
    setActionError(''); setNotice(''); setRequestId(actionId())
    setDraft(endpoint ? { label: endpoint.label, url: endpoint.url, auth_type: endpoint.auth_type === 'basic' ? 'basic' : 'bearer', credential: '', rate_per_minute: String(endpoint.rate_per_minute || 2), timeout_seconds: String(endpoint.timeout_seconds || 20) } : blank)
    if (endpoint) setSelectedId(endpoint.id)
    setModal(kind)
  }
  async function perform(work: () => Promise<unknown>, success: string | ((value: unknown) => string)) {
    setBusy(true); setActionError('')
    try { const result = await work(); setModal(null); setNotice(typeof success === 'function' ? success(result) : success); await Promise.all([queryClient.invalidateQueries({ queryKey: ['endpoints'] }), queryClient.invalidateQueries({ queryKey: ['settings'] }), queryClient.invalidateQueries({ queryKey: ['overview'] })]) }
    catch (error) {
      setActionError(error instanceof Error ? error.message : '操作失败，请重试')
      // The Worker bumps the version itself (e.g. a Retry-After pause); reload it so a retry is not another 409.
      if (error instanceof ApiError && error.status === 409) await queryClient.invalidateQueries({ queryKey: ['endpoints'] })
    }
    finally { setBusy(false) }
  }
  function submitForm(event: FormEvent) {
    event.preventDefault()
    const body = { label: draft.label.trim(), url: draft.url.trim(), auth_type: draft.auth_type, rate_per_minute: Number(draft.rate_per_minute), timeout_seconds: Number(draft.timeout_seconds) }
    if (modal === 'create') perform(() => api.createEndpoint({ ...body, credential: draft.credential, action_request_id: requestId }), '目标已创建。')
    else if (selected) perform(() => api.updateEndpoint(selected.id, { ...body, version: selected.version, ...(draft.credential ? { credential: draft.credential } : {}) }), '目标已更新。新 URL 只影响之后的邮件。')
  }
  async function setPaused(endpoint: Endpoint, paused: boolean) { await perform(() => api.updateEndpoint(endpoint.id, { paused, version: endpoint.version }), paused ? '目标已暂停；收信仍继续。' : '目标已恢复。') }
  async function unblock(endpoint: Endpoint) {
    const at = Date.now()
    await perform(() => api.unblockEndpoint(endpoint.id, { version: endpoint.version }), value => {
      setUnblocked({ id: endpoint.id, at })
      const affected = (value as { affected_revisions: number }).affected_revisions
      return affected > 0 ? `已解除此目标 ${affected} 个版本的阻断，自动复查次数已重新计数。等待中的事件现在会重试；创建超过 7 天的事件已过自动重试窗口，需在投递记录中手动重试。目标仍有问题时会再次阻断。顶部提醒会在下次后台检查（约 10 分钟内）后更新。`
        : '此目标没有被阻断的版本。提醒中的阻断可能属于其他或已归档的目标，也可能已在上次后台检查后解除；请在投递记录中查看。'
    })
  }
  // The alert also counts blocked revisions of other and archived endpoints, so
  // it cannot say which endpoint owns the block. /overview serves the stored
  // alert, refreshed about every 10 minutes: hide it here after an unblock of
  // this endpoint until a later check still reports it.
  const blockedAlert = overview.data?.alerts?.active.find(alert => alert.code === 'endpoint_blocked')
  const clearedHere = !!blockedAlert && !!unblocked && unblocked.id === selected?.id && !(Date.parse(blockedAlert.last_seen_at || '') >= unblocked.at)
  const olderRevisionBlocked = !!selected && !selected.blocked_reason && !!blockedAlert && !blockedAlert.metrics.current_blocked && !clearedHere
  // The Worker keeps an expired cooldown block until the next delivery rechecks the target.
  const cooled = !!selected?.blocked_reason && !!selected.blocked_until && Date.parse(selected.blocked_until) <= Date.now()

  return <><PageHead eyebrow="WEBHOOK · 交付目标" title="Webhook 目标" description="邮件会按保存时选定的目标版本发送。编辑 URL 不会悄悄改送历史事件。" action={<Button onClick={() => open('create')}><Plus size={16}/> 新建目标</Button>}/>
    {notice && <div className="success-banner" role="status">{notice}</div>}{actionError && !modal && <div className="inline-error" role="alert">{actionError}</div>}
    {endpoints.isPending ? <Loading label="正在读取目标…"/> : endpoints.isError ? <ErrorState error={endpoints.error} retry={() => endpoints.refetch()}/> : items.length === 0 ? <Card><Empty icon={<Webhook size={27}/>} title="还没有 webhook 目标" detail="先创建一个通用目标，再到设置中开启自动投递。收信箱现在就可以独立使用。" action={<Button onClick={() => open('create')}><Plus size={16}/> 创建第一个目标</Button>}/></Card> : <div className="endpoint-grid"><div className="endpoint-list">{items.map(endpoint => <button key={endpoint.id} className={`endpoint-list-item ${selected?.id === endpoint.id ? 'active' : ''}`} onClick={() => setSelectedId(endpoint.id)}><span className="endpoint-list-icon"><Webhook size={19}/></span><span><strong>{endpoint.label}</strong><small>{endpoint.url}</small></span>{settings.data?.current_endpoint_id === endpoint.id && <span className="active-target-mark">当前</span>}</button>)}</div>
      {selected && <div className="endpoint-detail"><Card><div className="endpoint-detail-head"><div className="endpoint-emblem"><Webhook size={23}/></div><div><span className="eyebrow">WEBHOOK ENDPOINT</span><h2>{selected.label}</h2><p>{selected.url}</p></div><span className={`endpoint-state ${selected.paused || cooled ? 'paused' : selected.blocked_reason ? 'blocked' : 'running'}`}>{selected.paused ? '已暂停' : cooled ? '待复查' : selected.blocked_reason ? '已阻断' : '可用'}</span></div>
        <div className="endpoint-facts"><div><span>认证方式</span><strong><LockKeyhole size={15}/>{selected.auth_type === 'none' ? '无认证' : selected.auth_type === 'basic' ? 'Basic' : 'Bearer'}</strong></div><div><span>凭据</span><strong>{selected.credential_configured ? '已设置 · 不回显' : '未设置'}</strong></div><div><span>交付频率</span><strong>{selected.rate_per_minute || 2} 次 / 分钟</strong></div><div><span>请求超时</span><strong>{selected.timeout_seconds || 20} 秒</strong></div></div>
        {selected.paused_reason && <div className="inline-error">此目标已暂停：{pausedReasonText(selected.paused_reason)}</div>}
        {selected.blocked_reason && <div className={`${cooled ? 'warning-banner' : 'inline-error'} endpoint-notice`}><span>{cooled ? `当前目标版本曾被阻断：${blockedReasonText(selected.blocked_reason)}。冷却已结束，下一次投递时会自动复查。` : `当前目标版本已阻断：${blockedReasonText(selected.blocked_reason)}。${selected.blocked_until ? `将于 ${formatDate(selected.blocked_until)} 自动重试。` : '自动投递已停止。'}`}{recheckText(selected)}</span><Button variant="secondary" loading={busy} onClick={() => unblock(selected)}><LockOpen size={16}/> 解除阻断</Button></div>}
        {olderRevisionBlocked && <div className="inline-error endpoint-notice"><span>有等待中的投递停在已阻断的目标版本上，而此目标的当前版本未阻断；无法从这里确定它们属于此目标的旧版本、其他目标还是已归档目标。解除阻断只清除此目标所有版本的阻断，结果会显示实际解除的版本数。</span><Button variant="secondary" loading={busy} onClick={() => unblock(selected)}><LockOpen size={16}/> 解除阻断</Button></div>}
        <div className="endpoint-action-bar"><Button onClick={() => open('edit', selected)}>编辑目标</Button><Button variant="secondary" onClick={() => open('rotate', selected)}><KeyRound size={16}/> 轮换凭据</Button><Button variant="secondary" loading={busy} onClick={() => setPaused(selected, !selected.paused)}>{selected.paused ? <><CheckCircle2 size={16}/> 恢复</> : <><CirclePause size={16}/> 暂停</>}</Button></div>
      </Card><Card><SectionTitle title="诊断与测试" detail="连接检查不会请求业务接口；测试事件会真正发往目标。"/><div className="diagnostic-actions"><button onClick={() => open('check', selected)}><Activity size={18}/><span><strong>检查连接</strong><small>检查 URL 与允许的目标域名</small></span><ArrowRight size={16}/></button><button onClick={() => open('test', selected)}><Send size={18}/><span><strong>发送测试事件</strong><small>合成邮件，会真实调用消费者</small></span><ArrowRight size={16}/></button></div></Card><Card><SectionTitle title="配置范围"/><div className="fact-callout"><ShieldCheck size={19}/><p>更改目标 URL 会创建新版本。已有交付继续使用它们保存时的目标；凭据轮换可明确选择影响范围。</p></div><Link to="/deliveries" className="text-link">查看投递记录 <ArrowRight size={15}/></Link></Card></div>}
    </div>}
    {(modal === 'create' || modal === 'edit') && <Modal title={modal === 'create' ? '新建 webhook 目标' : `编辑 ${selected?.label}`} onClose={() => !busy && setModal(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setModal(null)}>取消</Button><Button type="submit" form="endpoint-form" loading={busy}>{modal === 'create' ? '创建目标' : '保存更改'}</Button></>}><form id="endpoint-form" onSubmit={submitForm} className="form-stack"><label className="field"><span>显示名称</span><input required maxLength={80} value={draft.label} onChange={event => setDraft({ ...draft, label: event.target.value })} placeholder="例如：Todofy"/></label><label className="field"><span>目标 URL（公网 HTTPS）</span><input required type="url" value={draft.url} onChange={event => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/hooks/mail"/><small>目标域名必须在部署时明确允许；不支持私网 HTTP 地址。</small></label><div className="form-two"><label className="field"><span>认证方式</span><select value={draft.auth_type} onChange={event => setDraft({ ...draft, auth_type: event.target.value as EndpointDraft['auth_type'] })}><option value="bearer">Bearer token</option><option value="basic">Basic</option></select></label><label className="field"><span>每分钟最多</span><input required type="number" min="1" max="60" value={draft.rate_per_minute} onChange={event => setDraft({ ...draft, rate_per_minute: event.target.value })}/></label></div>{(modal === 'create' || needsNewCredential) && <label className="field"><span>{draft.auth_type === 'basic' ? 'Basic 凭据（username:password）' : 'Bearer token'}</span><input required type="password" autoComplete="new-password" value={draft.credential} onChange={event => setDraft({ ...draft, credential: event.target.value })}/><small>{needsNewCredential ? '目标 origin 或认证方式已变化，必须重新输入凭据；旧版本仍保留原凭据。' : '保存后不会回显。请在正规服务配置流程中取得密钥。'}</small></label>}<label className="field"><span>HTTP 超时（秒）</span><input required type="number" min="1" max="120" value={draft.timeout_seconds} onChange={event => setDraft({ ...draft, timeout_seconds: event.target.value })}/></label>{modal === 'edit' && <p className="fact-callout">更改 URL 只作用于之后的新事件；旧交付仍指向原版本。</p>}{actionError && <p className="inline-error">{actionError}</p>}</form></Modal>}
    {modal === 'rotate' && selected && <Modal title="轮换目标凭据" onClose={() => !busy && setModal(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setModal(null)}>取消</Button><Button loading={busy} disabled={!draft.credential} onClick={() => perform(() => api.rotateCredential(selected.id, { credential: draft.credential, version: selected.version }), '凭据已轮换。')}>更新凭据</Button></>}><p>相同 origin 的历史版本会使用新凭据；事件 ID 和请求正文保持不变。</p><label className="field"><span>新凭据</span><input type="password" autoComplete="new-password" value={draft.credential} onChange={event => setDraft({ ...draft, credential: event.target.value })}/></label><p className="muted small"><EyeOff size={14}/> 现有凭据不会回显。</p>{actionError && <p className="inline-error">{actionError}</p>}</Modal>}
    {modal === 'check' && selected && <Modal title="检查连接" onClose={() => !busy && setModal(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setModal(null)}>关闭</Button><Button loading={busy} onClick={() => perform(() => api.checkEndpoint(selected.id), value => { const check = value as { url_valid: boolean; dns_status: string; tls_status: string }; return `检查完成：URL ${check.url_valid ? '符合策略' : '被阻止'}，DNS ${check.dns_status === 'resolved' ? '已解析' : check.dns_status === 'not_checked' ? '未检查' : '失败或被阻止'}；TLS 与业务接收协议仍未验证。` })}>开始检查</Button></>}><p>只检查 URL 格式和允许的目标域名，不验证 DNS、TLS 或业务接收协议。不会向业务 URL 发送 POST。</p>{actionError && <p className="inline-error">{actionError}</p>}</Modal>}
    {modal === 'test' && selected && <Modal title="发送合成测试事件？" danger onClose={() => !busy && setModal(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setModal(null)}>取消</Button><Button variant="danger" loading={busy} onClick={() => perform(() => api.testEndpoint(selected.id, requestId), value => `测试事件已创建：${(value as { event_id: string }).event_id}。请到投递记录确认结果。`)}>确认发送</Button></>}><p>这会向 <strong>{selected.label}</strong> 真实发送一条合成邮件事件。接收方可能据此执行真实业务；请先确认目标允许测试。</p>{actionError && <p className="inline-error">{actionError}</p>}</Modal>}
  </>
}
