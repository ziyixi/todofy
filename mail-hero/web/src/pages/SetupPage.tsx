import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { ArrowRight, CheckCircle2, CircleAlert, Cloud, Inbox, Mail, RefreshCw, Server, ShieldCheck } from 'lucide-react'
import { api } from '../api/client'
import { Button, Card, CopyButton, ErrorState, formatDate, Loading, PageHead, SectionTitle } from '../components/UI'

export default function SetupPage() {
  const setup = useQuery({ queryKey: ['setup'], queryFn: api.setup })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const receiveAddress = settings.data?.receive_address || setup.data?.receive_address
  const transport = setup.data?.ingest_transport
  const cloudflare = transport === 'cloudflare'

  return <>
    <PageHead
      eyebrow="GETTING STARTED · 接入指引"
      title="连接你的邮箱"
      description={cloudflare
        ? '一个收信地址。Cloudflare 接收转发邮件，Mail Hero 保存并展示已送达的原件。'
        : transport === 'smtp' ? '只需要一个收信地址。把 Gmail、Exchange 等邮箱转发到这里即可。'
          : '只需要一个收信地址。确认接入方式后，再设置原邮箱转发。'}
      action={<Button variant="secondary" onClick={() => { setup.refetch(); settings.refetch() }}><RefreshCw size={16}/> 重新检测</Button>}
    />
    <div className="setup-grid">
      <div className="setup-main">
        <Card className="setup-hero">
          <span className="eyebrow">01 · 你的专属收信地址</span>
          <h2>把邮件转发到这里</h2>
          {settings.isPending && !receiveAddress ? <Loading/> : settings.isError && !receiveAddress ? <ErrorState error={settings.error} retry={() => settings.refetch()}/> : <div className="setup-address"><code>{receiveAddress || '尚未配置收信地址'}</code>{receiveAddress && <CopyButton value={receiveAddress} label="复制地址"/>}</div>}
          <p>{!transport ? '正在确认收件方式；确认之前请不要修改原邮箱的转发规则。' : cloudflare
            ? '这是由 Cloudflare Email Routing 接收的地址，不需要开设邮箱账户，也不需要把原邮箱密码交给 Mail Hero。'
            : '这是 SMTP 收件地址，不需要开设邮箱账户，也不需要把原邮箱密码交给 Mail Hero。'}</p>
        </Card>
        {setup.isPending ? <Loading label="正在读取接入方式…"/> : setup.isError ? <ErrorState error={setup.error} retry={() => setup.refetch()}/> : <div className="step-list">
          {cloudflare ? <>
            <Card className="setup-step"><div className="step-number">1</div><div><h3>在 Cloudflare 配置邮件路由</h3><p>为这个地址建立 Email Routing 规则，将收到的邮件交给 Mail Hero Worker。只配置专用收信子域的 MX，保留主邮箱已有的邮件设置。</p><div className="step-tag"><Cloud size={16}/> Cloudflare 侧配置一次</div></div></Card>
            <Card className="setup-step"><div className="step-number">2</div><div><h3>确认邮件保存与处理</h3><p>Mail Hero 在 Cloudflare 保存原件，再由后台任务解析和安排投递。先发送一封合成邮件，确认收件箱能查看正文、附件和处理状态；配置检测通过不代表真实转发已到达。</p></div></Card>
          </> : <Card className="setup-step"><div className="step-number">1</div><div><h3>部署时配置一次域名与 SMTP</h3><p>专用子域的 MX 指向 Mail Hero 主机。SMTP 25 端口可达、STARTTLS 证书有效后，新邮件才可能抵达。Cloudflare 的普通代理和 Tunnel 不负责转发公网 SMTP。</p><div className="step-tag"><Cloud size={16}/> DNS 只需配置一次</div></div></Card>}
          <Card className="setup-step"><div className="step-number">{cloudflare ? 3 : 2}</div><div><h3>在原邮箱开启转发</h3><p>Gmail 通常会发送一封验证邮件到收信地址；在 Mail Hero 收件箱中打开它，再到 Gmail 完成确认。Exchange 可能需要管理员允许外部自动转发。</p><div className="provider-links"><a href="https://support.google.com/mail/answer/10957?hl=zh-Hans" target="_blank" rel="noopener noreferrer">Gmail 设置说明 <ArrowRight size={14}/></a><a href="https://learn.microsoft.com/zh-cn/defender-office-365/outbound-spam-policies-external-email-forwarding" target="_blank" rel="noopener noreferrer">Exchange 外部转发说明 <ArrowRight size={14}/></a></div></div></Card>
          <Card className="setup-step"><div className="step-number">{cloudflare ? 4 : 3}</div><div><h3>查看邮件，再决定是否自动投递</h3><p>默认只保存来信。确认邮件内容、附件和来源正常后，配置 webhook 目标并在设置中打开自动投递。历史归档邮件不会被自动补发。</p><div className="step-actions"><Link to="/inbox" className="button button-secondary"><Inbox size={16}/> 查看收件箱</Link><Link to="/endpoints" className="button button-secondary">配置 webhook <ArrowRight size={16}/></Link></div></div></Card>
        </div>}
      </div>
      <aside className="setup-side">
        <Card><SectionTitle title="接入检测" detail="配置通过不等于已收到真实邮件。"/>{setup.isPending ? <Loading label="正在检查…"/> : setup.isError ? <ErrorState error={setup.error} retry={() => setup.refetch()}/> : setup.data?.checks?.length ? <div className="check-list">{setup.data.checks.map(check => <div className="check-row" key={check.id}><span className={`check-icon check-${check.status}`}>{check.status === 'ok' ? <CheckCircle2 size={18}/> : <CircleAlert size={18}/>}</span><div><strong>{check.label}</strong>{check.detail && <p>{check.detail}</p>}{check.action && <small>{check.action}</small>}</div></div>)}</div> : <p className="muted">尚无检测结果。可以在收件箱确认真实邮件是否到达。</p>}{setup.data?.last_received_at && <p className="last-received"><Mail size={15}/> 最近收件：{formatDate(setup.data.last_received_at)}</p>}</Card>
        <Card><SectionTitle title="明确的边界"/><div className="privacy-list">{cloudflare ? <><p><Cloud size={17}/> 邮件内容保存在私有 R2，索引和处理状态保存在 D1；Cloudflare 会处理邮件原件。</p><p><Server size={17}/> 收件与后台处理由 Cloudflare 托管。这里只显示应用已登记的状态，不能代替 Gmail 或 Exchange 的转发设置。</p></> : transport === 'smtp' ? <p><Server size={17}/> Mail Hero 可以控制自己的 SMTP 和数据库，无法代替你操作 Gmail 或 Exchange 的设置。</p> : <p><Server size={17}/> 接入方式尚未确认，请先查看检测结果。</p>}<p><ShieldCheck size={17}/> 同一入口的邮件不能仅凭 From 保证来自哪个原邮箱。</p></div></Card>
      </aside>
    </div>
  </>
}
