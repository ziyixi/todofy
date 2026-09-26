import { useEffect, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Activity, ArrowRight, CircleAlert, Database, HardDrive, LockKeyhole, Mail, PauseCircle, Save, ShieldCheck } from 'lucide-react'
import { api } from '../api/client'
import type { RetentionPreview, Settings } from '../api/types'
import { Button, Card, CopyButton, ErrorState, formatBytes, formatDate, InfoRow, Loading, Modal, PageHead, SectionTitle } from '../components/UI'

export default function SettingsPage() {
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const endpoints = useQuery({ queryKey: ['endpoints'], queryFn: api.endpoints })
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview, staleTime: 300_000 })
  const [draft, setDraft] = useState<Pick<Settings, 'mode' | 'current_endpoint_id' | 'send_paused'>>({ mode: 'archive', current_endpoint_id: null, send_paused: false })
  const [retentionDraft, setRetentionDraft] = useState('')
  const [retentionPreview, setRetentionPreview] = useState<RetentionPreview | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => { if (settings.data) { setDraft({ mode: settings.data.mode, current_endpoint_id: settings.data.current_endpoint_id, send_paused: settings.data.send_paused }); setRetentionDraft(settings.data.retention_days == null ? '' : String(settings.data.retention_days)) } }, [settings.data?.version])
  const nextRetention = retentionDraft.trim() === '' ? null : Number(retentionDraft)
  async function save(confirmation?: string) {
    if (!settings.data) return
    setBusy(true); setError(''); setNotice('')
    try { await api.updateSettings({ version: settings.data.version, ...draft, ...(nextRetention !== settings.data.retention_days ? { retention_days: nextRetention } : {}), ...(confirmation ? { retention_confirmation: confirmation } : {}) }); await Promise.all([queryClient.invalidateQueries({ queryKey: ['settings'] }), queryClient.invalidateQueries({ queryKey: ['overview'] })]); setNotice('设置已保存。投递目标变更仅影响新邮件；内容保留将按确认的策略执行。'); setConfirmArchive(false); setRetentionPreview(null) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重试') }
    finally { setBusy(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!settings.data) return
    if (nextRetention !== null && (!Number.isInteger(nextRetention) || nextRetention < 1 || nextRetention > 3650)) { setError('保留天数应为 1–3650 的整数。'); return }
    if (nextRetention !== null && (settings.data.retention_days == null || nextRetention < settings.data.retention_days)) {
      setBusy(true); setError('')
      try { setRetentionPreview(await api.retentionPreview(nextRetention)) }
      catch (reason) { setError(reason instanceof Error ? reason.message : '无法预览保留期影响') }
      finally { setBusy(false) }
      return
    }
    if (draft.mode === 'archive' && settings.data.mode === 'forward' && (overview.data?.pending_count || 0) > 0) setConfirmArchive(true)
    else void save()
  }
  if (settings.isPending) return <Loading label="正在读取设置…"/>
  if (settings.isError) return <ErrorState error={settings.error} retry={() => settings.refetch()}/>
  const modified = draft.mode !== settings.data.mode || draft.current_endpoint_id !== settings.data.current_endpoint_id || draft.send_paused !== settings.data.send_paused || nextRetention !== settings.data.retention_days

  return <><PageHead eyebrow="WORKSPACE · SETTINGS" title="设置" description="一个收信地址，清楚区分收件模式、自动交付和已存在的队列。" action={<Link className="button button-secondary" to="/setup"><Activity size={16}/> 接入状态</Link>}/>
    {notice && <div className="success-banner" role="status">{notice}</div>}{error && <div className="inline-error" role="alert">{error}</div>}
    <div className="settings-grid"><div className="settings-main"><Card><SectionTitle title="收信地址" detail="这个地址由部署环境变量配置，日常无需新建地址。"/><div className="receive-address"><div className="receive-mark"><Mail size={21}/></div><code>{settings.data.receive_address || '未配置'}</code>{settings.data.receive_address && <CopyButton value={settings.data.receive_address} label="复制地址"/>}</div><div className="info-note"><ShieldCheck size={18}/><span>Gmail、Exchange 等来源可转发到同一个地址。更换地址需要调整部署配置，并在原邮箱更新转发规则。</span></div></Card>
      <Card><SectionTitle title="邮件处理" detail="默认仅收件；自动投递需先设置一个 webhook 目标。"/>{settings.data.effective_send_paused && !settings.data.send_paused && <div className="warning-banner"><CircleAlert size={16}/> 运维配置正在强制暂停投递，页面恢复开关无法覆盖它。</div>}<form id="settings-form" onSubmit={submit} className="settings-form"><div className="choice-stack"><label className={`choice-card ${draft.mode === 'archive' ? 'chosen' : ''}`}><input type="radio" name="mode" value="archive" checked={draft.mode === 'archive'} onChange={() => setDraft({ ...draft, mode: 'archive' })}/><span className="choice-icon"><Database size={20}/></span><span><strong>仅收件</strong><small>邮件会保存并显示在收件箱，不自动发往目标。已有队列仍按原计划处理。</small></span></label><label className={`choice-card ${draft.mode === 'forward' ? 'chosen' : ''}`}><input type="radio" name="mode" value="forward" checked={draft.mode === 'forward'} onChange={() => setDraft({ ...draft, mode: 'forward' })}/><span className="choice-icon"><ArrowRight size={20}/></span><span><strong>自动投递</strong><small>之后收到的新邮件会按当前目标创建投递事件；历史归档邮件不会自动补发。</small></span></label></div>
        <label className="field"><span>当前自动投递目标</span><select value={draft.current_endpoint_id || ''} onChange={event => setDraft({ ...draft, current_endpoint_id: event.target.value || null })}><option value="">未选择目标</option>{endpoints.data?.items.filter(endpoint => !endpoint.archived_at).map(endpoint => <option key={endpoint.id} value={endpoint.id}>{endpoint.label}</option>)}</select><small>更改目标只影响之后保存的新邮件，旧事件保持原目标版本。</small></label>
        {draft.mode === 'forward' && !draft.current_endpoint_id && <p className="inline-error"><CircleAlert size={16}/> 自动投递需要有效目标。<Link to="/endpoints">去配置</Link></p>}
        <label className="switch-line"><input type="checkbox" checked={draft.send_paused} onChange={event => setDraft({ ...draft, send_paused: event.target.checked })}/><span className="switch-visual"/><span><strong>暂停所有未开始的投递</strong><small>继续收信并记录待发送事件；恢复后按限流逐条发送。</small></span></label>
      </form></Card>
      <Card><SectionTitle title="内容保留" detail="缩短期限前先预览将清理的内容。"/><div className="retention-summary"><HardDrive size={21}/><div><strong>{settings.data.retention_days ? `当前：终态邮件保留 ${settings.data.retention_days} 天` : '当前：不自动删除邮件内容'}</strong><p>仅归档或所有交付已完成的终态邮件进入自动清理。待解析、失败和未完成交付不会自动清理。</p></div></div><div className="retention-input-row"><label className="field"><span>新的保留天数</span><input form="settings-form" type="number" min="1" max="3650" step="1" value={retentionDraft} onChange={event => setRetentionDraft(event.target.value)} placeholder="留空表示不自动清理"/><small>1–3650 天；留空表示不自动清理。降低期限时需确认预览。</small></label><Button variant="quiet" type="button" onClick={() => setRetentionDraft('')}>不自动清理</Button></div><progress className="storage-progress" aria-label="逻辑内容容量" value={overview.data?.storage_bytes || 0} max={overview.data?.capacity_bytes || 10 * 1024 ** 3}/><div className="storage-caption"><span>已用 {formatBytes(overview.data?.storage_bytes)}</span><span>上限 {formatBytes(overview.data?.capacity_bytes || settings.data.capacity_bytes)}</span></div><div className="settings-save"><span>{modified ? '有尚未保存的更改' : '设置已保存'}</span><Button type="submit" form="settings-form" loading={busy} disabled={!modified || (draft.mode === 'forward' && !draft.current_endpoint_id)}><Save size={16}/> 保存设置</Button></div></Card>
    </div><aside className="settings-side"><Card><SectionTitle title="运行状态"/><dl className="side-facts"><InfoRow label="投递模式">{settings.data.mode === 'forward' ? '自动投递' : '仅收件'}</InfoRow><InfoRow label="队列">{overview.data?.pending_count ?? '—'} 条等待</InfoRow><InfoRow label="需要处理">{overview.data?.failed_count ?? '—'} 条</InfoRow><InfoRow label="最近备份">{formatDate(overview.data?.last_backup_at)}</InfoRow></dl><Link to="/deliveries" className="text-link">查看投递记录 <ArrowRight size={15}/></Link></Card><Card><SectionTitle title="访问与隐私"/><div className="privacy-list"><p><LockKeyhole size={17}/> 管理界面需要通过你的 Access 身份访问。</p><p><ShieldCheck size={17}/> 页面不加载外部字体、统计脚本或邮件远程图片。</p><p><PauseCircle size={17}/> 暂停投递不影响收件。</p></div></Card></aside></div>
    {confirmArchive && <Modal title="切换为仅收件？" onClose={() => !busy && setConfirmArchive(false)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setConfirmArchive(false)}>返回</Button><Button loading={busy} onClick={() => save()}>保留已有队列并保存</Button></>}><p>仍有 <strong>{overview.data?.pending_count}</strong> 条既有投递等待处理。切换模式只影响之后的新邮件；已有投递仍会尝试。</p><label className="switch-line"><input type="checkbox" checked={draft.send_paused} onChange={event => setDraft({ ...draft, send_paused: event.target.checked })}/><span className="switch-visual"/><span><strong>同时暂停既有投递</strong><small>队列会保留，直到你恢复发送。</small></span></label>{error && <p className="inline-error">{error}</p>}</Modal>}
    {retentionPreview && <Modal title={`确认保留 ${retentionPreview.days} 天？`} danger onClose={() => !busy && setRetentionPreview(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setRetentionPreview(null)}>返回设置</Button><Button variant="danger" loading={busy} onClick={() => save(retentionPreview.preview_token)}>确认并保存</Button></>}><p>当前符合清理条件的邮件 <strong>{Array.isArray(retentionPreview.candidates) ? retentionPreview.candidates.length : retentionPreview.candidates}</strong> 封，预计可清理内容 <strong>{formatBytes(retentionPreview.bytes_to_clear)}</strong>。仅归档或交付全部完成的终态邮件符合条件。</p><p>预览有效期至 {formatDate(retentionPreview.expires_at)}；预览数字可能随邮件状态变化；保存后，新达到期限的终态邮件也会按策略清理。</p>{draft.mode === 'archive' && settings.data.mode === 'forward' && (overview.data?.pending_count || 0) > 0 && <p>切换仅收件后，现有 {overview.data?.pending_count} 条交付仍按原计划处理。可先在上方打开全局暂停。</p>}{error && <p className="inline-error">{error}</p>}</Modal>}
  </>
}
