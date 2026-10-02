// The owner API's webhook targets (mailhero.ui.v2 Endpoint): immutable revisions, encrypted credentials, the exact-host
// URL policy (security.ts validateTarget) and the actions on a target. Inputs are plain values api-v2.ts read from the
// request (an update names only the fields it changes); outputs are D1 rows (api-common.ts). The admin bootstrap
// (deploy/configure-webhook.mjs) creates its target through createEndpoint and validateCredential too.
import type { Env } from './types.ts'
import { HttpError, decryptCredential, encryptCredential, validateTarget } from './security.ts'
import { requestDelivery, wake } from './pipeline.ts'
import { action, bad, boolean, conflict, endpointJSON, endpointSelect, finishAction, now, paged, required, rows, type Cursor, type Page, type Row } from './api-common.ts'

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') return bad(`${field} 必须为文字`, 'invalid_target')
  const clean = value.trim()
  if (!clean || new TextEncoder().encode(clean).byteLength > maximum) return bad(`${field} 长度超出范围`, 'invalid_target')
  return clean
}
function integer(value: unknown, field: string, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) return bad(`${field} 超出范围`)
  return value as number
}
export function validateCredential(authType: string, value: unknown): string {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > 4096 || /[\r\n\0]/.test(value)) bad('需要有效认证值，最多 4096 字节', 'invalid_credential')
  if (authType === 'basic' && !(value as string).includes(':')) bad('Basic 值须为 username:password', 'invalid_credential')
  if (authType === 'bearer' && /[^\x21-\x7e]/.test(value as string)) bad('Bearer token 必须是可打印的 ASCII 字符且不能包含空格', 'invalid_credential')
  return value as string
}
/** The target an input describes: each field of `input` (the old row's otherwise), checked. */
function validated(env: Env, input: Row, old?: Row): Row {
  const label = 'label' in input ? text(input.label, '名称', 120) : old?.label
  const target = 'url' in input ? text(input.url, 'URL', 4096) : old?.url
  if (!label || !target) bad('名称和 URL 必填', 'invalid_target')
  const url = validateTarget(env, target).href
  const auth = input.auth_type ?? old?.auth_type ?? 'bearer'
  if (!['bearer', 'basic'].includes(auth)) bad('公网 webhook 必须配置 Bearer 或 Basic 认证', 'auth_required')
  return {
    label, url, auth_type: auth,
    rate_per_minute: integer(input.rate_per_minute ?? old?.rate_per_minute ?? 2, '频率', 60),
    timeout_seconds: integer(input.timeout_seconds ?? old?.timeout_seconds ?? 20, '超时', 120),
    paused: 'paused' in input ? boolean(input.paused, 'paused') : !!old?.paused,
  }
}

/** The live (not archived) targets, newest first. */
export async function listEndpoints(env: Env, limit: number, cursor: Cursor | null): Promise<Page> {
  const items = cursor === null
    ? await rows(env, endpointSelect + ' WHERE e.archived_at IS NULL ORDER BY e.created_at DESC,e.id DESC LIMIT ?', limit + 1)
    : await rows(env, endpointSelect + ' WHERE e.archived_at IS NULL AND (e.created_at,e.id)<(?,?) ORDER BY e.created_at DESC,e.id DESC LIMIT ?', cursor.time, cursor.id, limit + 1)
  return paged(items.map(endpointJSON), limit, 'created_at', 'id')
}

export async function getEndpoint(env: Env, id: string): Promise<Row> {
  return endpointJSON(await required(env, endpointSelect + ' WHERE e.id=? AND e.archived_at IS NULL', id))
}

/**
 * Creates a target with its first revision, once per action ID: `input` has label, url, auth_type, credential and
 * optionally rate_per_minute, timeout_seconds and paused.
 */
export async function createEndpoint(env: Env, owner: string, input: Row, actionID: string): Promise<Row> {
  const value = validated(env, input)
  const credential = validateCredential(value.auth_type, input.credential)
  const entry = await action(env, owner, actionID, 'create_endpoint', '', [value, credential])
  if (entry.result_ref) return endpointJSON(await required(env, endpointSelect + ' WHERE e.id=?', entry.result_ref))
  const id = crypto.randomUUID(), revisionID = crypto.randomUUID(), stamp = now()
  const cipher = await encryptCredential(env, revisionID, value.url, credential)
  // The action claim and both rows commit together. A simultaneous duplicate
  // action cannot create a second endpoint, even after a lost HTTP response.
  await env.DB.batch([
    env.DB.prepare('UPDATE ui_actions SET result_ref=?,http_status=201 WHERE id=? AND result_ref IS NULL').bind(id, entry.id),
    env.DB.prepare(`INSERT INTO webhook_endpoints(id,label,current_revision_id,paused,rate_per_minute,created_at,updated_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ui_actions WHERE id=? AND result_ref=?)`)
      .bind(id, value.label, revisionID, +value.paused, value.rate_per_minute, stamp, stamp, entry.id, id),
    env.DB.prepare(`INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type,credential_ciphertext,credential_key_version,credential_key_id,timeout_ms,created_at)
      SELECT ?,?,1,?,?,?,1,?,?,? WHERE EXISTS(SELECT 1 FROM ui_actions WHERE id=? AND result_ref=?)`)
      .bind(revisionID, id, value.url, value.auth_type, cipher, crypto.randomUUID(), value.timeout_seconds * 1000, stamp, entry.id, id),
  ])
  const result = await required(env, 'SELECT result_ref FROM ui_actions WHERE id=?', entry.id)
  return endpointJSON(await required(env, endpointSelect + ' WHERE e.id=?', result.result_ref))
}

