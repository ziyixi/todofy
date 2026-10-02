// The owner API's settings, retention preview, overview and setup checks (mailhero.ui.v2 Settings, Overview,
// SetupStatus). Inputs are plain values api-v2.ts read from the request (an update names only the fields it changes);
// outputs are rows. Every read here is a few indexed D1 statements and at most one coordinator call: the UI polls the
// overview every five minutes.
import type { Env } from './types.ts'
import { HttpError, signToken, verifyToken } from './security.ts'
import { wake } from './pipeline.ts'
import { lifecycleStorage, resolvedFloorSQL, resolvedTerminalSQL, safeTerminalSQL } from './lifecycle.ts'
import { alertOverview, parseStatus } from './alerts.ts'
import { bad, boolean, conflict, missing, now, paused, required, uuid, type Row } from './api-common.ts'

export async function currentSettings(env: Env): Promise<Row> {
  const result = await env.DB.prepare(`SELECT version,mode,current_endpoint_id,send_paused,retention_days,lifecycle_policy_version,raw_retention_days,content_retention_days,ledger_retention_days,resolved_retention_days,logical_bytes,logical_limit_bytes,last_backup_at FROM app_settings WHERE id=1`).all<Row>()
  const value = result.results[0] || missing()
  const databaseBytes = Number.isFinite(result.meta.size_after) ? result.meta.size_after : null
  return { ...value, send_paused: !!value.send_paused, effective_send_paused: !!value.send_paused || paused(env) || env.MAINTENANCE_MODE === 'true', receive_address: env.RECEIVE_ADDRESS, maintenance_mode: env.MAINTENANCE_MODE === 'true', database_bytes: databaseBytes }
}

export async function schedulerStatus(env: Env): Promise<Row> {
  try {
    const response = await env.COORDINATOR.get(env.COORDINATOR.idFromName('inbox-v1')).fetch('https://coordinator/status', { method: 'GET', signal: AbortSignal.timeout(3000) })
    if (!response.ok) throw new Error('scheduler_unavailable')
    const value = await response.json() as Row
    if (!Number.isSafeInteger(value.pending) || value.pending < 0 || !Number.isSafeInteger(value.failed) || value.failed < 0) throw new Error('scheduler_invalid_status')
    const timestamp = (number: unknown) => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) < 8640000000000000 ? new Date(number).toISOString() : null
    const capacity = value.capacity && ['used_bytes', 'reserved_bytes', 'limit_bytes'].every(key => Number.isSafeInteger(value.capacity[key]) && value.capacity[key] >= 0)
      ? { initialized: value.capacity.initialized === true, used_bytes: value.capacity.used_bytes, reserved_bytes: value.capacity.reserved_bytes, limit_bytes: value.capacity.limit_bytes } : null
    return { available: true, pending: value.pending, failed: value.failed, oldest_at: timestamp(value.oldest), next_alarm_at: timestamp(value.next_alarm), capacity }
  } catch { return { available: false, pending: null, failed: null, oldest_at: null, next_alarm_at: null } }
}
/** A retention period's days (1-3650); `rule` names what was broken (errors.proto INVALID_RETENTION_POLICY). */
function retentionDays(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 3650) policyError('保留天数无效', 'days_range')
  return value as number
}
function policyError(message: string, rule: string): never { throw new HttpError(400, `retention_${rule}`, message) }
export const eligibleRetention = `${safeTerminalSQL()} AND m.received_at<?`
function policyDays(value: unknown): number | null { return value === null ? null : retentionDays(value) }
/** The policy an input describes: each period `input` holds (null: kept forever), the stored one otherwise. */
function policyInput(input: Row, old: Row): Row {
  const raw = 'raw_retention_days' in input ? policyDays(input.raw_retention_days) : old.raw_retention_days
  const content = 'content_retention_days' in input ? policyDays(input.content_retention_days) : old.content_retention_days
  const ledger = 'ledger_retention_days' in input ? retentionDays(input.ledger_retention_days) : old.ledger_retention_days
  if (ledger < 90) policyError('去重记录至少保留 90 天', 'ledger_minimum')
  if (raw !== null && content !== null && raw > content) policyError('原件保留期不能长于正文保留期', 'raw_after_content')
  // Global, not snapshotted per message: it applies to every resolved exception.
  // A content period kept forever (NULL) allows only a resolved period kept
  // forever. Checked when either staged field is being set, so a stored
  // combination (e.g. from the retired retention_days field) never blocks other
  // changes; the lifecycle enforces the longer period regardless.
  const resolved = 'resolved_retention_days' in input ? policyDays(input.resolved_retention_days) : old.resolved_retention_days
  const touched = ['resolved_retention_days', 'content_retention_days'].some(key => key in input)
  if (touched && resolved !== null && (content === null || resolved < content)) policyError('已处理异常邮件的保留期不能短于正文保留期', 'resolved_before_content')
  return { raw_retention_days: raw, content_retention_days: content, ledger_retention_days: ledger, resolved_retention_days: resolved }
}
/** Live resolved exceptions that the resolved period governs. */
const resolvedLive = `FROM messages m INDEXED BY messages_unsettled_idx WHERE m.origin='cloudflare' AND m.content_deleted_at IS NULL
  AND m.retention_started_at IS NULL AND ${resolvedTerminalSQL()} AND NOT (${safeTerminalSQL()})`

