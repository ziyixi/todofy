import { useEffect, useState } from 'react'
import { createHttpClient } from '@ziyixi/proto/http-client'
import { PlusService, type ExtensionConnection, type Plan } from '@ziyixi/proto/todofy/ui/v1/plus_service_pb'
import { send, toApiError } from '../api/client'
import { useSetup } from '../api/queries'
import { CopyButton, PageHeader, Section } from '../components/ui'

const plus = createHttpClient(PlusService, send)

/** Explicit opt-in: opening this page or issuing a token never enables weekly writes. */
export function PlusPage() {
  const setup = useSetup()
  const [plan, setPlan] = useState<Plan>()
  const [connections, setConnections] = useState<ExtensionConnection[]>([])
  const [device, setDevice] = useState('Chrome')
  const [token, setToken] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function load() {
    const [current, connected] = await Promise.all([plus.readPlan({}), plus.readExtensionConnections({})])
    setPlan(current.plan)
    setConnections(connected.connections)
  }
  async function work(action: () => Promise<unknown>) {
    setBusy(true)
    setMessage('')
    try { await action() } catch (error) { setMessage(toApiError(error).message) } finally { setBusy(false) }
  }
  useEffect(() => { void load().catch(error => setMessage(toApiError(error).message)) }, [])
  const host = setup.data?.hooksHosts[0]
  return <>
    <PageHeader title="Todoist Plus" description="连接浏览器扩展，在 Todoist 里使用周计划和 FlowDay。" />
    <div className="stack">
      <Section title="确认现有标签">
        {plan ? <>
          <p>{plan.labels.map(label => `${label.role} → ${label.label}`).join(' · ')}</p>
          <p>时区：{plan.timezone}。每周一 00:00 后的下一次十分钟检查，将上周未完成的承诺移回本周候选，清除上周 Bets；其他标签、日期和任务内容保留。</p>
          {plan.missingLabels.length > 0 && <p>缺少标签：{plan.missingLabels.join('、')}。请先在 Todoist 创建。</p>}
          <button disabled={busy || plan.missingLabels.length > 0 || plan.enabled} onClick={() => void work(async () => { await plus.confirmPlanMapping({ etag: plan.etag, requestId: crypto.randomUUID() }); await load() })}>{plan.enabled ? '已启用' : '确认映射并启用每周整理'}</button>
        </> : <p>读取中…</p>}
      </Section>
      <Section title="插件连接">
        {host && <p>服务器：<code>https://{host}</code> <CopyButton value={`https://${host}`} label="服务器" /></p>}
        <label>设备名称 <input value={device} maxLength={60} onChange={event => setDevice(event.target.value)} /></label>
        <p><button disabled={busy || !device.trim()} onClick={() => void work(async () => { const result = await plus.issueExtensionConnection({ displayName: device, requestId: crypto.randomUUID() }); setToken(result.token); await load() })}>生成连接口令</button></p>
        {token && <p><code className="wrap">{token}</code> <CopyButton value={token} label="插件口令" /></p>}
        <p>口令只显示一次，粘贴到 Todoist Plus 的设置页。扩展不会取得 Todoist API 密钥。</p>
        <ul>{connections.map(connection => <li key={connection.id}>{connection.displayName} {connection.revoked ? '已撤销' : <button disabled={busy} onClick={() => void work(async () => { await plus.revokeExtensionConnection({ connectionId: connection.id, requestId: crypto.randomUUID() }); await load() })}>撤销</button>}</li>)}</ul>
      </Section>
      {message && <p role="alert">{message}</p>}
    </div>
  </>
}