/**
 * Changes the fields `input` holds (label, url, auth_type, credential, rate_per_minute, timeout_seconds, paused) if the
 * target is still at `expected` (its version). A change of URL, authentication, timeout or credential makes a new
 * revision; a new origin or authentication type needs the credential again.
 */
export async function updateEndpoint(env: Env, id: string, input: Row, expected: number): Promise<Row> {
  const old = await required(env, endpointSelect + ' WHERE e.id=? AND e.archived_at IS NULL', id)
  if (old.version !== expected) conflict()
  const value = validated(env, input, old)
  let credential: string
  if ('credential' in input) credential = validateCredential(value.auth_type, input.credential)
  else {
    if (value.auth_type !== old.auth_type || new URL(old.url).origin !== new URL(value.url).origin) bad('新 origin 或认证方式需要重新输入认证值', 'credential_required')
    credential = await decryptCredential(env, old.current_revision_id, old.url, old.credential_ciphertext)
  }
  const changed = value.url !== old.url || value.auth_type !== old.auth_type || value.timeout_seconds !== old.timeout_seconds || 'credential' in input
  const revisionID = changed ? crypto.randomUUID() : old.current_revision_id, stamp = now()
  const statements = [env.DB.prepare(`UPDATE webhook_endpoints SET label=?,current_revision_id=?,paused=?,
    paused_reason=CASE WHEN ?=0 THEN NULL ELSE paused_reason END,rate_per_minute=?,version=version+1,updated_at=?
    WHERE id=? AND version=? AND archived_at IS NULL`)
    .bind(value.label, revisionID, +value.paused, +value.paused, value.rate_per_minute, stamp, id, expected)]
  if (changed) {
    const cipher = await encryptCredential(env, revisionID, value.url, credential)
    statements.push(env.DB.prepare(`INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type,credential_ciphertext,credential_key_version,credential_key_id,timeout_ms,created_at)
      SELECT ?,?,?,?,?,?,1,?,?,? WHERE EXISTS(SELECT 1 FROM webhook_endpoints WHERE id=? AND version=? AND current_revision_id=?)`)
      .bind(revisionID, id, old.revision + 1, value.url, value.auth_type, cipher, crypto.randomUUID(), value.timeout_seconds * 1000, stamp, id, expected + 1, revisionID))
  }
  const results = await env.DB.batch(statements)
  if (!results[0].meta.changes) conflict()
  await wake(env)
  return getEndpoint(env, id)
}

/** Replaces the credential of every revision on the target's origin and authentication type; lifts their auth blocks. */
export async function rotateCredential(env: Env, id: string, credentialInput: string, expected: number): Promise<{ endpoint: Row; affected: number }> {
  const old = await required(env, endpointSelect + ' WHERE e.id=? AND e.archived_at IS NULL', id)
  if (old.version !== expected) conflict()
  if (old.auth_type === 'none') bad('此目标没有可轮换的认证值', 'no_credential')
  const credential = validateCredential(old.auth_type, credentialInput)
  const origin = new URL(old.url).origin
  const revisions = (await rows(env, 'SELECT id,url,auth_type FROM endpoint_revisions WHERE endpoint_id=?', id))
    .filter(item => item.auth_type === old.auth_type && new URL(item.url).origin === origin)
  if (revisions.length > 40) bad('历史认证版本过多，需要分批维护后再轮换', 'too_many_revisions')
  const keyID = crypto.randomUUID(), stamp = now()
  const statements = [env.DB.prepare(`UPDATE webhook_endpoints SET version=version+1,updated_at=? WHERE id=? AND version=? AND archived_at IS NULL`)
    .bind(stamp, id, expected)]
  // The unique key ID provides a batch-local claim. A failed version CAS must
  // not rotate another editor's credentials, even if its version is N+1.
  const marker = `credential_rotation:${id}:${keyID}`
  statements.push(env.DB.prepare('INSERT INTO maintenance(id,value) SELECT ?,? WHERE changes()>0').bind(marker, keyID))
  for (const revision of revisions) {
    let targetAllowed = 0
    try { validateTarget(env, revision.url); targetAllowed = 1 } catch (error) { if (!(error instanceof HttpError)) throw error }
    const cleared = `?=1 AND blocked_reason IN('http_401','http_403','credential_invalid','credential_or_target_invalid','target_policy_invalid')`
    statements.push(env.DB.prepare(`UPDATE endpoint_revisions SET credential_ciphertext=?,credential_key_version=1,credential_key_id=?,
      blocked_reason=CASE WHEN ${cleared} THEN NULL ELSE blocked_reason END,blocked_until=CASE WHEN ${cleared} THEN NULL ELSE blocked_until END,
      blocked_rechecks=CASE WHEN ${cleared} THEN 0 ELSE blocked_rechecks END
      WHERE id=? AND EXISTS(SELECT 1 FROM maintenance WHERE id=? AND value=?)`)
      .bind(await encryptCredential(env, revision.id, revision.url, credential), keyID, targetAllowed, targetAllowed, targetAllowed, revision.id, marker, keyID))
  }
  statements.push(env.DB.prepare('DELETE FROM maintenance WHERE id=?').bind(marker))
  const results = await env.DB.batch(statements)
  if (!results[0].meta.changes) conflict()
  await wake(env)
  return { endpoint: await getEndpoint(env, id), affected: revisions.length }
}

