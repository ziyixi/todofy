import type { Env } from './types.ts'
import { json, signToken, verifyToken } from './security.ts'
import { wake } from './pipeline.ts'
import { bad, body, boolean, conflict, missing, now, paused, required, uuid, version, type Row } from './api-common.ts'

export async function currentSettings(env: Env): Promise<Row> {
  const result = await env.DB.prepare(`SELECT version,mode,current_endpoint_id,send_paused,retention_days,logical_bytes,logical_limit_bytes,last_backup_at FROM app_settings WHERE id=1`).all<Row>()
  const value = result.results[0] || missing()
  const databaseBytes = Number.isFinite(result.meta.size_after) ? result.meta.size_after : null
  return { ...value, send_paused: !!value.send_paused, effective_send_paused: !!value.send_paused || paused(env) || env.MAINTENANCE_MODE === 'true', receive_address: env.RECEIVE_ADDRESS, maintenance_mode: env.MAINTENANCE_MODE === 'true', database_bytes: databaseBytes }
}

async function schedulerStatus(env: Env): Promise<Row> {
  try {
    const response = await env.COORDINATOR.get(env.COORDINATOR.idFromName('inbox-v1')).fetch('https://coordinator/status', { method: 'GET', signal: AbortSignal.timeout(3000) })
    if (!response.ok) throw new Error('scheduler_unavailable')
    const value = await response.json() as Row
    if (!Number.isSafeInteger(value.pending) || value.pending < 0 || !Number.isSafeInteger(value.failed) || value.failed < 0) throw new Error('scheduler_invalid_status')
    const timestamp = (number: unknown) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) < 8640000000000000 ? new Date(number).toISOString() : null
    return { available: true, pending: value.pending, failed: value.failed, oldest_at: timestamp(value.oldest), next_alarm_at: timestamp(value.next_alarm) }
  } catch { return { available: false, pending: null, failed: null, oldest_at: null, next_alarm_at: null } }
}
function retentionDays(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 3650) bad('保留天数无效')
  return value as number
}
export const eligibleRetention = `m.origin='cloudflare' AND m.content_deleted_at IS NULL AND m.parse_state='ready' AND m.received_at<?
  AND (m.receive_mode='archive' OR EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.state='delivered'))
  AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.state<>'delivered')`

export async function previewRetention(request: Request, env: Env, owner: string): Promise<Response> {
  const days = retentionDays(Number(new URL(request.url).searchParams.get('days')))
  const settings = await currentSettings(env)
  const cutoff = new Date(Date.now() - days * 86400000).toISOString()
  const counts = await required(env, `SELECT count(*) candidates,COALESCE(sum(m.content_bytes+
    COALESCE((SELECT sum(d.payload_size_bytes) FROM deliveries d WHERE d.message_id=m.id AND d.payload_key IS NOT NULL),0)),0) bytes_to_clear
    FROM messages m WHERE ${eligibleRetention}`, cutoff)
  const expiration = Math.floor(Date.now() / 1000) + 600
  return json({ version: settings.version, days, ...counts, expires_at: new Date(expiration * 1000).toISOString(),
    preview_token: await signToken(env, { kind: 'retention', owner, version: settings.version, days, exp: expiration }) })
}

export async function patchSettings(request: Request, env: Env, owner: string): Promise<Response> {
  const input = await body(request), expected = version(input.version), old = await currentSettings(env)
  if (old.version !== expected) conflict()
  const mode = input.mode ?? old.mode
  if (mode !== 'archive' && mode !== 'forward') bad('mode 只能为 archive 或 forward')
  const endpointID = 'current_endpoint_id' in input
    ? input.current_endpoint_id === null ? null : uuid(input.current_endpoint_id, 'current_endpoint_id') : old.current_endpoint_id
  if (mode === 'forward' && !endpointID) bad('自动投递需要先选择 webhook 目标')
  if (endpointID) await required(env, 'SELECT id FROM webhook_endpoints WHERE id=? AND archived_at IS NULL AND current_revision_id IS NOT NULL', endpointID)
  const sendPaused = 'send_paused' in input ? boolean(input.send_paused, 'send_paused') : old.send_paused
  const retention = 'retention_days' in input
    ? input.retention_days === null ? null : retentionDays(input.retention_days) : old.retention_days
  if (retention !== null && (old.retention_days === null || retention < old.retention_days)) {
    const token = typeof input.retention_confirmation === 'string' ? await verifyToken(env, input.retention_confirmation) : null
    if (token?.kind !== 'retention' || token.owner !== owner || token.version !== expected || token.days !== retention) bad('缩短保留期前需要预览并确认')
  }
  const result = await env.DB.prepare(`UPDATE app_settings SET mode=?,current_endpoint_id=?,send_paused=?,retention_days=?,version=version+1,updated_at=?
    WHERE id=1 AND version=? AND (? IS NULL OR EXISTS(SELECT 1 FROM webhook_endpoints WHERE id=? AND archived_at IS NULL AND current_revision_id IS NOT NULL))`)
    .bind(mode, endpointID, +sendPaused, retention, now(), expected, endpointID, endpointID).run()
  if (!result.meta.changes) conflict()
  await wake(env)
  return json(await currentSettings(env))
}