/**
 * What a whole retention policy would do, and the token (10 minutes, bound to the owner, the settings' version and the
 * exact policy) that confirms it. `input` holds all four periods (null: kept forever) and apply_existing.
 */
export async function previewRetention(env: Env, owner: string, input: Row): Promise<Row> {
  const settings = await currentSettings(env)
  const expiration = Math.floor(Date.now() / 1000) + 600
  const policy = policyInput(input, settings), applyExisting = input.apply_existing === true
  const counts = await required(env, `SELECT count(*) historical_messages,
    COALESCE(sum(CASE WHEN ${safeTerminalSQL()} THEN 1 ELSE 0 END),0) safe_terminal_messages,
    COALESCE(sum(m.content_bytes),0) historical_content_bytes
    FROM messages m WHERE m.origin='cloudflare' AND m.retention_policy_version IS NULL AND m.content_deleted_at IS NULL`)
  counts.resolved_messages = (await required(env, `SELECT count(*) n ${resolvedLive}`)).n
  return { version: settings.version, ...policy, apply_existing: applyExisting, ...counts,
    candidates: applyExisting ? counts.historical_messages : 0,
    expires_at: new Date(expiration * 1000).toISOString(),
    preview_token: await signToken(env, { kind: 'lifecycle', owner, version: settings.version, ...policy, apply_existing: applyExisting, exp: expiration }) }
}

/**
 * Changes the settings `input` holds (mode, current_endpoint_id, send_paused, the four retention periods) if they are
 * still at `expected` (their version). Enabling or shortening a period, or `applyExisting`, needs the token of a
 * preview of exactly the saved policy (`confirmation`). Answers the stored settings.
 */
export async function patchSettings(env: Env, owner: string, input: Row, expected: number, confirmation: string | null, applyExisting: boolean): Promise<Row> {
  const old = await currentSettings(env)
  if (old.version !== expected) conflict()
  const mode = input.mode ?? old.mode
  if (mode !== 'archive' && mode !== 'forward') bad('mode 只能为 archive 或 forward')
  const endpointID = 'current_endpoint_id' in input
    ? input.current_endpoint_id === null ? null : uuid(input.current_endpoint_id, 'current_endpoint_id') : old.current_endpoint_id
  if (mode === 'forward' && !endpointID) throw new HttpError(400, 'endpoint_required', '自动投递需要先选择 webhook 目标')
  if (endpointID) await required(env, 'SELECT id FROM webhook_endpoints WHERE id=? AND archived_at IS NULL AND current_revision_id IS NOT NULL', endpointID)
  const sendPaused = 'send_paused' in input ? boolean(input.send_paused, 'send_paused') : old.send_paused
  const policy = policyInput(input, old)
  // Only the fields each new message snapshots bump the policy version.
  const changed = ['raw_retention_days', 'content_retention_days', 'ledger_retention_days'].some(key => policy[key] !== old[key])
  const resolvedChanged = policy.resolved_retention_days !== old.resolved_retention_days
  const shortened = ['raw_retention_days', 'content_retention_days', 'resolved_retention_days'].some(key => policy[key] !== null && (old[key] === null || policy[key] < old[key]))
  const staged = ['raw_retention_days', 'content_retention_days', 'ledger_retention_days', 'resolved_retention_days'].some(key => key in input)
  if (applyExisting || (staged && shortened)) {
    const token = confirmation ? await verifyToken(env, confirmation) : null
    if (token?.kind !== 'lifecycle' || token.owner !== owner || token.version !== expected || token.apply_existing !== applyExisting || Object.keys(policy).some(key => token[key] !== policy[key])) {
      throw new HttpError(400, 'retention_confirmation_required', '启用、缩短或应用历史保留策略前需要预览并确认')
    }
  }
  const policyVersion = old.lifecycle_policy_version + (changed || applyExisting ? 1 : 0), stamp = now()
  // retention_days, the single period before storage-v1, is retired: it keeps its stored value.
  const update = env.DB.prepare(`UPDATE app_settings SET mode=?,current_endpoint_id=?,send_paused=?,lifecycle_policy_version=?,raw_retention_days=?,content_retention_days=?,ledger_retention_days=?,resolved_retention_days=?,version=version+1,updated_at=?
    WHERE id=1 AND version=? AND (? IS NULL OR EXISTS(SELECT 1 FROM webhook_endpoints WHERE id=? AND archived_at IS NULL AND current_revision_id IS NOT NULL))`)
    .bind(mode, endpointID, +sendPaused, policyVersion, policy.raw_retention_days, policy.content_retention_days, policy.ledger_retention_days, policy.resolved_retention_days, stamp, expected, endpointID, endpointID)
  const statements = [update]
  // Adopted history starts every clock after this confirmation, the resolved one included.
  if (applyExisting) statements.push(env.DB.prepare(`UPDATE messages SET retention_policy_version=?,raw_retention_days=?,content_retention_days=?,ledger_retention_days=?,retention_started_at=NULL,
    resolved_at=NULL,lifecycle_due_at=NULL,version=version+1
    WHERE origin='cloudflare' AND retention_policy_version IS NULL AND content_deleted_at IS NULL AND changes()>0`)
    .bind(policyVersion, policy.raw_retention_days, policy.content_retention_days, policy.ledger_retention_days))
  // Re-arm resolved exceptions in the same transaction, only if this very update
  // committed: each gets the lower bound of its due time under the committed
  // period (read in this statement), so the next passes re-evaluate only those
  // that may be due now, and none while disabled.
  if (resolvedChanged) statements.push(env.DB.prepare(`UPDATE messages AS m SET lifecycle_due_at=max(?,${resolvedFloorSQL('m')}) WHERE m.id IN(SELECT id FROM messages INDEXED BY messages_unsettled_idx
    WHERE origin='cloudflare' AND content_deleted_at IS NULL AND retention_started_at IS NULL AND resolved_at IS NOT NULL)
    AND EXISTS(SELECT 1 FROM app_settings WHERE id=1 AND version=? AND updated_at=?)`).bind(stamp, expected + 1, stamp))
  const results = await env.DB.batch(statements)
  if (!results[0].meta.changes) conflict()
  await wake(env)
  return currentSettings(env)
}