/** Owner override for any block reason. A still-broken target re-blocks on its
 * next attempt with a fresh set of automatic rechecks; events held by a block
 * retry now instead of at their cooldown time, while other waiting events keep
 * their persistent backoff. An action ID (optional) answers a repeated request with the first count. */
export async function unblockEndpoint(env: Env, owner: string, id: string, expected: number, actionID: string | null): Promise<{ endpoint: Row; affected: number }> {
  const entry = actionID === null ? null : await action(env, owner, actionID, 'unblock_endpoint', id, expected)
  if (entry?.result_ref) return { endpoint: await getEndpoint(env, id), affected: Number(entry.result_ref) }
  const old = await required(env, endpointSelect + ' WHERE e.id=? AND e.archived_at IS NULL', id)
  if (old.version !== expected) conflict()
  const stamp = now(), marker = `endpoint_unblock:${id}:${crypto.randomUUID()}`
  // As in rotation, a batch-local marker proves this request won the version CAS.
  const claimed = 'EXISTS(SELECT 1 FROM maintenance WHERE id=?)'
  const statements = [
    env.DB.prepare('UPDATE webhook_endpoints SET version=version+1,updated_at=? WHERE id=? AND version=? AND archived_at IS NULL').bind(stamp, id, expected),
    env.DB.prepare('INSERT INTO maintenance(id,value) SELECT ?,? WHERE changes()>0').bind(marker, stamp),
    // Runs before the revisions are cleared, so it still sees which ones were blocked.
    env.DB.prepare(`UPDATE deliveries SET blocking_since=NULL,next_attempt_at=CASE WHEN next_attempt_at>?
      AND endpoint_revision_id IN(SELECT id FROM endpoint_revisions WHERE endpoint_id=? AND blocked_reason IS NOT NULL) THEN ? ELSE next_attempt_at END
      WHERE state IN('pending','retry_wait') AND endpoint_revision_id IN(SELECT id FROM endpoint_revisions WHERE endpoint_id=?) AND ${claimed}`).bind(stamp, id, stamp, id, marker),
    env.DB.prepare(`UPDATE endpoint_revisions SET blocked_reason=NULL,blocked_until=NULL,blocked_rechecks=0 WHERE endpoint_id=? AND blocked_reason IS NOT NULL AND ${claimed}`).bind(id, marker),
  ]
  // changes() still refers to the revision update, so a lost response replays its count.
  if (entry) statements.push(env.DB.prepare(`UPDATE ui_actions SET result_ref=CAST(changes() AS TEXT),http_status=200 WHERE id=? AND result_ref IS NULL AND ${claimed}`).bind(entry.id, marker))
  statements.push(env.DB.prepare('DELETE FROM maintenance WHERE id=?').bind(marker))
  const results = await env.DB.batch(statements)
  if (!results[0].meta.changes) conflict()
  await wake(env)
  return { endpoint: await getEndpoint(env, id), affected: Number(results[3].meta.changes) || 0 }
}

/** The static URL policy for the target's URI: whether it passes. Workers has no origin-pinning resolver, so a policy
 * check is deliberately not reported as a completed DNS, TLS or consumer acceptance test. */
export async function checkEndpoint(env: Env, id: string): Promise<boolean> {
  const endpoint = await required(env, endpointSelect + ' WHERE e.id=? AND e.archived_at IS NULL', id)
  try { validateTarget(env, endpoint.url) } catch (error) { if (!(error instanceof HttpError)) throw error; return false }
  return true
}

/** Sends a synthetic connection-test event to the target's current revision, once per action ID; answers its event ID. */
export async function testEndpoint(env: Env, owner: string, id: string, actionID: string): Promise<string> {
  const entry = await action(env, owner, actionID, 'test_endpoint', id, null)
  if (entry.result_ref) return entry.result_ref
  const endpoint = await required(env, endpointSelect + ' WHERE e.id=? AND e.archived_at IS NULL', id)
  const eventID = await requestDelivery(env, { kind: 'connection_test', revisionID: endpoint.current_revision_id, actionID })
  await finishAction(env, entry, eventID, 202)
  return eventID
}
