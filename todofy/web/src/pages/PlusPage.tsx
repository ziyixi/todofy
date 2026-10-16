import { useEffect, useState } from 'react'
import { createHttpClient } from '@ziyixi/proto/http-client'
import { PlusService, type ExtensionConnection, type Plan } from '@ziyixi/proto/todofy/ui/v1/plus_service_pb'
import { send, toApiError } from '../api/client'
import { useSetup } from '../api/queries'
import { CopyButton, PageHeader, Section } from '../components/ui'

const plus = createHttpClient(PlusService, send)
const columns = [['quarter', 'Quarter'], ['candiate', 'Month'], ['focus', 'Week'], ['committed', 'Committed']] as const
// A setup confirmed before the Bets became text keeps its retired bets binding as saved; it is not shown.
const RETIRED_ROLES = new Set(['bets'])

/** Explicit opt-in: opening this page or issuing a token never enables weekly writes. */
export function PlusPage() {
  const setup = useSetup()
  const [plan, setPlan] = useState<Plan>()
  const [connections, setConnections] = useState<ExtensionConnection[]>([])
  const [columnIds, setColumnIds] = useState<Record<string, string>>({})
  const [device, setDevice] = useState('Chrome')
  const [token, setToken] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function load() {
    const [current, connected] = await Promise.all([plus.readPlan({}), plus.readExtensionConnections({})])
    setPlan(current.plan)
    setColumnIds(Object.fromEntries(columns.map(([role]) => [role, current.plan?.labels.find(label => label.role === role)?.id ?? ''])))
    setConnections(connected.connections)
  }
  async function work(action: () => Promise<unknown>) {
    setBusy(true)
    setMessage('')
    try { await action() } catch (error) { setMessage(toApiError(error).message) } finally { setBusy(false) }
  }
  useEffect(() => { void load().catch(error => setMessage(toApiError(error).message)) }, [])
  const host = setup.data?.hooksHosts[0]
  const columnsChanged = plan && columns.some(([role]) => (columnIds[role] ?? '') !== (plan.labels.find(label => label.role === role)?.id ?? ''))
  async function saveColumns() {
    if (!plan) return
    const labels = columns.flatMap(([role]) => {
      const id = columnIds[role]
      const label = plan.availableLabels.find(item => item.id === id)
      return label ? [{ role, id: label.id, label: label.label }] : []
    })
    await plus.updatePlanLabels({ labels, etag: plan.etag, requestId: crypto.randomUUID() })
    await load()
  }
  return <>
    <PageHeader title="Todoist Plus" description="连接浏览器扩展，在 Todoist 里使用周计划和 FlowDay。" />
    <div className="stack">
      <Section title="确认现有标签">
        {plan ? <>
          <p>{plan.labels.filter(label => !RETIRED_ROLES.has(label.role)).map(label => `${label.role} → ${label.label}`).join(' · ')}</p>
          <p>Quarter 标签可选，可在扩展的列设置中绑定现有标签。更换列绑定只改配置，不改已有任务；未绑定 Quarter 时，每周整理照常运行。</p>
          <p>绑定 ID 丢失时，规划写入会暂停，需要人工恢复配置；不会自动采用新建的同名标签。标签改名后，请在此核对并重新确认。</p>
          <p>时区：{plan.timezone}。每周一 00:00 后的下一次十分钟检查，将上周未完成的承诺移回本周候选；其他标签、日期和任务内容保留。本周目标是文字，按周保存在 Todofy，不会被重置。</p>
          {plan.missingLabels.length > 0 && <p>缺少标签绑定：{plan.missingLabels.join('、')}。请先在 Todoist 核对标签。</p>}
          <button className="btn btn-primary" disabled={busy || plan.missingLabels.length > 0 || plan.enabled} onClick={() => void work(async () => { await plus.confirmPlanMapping({ etag: plan.etag, requestId: crypto.randomUUID() }); await load() })}>{plan.enabled ? '已启用' : '确认映射并启用每周整理'}</button>
        </> : <p>读取中…</p>}
      </Section>
      {plan && <Section title="规划列标签">
        <p>按现有标签 ID 绑定列。Quarter 可以不绑定；其他三列需要分别选择一个标签。</p>
        {columns.map(([role, title]) => <div className="field" key={role}>
          <label htmlFor={`plus-label-${role}`}>{title}</label>
          <select id={`plus-label-${role}`} value={columnIds[role] ?? ''} disabled={busy || !plan.enabled} onChange={event => setColumnIds({ ...columnIds, [role]: event.target.value })}>
            <option value="">{role === 'quarter' ? '未绑定' : '选择现有标签'}</option>
            {plan.availableLabels.map(label => <option value={label.id} key={label.id}>{label.label}</option>)}
          </select>
        </div>)}
        <button className="btn btn-primary" disabled={busy || !plan.enabled || !columnsChanged || columns.some(([role]) => role !== 'quarter' && !columnIds[role])} onClick={() => void work(saveColumns)}>保存列绑定</button>
      </Section>}
      <Section title="插件连接">
        {host && <p>服务器：<code>https://{host}</code> <CopyButton value={`https://${host}`} label="服务器" /></p>}
        <div className="field">
          <label htmlFor="plus-device">设备名称</label>
          <input id="plus-device" value={device} maxLength={60} onChange={event => setDevice(event.target.value)} />
        </div>
        <p><button className="btn btn-primary" disabled={busy || !device.trim()} onClick={() => void work(async () => { const result = await plus.issueExtensionConnection({ displayName: device, requestId: crypto.randomUUID() }); setToken(result.token); await load() })}>生成连接口令</button></p>
        {token && <p><code className="wrap">{token}</code> <CopyButton value={token} label="插件口令" /></p>}
        <p>口令只显示一次，粘贴到 Todoist Plus 的设置页。扩展不会取得 Todoist API 密钥。</p>
        <ul>{connections.map(connection => <li key={connection.id}>{connection.displayName} {connection.revoked ? '已撤销' : <button className="btn btn-ghost" disabled={busy} onClick={() => void work(async () => { await plus.revokeExtensionConnection({ connectionId: connection.id, requestId: crypto.randomUUID() }); await load() })}>撤销</button>}</li>)}</ul>
      </Section>
      {message && <p role="alert">{message}</p>}
    </div>
  </>
}