export async function overview(env: Env): Promise<Row> {
  const settings = await currentSettings(env)
  const scheduler = await schedulerStatus(env)
  const storage = await lifecycleStorage(env), alerts = await alertOverview(env)
  // Trigger-maintained counters keep this O(1) however much history is stored.
  const counts = await required(env, `SELECT messages,deliveries_pending+deliveries_retry_wait+deliveries_sending pending,
    deliveries_failed failed,deliveries_delivered delivered FROM app_counters WHERE id=1`)
  counts.parse_failed = (await parseStatus(env)).failed
  const warnings: string[] = []
  if (Math.max(settings.logical_bytes, scheduler.capacity?.used_bytes ?? 0) >= settings.logical_limit_bytes * 0.7) warnings.push('邮件内容与预留空间接近配置容量，请检查 R2/D1 用量和保留设置。')
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
  return { receive_address: env.RECEIVE_ADDRESS, counts,
    storage: { logical_bytes: settings.logical_bytes, limit_bytes: settings.logical_limit_bytes, database_bytes: settings.database_bytes,
      pending_physical_delete_bytes: storage.pending_physical_delete_bytes },
    backup: { last_at: settings.last_backup_at }, alerts, send_paused: settings.effective_send_paused, scheduler, warnings }
}

export async function setupStatus(env: Env): Promise<Row> {
  const recent = await required(env, `SELECT max(received_at) last_received_at FROM messages WHERE origin='cloudflare'`)
  const scheduler = await schedulerStatus(env)
  const addressValid = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(env.RECEIVE_ADDRESS ?? '')
  return { receive_address: env.RECEIVE_ADDRESS, address_valid: addressValid, scheduler, ...recent,
    checks: [
      { id: 'address', label: '唯一收信地址', status: addressValid ? 'ok' : 'error', detail: addressValid ? 'Worker 已加载地址；Email Routing 规则需要独立核对。' : '请检查 RECEIVE_ADDRESS。' },
      { id: 'database', label: 'D1 状态数据库', status: 'ok', detail: '本次查询已成功；不代表原邮箱转发已完成。' },
      { id: 'scheduler', label: '持久后台调度', status: !scheduler.available ? 'error' : scheduler.failed > 0 ? 'warning' : 'ok', detail: !scheduler.available ? '本次无法读取 Durable Object 状态。' : `${scheduler.pending} 条待办、${scheduler.failed} 条失败记录；这不是邮件来源的端到端验收。` },
      { id: 'edge', label: 'Email Routing 与 R2', status: 'pending', detail: '请用合成测试邮件验证路由、原件保存和后台解析；仅有配置无法证明真实可达。' },
      { id: 'received', label: '已有收件记录', status: recent.last_received_at ? 'ok' : 'pending', detail: recent.last_received_at ? '已有 Cloudflare 入口邮件记录；来源身份和完整业务链路仍需验收。' : '尚未收到邮件。' },
      { id: 'runtime', label: 'Cloudflare Free 运行限制', status: 'warning', detail: 'Free Worker 请求 CPU 为 10 ms，后台解析通过 Durable Object alarm 执行；大邮件仍需实测。' },
    ] }
}
