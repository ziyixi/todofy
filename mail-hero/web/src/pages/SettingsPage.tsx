import { useEffect, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Activity, ArrowRight, CircleAlert, Database, HardDrive, LockKeyhole, Mail, PauseCircle, Save, ShieldCheck } from 'lucide-react'
import type { PreviewRetentionPolicyResponse } from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import { ReceiveMode } from '@ziyixi/proto/mailhero/ui/v2/message_pb'
import { api, timeOf } from '../api/client'
import { endpointsQuery, overviewQuery, settingsQuery } from '../api/queries'
import { alertLabel, isEndpointAlert } from '../components/alerts'
import { Button, Card, CopyButton, ErrorState, formatBytes, formatDate, InfoRow, Loading, Modal, PageHead, SectionTitle } from '../components/UI'

/** The settings form: the mode, the current target's resource name ('' for none) and the owner's pause. */
interface Draft { mode: 'archive' | 'forward'; current_endpoint: string; send_paused: boolean }

export default function SettingsPage() {
  const queryClient = useQueryClient()
  const settings = useQuery(settingsQuery)
  const endpoints = useQuery(endpointsQuery)
  const overview = useQuery(overviewQuery)
  const [draft, setDraft] = useState<Draft>({ mode: 'archive', current_endpoint: '', send_paused: false })
  const [rawDays, setRawDays] = useState('7')
  const [contentDays, setContentDays] = useState('30')
  const [resolvedDays, setResolvedDays] = useState('60')
  const [applyExisting, setApplyExisting] = useState(false)
  const [retentionPreview, setRetentionPreview] = useState<PreviewRetentionPolicyResponse | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const savedMode: Draft['mode'] = settings.data?.mode === ReceiveMode.FORWARD ? 'forward' : 'archive'
  useEffect(() => { if (settings.data) { setDraft({ mode: savedMode, current_endpoint: settings.data.currentEndpoint, send_paused: settings.data.sendPaused }); setRawDays(settings.data.rawRetentionDays == null ? '' : String(settings.data.rawRetentionDays)); setContentDays(settings.data.contentRetentionDays == null ? '' : String(settings.data.contentRetentionDays)); setResolvedDays(settings.data.resolvedRetentionDays == null ? '' : String(settings.data.resolvedRetentionDays)) } }, [settings.data?.etag])
  const nextRaw = rawDays.trim() === '' ? null : Number(rawDays)
  const nextContent = contentDays.trim() === '' ? null : Number(contentDays)
  const nextResolved = resolvedDays.trim() === '' ? null : Number(resolvedDays)
  // Global, not frozen per message: it also re-times owner-resolved exceptions already stored.
  const savedResolved = settings.data?.resolvedRetentionDays ?? null
  const ledgerDays = settings.data?.ledgerRetentionDays ?? 180
  const policyChanged = nextRaw !== (settings.data?.rawRetentionDays ?? null) || nextContent !== (settings.data?.contentRetentionDays ?? null) || nextResolved !== savedResolved || applyExisting
  /** The form's whole retention policy (a period kept forever is unset): what a preview confirms and a save stores. */
  const policy = { rawRetentionDays: nextRaw ?? undefined, contentRetentionDays: nextContent ?? undefined, ledgerRetentionDays: ledgerDays, resolvedRetentionDays: nextResolved ?? undefined }
  async function save(confirmation?: string) {
    if (!settings.data) return
    setBusy(true); setError(''); setNotice('')
    // Only the fields that changed (AIP-134), so another tab's change to another field stays, and the whole policy
    // when it changed: what its preview's confirmation binds.
    const paths = [
      ...(draft.mode !== savedMode ? ['mode'] : []), ...(draft.current_endpoint !== settings.data.currentEndpoint ? ['current_endpoint'] : []),
      ...(draft.send_paused !== settings.data.sendPaused ? ['send_paused'] : []),
      ...(policyChanged ? ['raw_retention_days', 'content_retention_days', 'ledger_retention_days', 'resolved_retention_days'] : []), 'etag',
    ]
    try {
      await api.updateSettings({
        settings: { name: 'settings', etag: settings.data.etag, mode: draft.mode === 'forward' ? ReceiveMode.FORWARD : ReceiveMode.ARCHIVE, currentEndpoint: draft.current_endpoint, sendPaused: draft.send_paused, ...policy },
        updateMask: { paths }, retentionConfirmation: confirmation ?? '', applyExisting,
      })
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['settings'] }), queryClient.invalidateQueries({ queryKey: ['overview'] })]); setNotice('设置已保存。原件与正文期限用于新邮件，已设策略的邮件保持原快照；已处理异常邮件的保留期不按邮件冻结，对它们统一生效。历史邮件仅在明确选择并确认后纳入保留。'); setApplyExisting(false); setConfirmArchive(false); setRetentionPreview(null)
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重试') }
    finally { setBusy(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!settings.data) return
    if ([nextRaw, nextContent, nextResolved].some(value => value !== null && (!Number.isInteger(value) || value < 1 || value > 3650))) { setError('保留天数应为 1–3650 的整数。'); return }
    if (nextRaw !== null && nextContent !== null && nextRaw > nextContent) { setError('原件保留期不能长于正文保留期。'); return }
    // Mirrors the Worker: content kept forever keeps resolved exceptions forever too.
    if (nextResolved !== null && nextContent === null) { setError('正文不自动清理时，已处理异常邮件保留天数也须留空。'); return }
    if (nextResolved !== null && nextContent !== null && nextResolved < nextContent) { setError('已处理异常邮件的保留期不能短于正文保留期。'); return }
    if (policyChanged) {
      setBusy(true); setError('')
      try { setRetentionPreview(await api.previewRetentionPolicy({ name: 'settings', ...policy, applyExisting })) }
      catch (reason) { setError(reason instanceof Error ? reason.message : '无法预览保留期影响') }
      finally { setBusy(false) }
      return
    }
    if (draft.mode === 'archive' && savedMode === 'forward' && (overview.data?.pendingDeliveryCount || 0) > 0) setConfirmArchive(true)
    else void save()
  }
  if (settings.isPending) return <Loading label="正在读取设置…"/>
  if (settings.isError) return <ErrorState error={settings.error} retry={() => settings.refetch()}/>
  const modified = draft.mode !== savedMode || draft.current_endpoint !== settings.data.currentEndpoint || draft.send_paused !== settings.data.sendPaused || policyChanged
  const capacityUsed = overview.data?.scheduler?.capacityUsedBytes, capacityReserved = overview.data?.scheduler?.capacityReservedBytes

  return <><PageHead eyebrow="WORKSPACE · SETTINGS" title="设置" description="一个收信地址，清楚区分收件模式、自动交付和已存在的队列。" action={<Link className="button button-secondary" to="/setup"><Activity size={16}/> 接入状态</Link>}/>
    {notice && <div className="success-banner" role="status">{notice}</div>}{error && <div className="inline-error" role="alert">{error}</div>}
    <div className="settings-grid"><div className="settings-main"><Card><SectionTitle title="收信地址" detail="这个地址由部署环境变量配置，日常无需新建地址。"/><div className="receive-address"><div className="receive-mark"><Mail size={21}/></div><code>{settings.data.receiveAddress || '未配置'}</code>{settings.data.receiveAddress && <CopyButton value={settings.data.receiveAddress} label="复制地址"/>}</div><div className="info-note"><ShieldCheck size={18}/><span>Gmail、Exchange 等来源可转发到同一个地址。更换地址需要调整部署配置，并在原邮箱更新转发规则。</span></div></Card>
      <Card><SectionTitle title="邮件处理" detail="默认仅收件；自动投递需先设置一个 webhook 目标。"/>{settings.data.effectiveSendPaused && !settings.data.sendPaused && <div className="warning-banner"><CircleAlert size={16}/> 运维配置正在强制暂停投递，页面恢复开关无法覆盖它。</div>}<form id="settings-form" onSubmit={submit} className="settings-form"><div className="choice-stack"><label className={`choice-card ${draft.mode === 'archive' ? 'chosen' : ''}`}><input type="radio" name="mode" value="archive" checked={draft.mode === 'archive'} onChange={() => setDraft({ ...draft, mode: 'archive' })}/><span className="choice-icon"><Database size={20}/></span><span><strong>仅收件</strong><small>邮件会保存并显示在收件箱，不自动发往目标。已有队列仍按原计划处理。</small></span></label><label className={`choice-card ${draft.mode === 'forward' ? 'chosen' : ''}`}><input type="radio" name="mode" value="forward" checked={draft.mode === 'forward'} onChange={() => setDraft({ ...draft, mode: 'forward' })}/><span className="choice-icon"><ArrowRight size={20}/></span><span><strong>自动投递</strong><small>之后收到的新邮件会按当前目标创建投递事件；历史归档邮件不会自动补发。</small></span></label></div>
        <label className="field"><span>当前自动投递目标</span><select value={draft.current_endpoint} onChange={event => setDraft({ ...draft, current_endpoint: event.target.value })}><option value="">未选择目标</option>{endpoints.data?.map(endpoint => <option key={endpoint.name} value={endpoint.name}>{endpoint.displayName}</option>)}</select><small>更改目标只影响之后保存的新邮件，旧事件保持原目标版本。</small></label>
        {draft.mode === 'forward' && !draft.current_endpoint && <p className="inline-error"><CircleAlert size={16}/> 自动投递需要有效目标。<Link to="/endpoints">去配置</Link></p>}
        <label className="switch-line"><input type="checkbox" checked={draft.send_paused} onChange={event => setDraft({ ...draft, send_paused: event.target.checked })}/><span className="switch-visual"/><span><strong>暂停所有未开始的投递</strong><small>继续收信并记录待发送事件；恢复后按限流逐条发送。</small></span></label>
      </form></Card>
      <Card><SectionTitle title="分阶段保留" detail="新邮件默认原件 7 天、正文 30 天，从安全终态开始计时；已处理的异常邮件默认 60 天。"/>
        <div className="retention-summary"><HardDrive size={21}/><div><strong>原件和正文分别到期</strong><p>原件到期后不能下载或重解析，仍可查看正文；正文到期后清理正文、附件与事件内容。投递失败后经重发成功或被你取消的邮件，按已处理异常邮件保留期在最后一次处理后清理全部内容；最后一次送达之前的失败不会阻止清理，但之后新建的交付（如之后的重发）若失败且未被你取消，邮件不会被清理。已开始普通保留计时的邮件不改用此期限，之后若有失败或被取消的重发，在全部交付送达前不会自动清理。仍未处理的投递失败（之后没有新建并送达的交付，也未被你取消）、待处理、解析失败或正在处理的邮件，以及未经你成功重发或取消的需人工检查邮件，不会自动清理。</p></div></div>
        <div className="retention-input-row"><label className="field"><span>原件保留天数</span><input form="settings-form" type="number" min="1" max="3650" value={rawDays} onChange={event => setRawDays(event.target.value)} placeholder="不自动清理"/><small>留空表示不单独清理原件；正文到期仍会清理全部内容。</small></label><label className="field"><span>正文与附件保留天数</span><input form="settings-form" type="number" min="1" max="3650" value={contentDays} onChange={event => setContentDays(event.target.value)} placeholder="不自动清理"/><small>留空表示不自动清理正文。最小去重账本至少保留 {ledgerDays} 天；当前不会自动删除账本。</small></label></div>
        <div className="retention-input-row"><label className="field"><span>已处理异常邮件保留天数</span><input form="settings-form" type="number" min="1" max="3650" value={resolvedDays} onChange={event => setResolvedDays(event.target.value)} placeholder="不自动清理"/><small>投递失败后经重发成功或被你取消的邮件不会进入普通保留期；最后一次处理后保留这么多天再清理全部内容。默认 60 天，不得短于正文保留期；留空表示不自动清理，正文不自动清理时也须留空。仍失败或待处理的邮件不会被清理：最后一次送达之后新建的交付（如之后的重发）若失败且未被你取消，邮件仍算失败。</small></label></div>
        <label className="switch-line"><input type="checkbox" checked={applyExisting} onChange={event => setApplyExisting(event.target.checked)}/><span className="switch-visual"/><span><strong>将尚无保留策略的历史邮件纳入</strong><small>需要预览确认；确认后达到安全终态才开始计时，其中已由你处理的投递异常邮件按已处理异常邮件保留期计时。已有策略的邮件继续使用原策略。</small></span></label>
        <progress className="storage-progress" aria-label="逻辑内容容量" value={capacityUsed ?? overview.data?.logicalBytes ?? 0} max={overview.data?.logicalLimitBytes || 5 * 1024 ** 3}/><div className="storage-caption"><span>逻辑内容 {formatBytes(overview.data?.logicalBytes)}</span><span>应用容量 {formatBytes(overview.data?.logicalLimitBytes || settings.data.logicalLimitBytes)}</span></div>
        <dl className="side-facts"><InfoRow label="容量保护计账">{capacityUsed == null ? "未知" : formatBytes(capacityUsed)}</InfoRow><InfoRow label="预留与已分配对象">{capacityReserved == null ? "未知" : formatBytes(capacityReserved)}</InfoRow><InfoRow label="待物理删除">{formatBytes(overview.data?.pendingPhysicalDeleteBytes)}</InfoRow><InfoRow label="桶实际占用">未测量</InfoRow><InfoRow label="账户 R2 用量">未测量，需在 Cloudflare 查看</InfoRow></dl><p className="muted">应用容量不是账户账单上限。备份、孤立对象与其他项目也占用 R2 免费额度；逻辑清理不等于物理空间已释放。</p>
        <div className="settings-save"><span>{modified ? '有尚未保存的更改' : '设置已保存'}</span><Button type="submit" form="settings-form" loading={busy} disabled={!modified || (draft.mode === 'forward' && !draft.current_endpoint)}><Save size={16}/> 保存设置</Button></div>
      </Card>
    </div><aside className="settings-side"><Card><SectionTitle title="运行状态"/><dl className="side-facts"><InfoRow label="投递模式">{savedMode === 'forward' ? '自动投递' : '仅收件'}</InfoRow><InfoRow label="队列">{overview.data?.pendingDeliveryCount ?? '—'} 条等待</InfoRow><InfoRow label="需要处理">{overview.data?.failedDeliveryCount ?? '—'} 条</InfoRow><InfoRow label="最近备份">{formatDate(timeOf(overview.data?.lastBackupTime))}</InfoRow></dl><Link to="/deliveries" className="text-link">查看投递记录 <ArrowRight size={15}/></Link></Card><Card><SectionTitle title="提醒" detail="容量 70% / 85% / 95%、备份超过 36 小时、积压超过 1 小时、解析失败、投递目标被阻断或暂停、投递已停止，以及策略读取失败只归档未转发。"/><p>{overview.data?.alertWebhookMisconfigured ? '外部提醒配置无效，请检查部署配置。' : overview.data?.alertWebhookConfigured ? '外部 webhook 提醒已配置。' : '显示在工作台顶部和此页；可在部署时配置外部提醒 webhook。'}</p>{overview.data?.activeAlerts.map(alert => <p key={alert.code} className="warning-banner"><CircleAlert size={16}/>{alertLabel(alert.code)}{isEndpointAlert(alert.code) && <Link to="/endpoints">处理目标</Link>}</p>)}{overview.data && <p className="muted">通知待发送 {overview.data.pendingNotificationCount} 条，发送失败 {overview.data.failedNotificationCount} 条。通知仅含状态和计数，不含邮件内容。</p>}<Button variant="quiet" onClick={() => overview.refetch()}>刷新运行状态</Button></Card><Card><SectionTitle title="访问与隐私"/><div className="privacy-list"><p><LockKeyhole size={17}/> 管理界面需要通过你的 Access 身份访问。</p><p><ShieldCheck size={17}/> 页面不加载外部字体、统计脚本或邮件远程图片。</p><p><PauseCircle size={17}/> 暂停投递不影响收件。</p></div></Card></aside></div>
    {confirmArchive && <Modal title="切换为仅收件？" onClose={() => !busy && setConfirmArchive(false)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setConfirmArchive(false)}>返回</Button><Button loading={busy} onClick={() => save()}>保留已有队列并保存</Button></>}><p>仍有 <strong>{overview.data?.pendingDeliveryCount}</strong> 条既有投递等待处理。切换模式只影响之后的新邮件；已有投递仍会尝试。</p><label className="switch-line"><input type="checkbox" checked={draft.send_paused} onChange={event => setDraft({ ...draft, send_paused: event.target.checked })}/><span className="switch-visual"/><span><strong>同时暂停既有投递</strong><small>队列会保留，直到你恢复发送。</small></span></label>{error && <p className="inline-error">{error}</p>}</Modal>}
    {retentionPreview && <Modal title="确认分阶段保留策略？" danger onClose={() => !busy && setRetentionPreview(null)} footer={<><Button variant="secondary" disabled={busy} onClick={() => setRetentionPreview(null)}>返回设置</Button><Button variant="danger" loading={busy} onClick={() => save(retentionPreview.confirmationToken)}>确认并保存</Button></>}>
      <p>新邮件：原件 {retentionPreview.rawRetentionDays == null ? '不单独自动清理' : `${retentionPreview.rawRetentionDays} 天`}；正文与附件 {retentionPreview.contentRetentionDays == null ? '不自动清理' : `${retentionPreview.contentRetentionDays} 天`}。</p>
      <p>已处理异常邮件：{retentionPreview.resolvedRetentionDays == null ? '不自动清理' : `最后一次处理后 ${retentionPreview.resolvedRetentionDays} 天清理全部内容`}。此项不按邮件冻结；当前有 <strong>{retentionPreview.resolvedMessageCount}</strong> 封已处理的异常邮件尚未清理。{(retentionPreview.resolvedRetentionDays ?? null) === savedResolved ? '此项未改变。' : retentionPreview.resolvedRetentionDays == null ? '保存后它们不再自动清理。' : `保存后按最后一次处理时间重新计算（不早于系统首次确认其已处理的时间），已超过 ${retentionPreview.resolvedRetentionDays} 天（邮件自身冻结的正文期限更长时按更长者）的会在之后的后台清理中逐批删除原件、正文、附件与事件内容。`}仍有未处理的失败交付（之后没有新建并送达的交付，也未被你取消）的邮件和待处理的邮件不会被清理。</p>
      {retentionPreview.applyExisting ? <p>将为 <strong>{retentionPreview.historicalMessageCount}</strong> 封尚无策略的历史邮件设置此策略，其中当前安全终态 <strong>{retentionPreview.safeTerminalMessageCount}</strong> 封。确认后从安全终态开始计时，本次保存立即清理 <strong>0 字节</strong>。{retentionPreview.resolvedRetentionDays != null && `其中投递失败后已由你处理（重发已送达或已取消）的历史邮件也会纳入已处理异常邮件保留期：从确认后首次后台检查起计时，${retentionPreview.resolvedRetentionDays} 天后清理全部内容；上面的已处理数量可能未包含它们。`}</p> : <p>原件与正文期限仅改变之后收到的新邮件。历史邮件与已经冻结的保留策略保持不变。</p>}
      <p>预览有效期至 {formatDate(timeOf(retentionPreview.expireTime))}；邮件状态可能变化。已清理的原件与正文只能通过仍保留的独立备份恢复。</p>
      {draft.mode === 'archive' && savedMode === 'forward' && (overview.data?.pendingDeliveryCount || 0) > 0 && <p>切换仅收件后，现有 {overview.data?.pendingDeliveryCount} 条交付仍按原计划处理。可先在上方打开全局暂停。</p>}{error && <p className="inline-error">{error}</p>}
    </Modal>}
  </>
}