export async function overview(env: Env): Promise<Response> {
  const settings = await currentSettings(env)
  const scheduler = await schedulerStatus(env)
  const counts = await required(env, `SELECT
    (SELECT count(*) FROM messages WHERE origin='cloudflare') messages,
    (SELECT count(*) FROM deliveries WHERE state IN('pending','retry_wait','sending')) pending,
    (SELECT count(*) FROM deliveries WHERE state='failed') failed,
    (SELECT count(*) FROM deliveries WHERE state='delivered') delivered,
    (SELECT count(*) FROM messages WHERE parse_state='failed' AND content_deleted_at IS NULL) parse_failed`)
  const warnings: string[] = []
  if (settings.logical_bytes >= settings.logical_limit_bytes * 0.7) warnings.push('邮件内容接近配置容量，请检查 R2/D1 用量和保留设置。')
  if (settings.database_bytes !== null && settings.database_bytes >= 350000000) warnings.push('D1 数据库接近 Free 单库 500 MB 上限，请检查搜索索引、历史记录及数据库用量。')
  if (counts.parse_failed > 0) warnings.push(`${counts.parse_failed} 封邮件解析失败，原件仍保留。`)
  if (settings.effective_send_paused && env.MAINTENANCE_MODE !== 'true') warnings.push('消费者投递已暂停，收信继续。')
  if (env.MAINTENANCE_MODE === 'true') warnings.push('维护模式：暂停新收件、内容修改和后台处理。')
  if (!scheduler.available) warnings.push('暂时无法读取后台调度状态，请检查 Durable Object。')
  else {
    if (scheduler.failed > 0) warnings.push(`后台有 ${scheduler.failed} 条失败记录，请检查收件原件是否成功保存及调度诊断。`)
    if (scheduler.pending > 0 && !scheduler.next_alarm_at) warnings.push('后台仍有待办但没有已安排的 alarm，请检查调度器。')
  }
  if (!settings.last_backup_at) warnings.push('尚无已登记的独立备份；D1 Time Travel 不包含 R2 邮件对象。')
  return json({ receive_address: env.RECEIVE_ADDRESS, counts,
    storage: { logical_bytes: settings.logical_bytes, limit_bytes: settings.logical_limit_bytes, database_bytes: settings.database_bytes },
    backup: { last_at: settings.last_backup_at }, send_paused: settings.effective_send_paused, scheduler, warnings })
}

export async function setupStatus(env: Env): Promise<Response> {
  const recent = await required(env, `SELECT max(received_at) last_received_at FROM messages WHERE origin='cloudflare'`)
  const scheduler = await schedulerStatus(env)
  const addressValid = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(env.RECEIVE_ADDRESS ?? '')
  return json({ ingest_transport: 'cloudflare', receive_address: env.RECEIVE_ADDRESS, address_valid: addressValid, scheduler, ...recent,
    checks: [
      { id: 'address', label: '唯一收信地址', status: addressValid ? 'ok' : 'error', detail: addressValid ? 'Worker 已加载地址；Email Routing 规则需要独立核对。' : '请检查 RECEIVE_ADDRESS。' },
      { id: 'database', label: 'D1 状态数据库', status: 'ok', detail: '本次查询已成功；不代表原邮箱转发已完成。' },
      { id: 'scheduler', label: '持久后台调度', status: !scheduler.available ? 'error' : scheduler.failed > 0 ? 'warning' : 'ok', detail: !scheduler.available ? '本次无法读取 Durable Object 状态。' : `${scheduler.pending} 条待办、${scheduler.failed} 条失败记录；这不是邮件来源的端到端验收。` },
      { id: 'edge', label: 'Email Routing 与 R2', status: 'pending', detail: '请用合成测试邮件验证路由、原件保存和后台解析；仅有配置无法证明真实可达。' },
      { id: 'received', label: '已有收件记录', status: recent.last_received_at ? 'ok' : 'pending', detail: recent.last_received_at ? '已有 Cloudflare 入口邮件记录；来源身份和完整业务链路仍需验收。' : '尚未收到邮件。' },
      { id: 'runtime', label: 'Cloudflare Free 运行限制', status: 'warning', detail: 'Free Worker 请求 CPU 为 10 ms，后台解析通过 Durable Object alarm 执行；大邮件仍需实测。' },
    ] })
}
