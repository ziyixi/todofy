import type { Env, ParsedMail } from './types'
import { HttpError, json } from './security.ts'
import { createDelivery, deleteMessageContent, enqueue } from './pipeline.ts'
import { action, bad, body, conflict, delivery, deliveryJSON, deliverySelect, finishAction, first, gone, missing, now, page, paged, required, rows, uuid, version, type Row } from './api-common.ts'
import { deliveryRange } from './api-delivery-stats.ts'

type PreviewMail = Partial<ParsedMail> & { needs_review?: boolean; warnings?: string[] }
async function readParsed(env: Env, message: Row): Promise<PreviewMail> {
  if (!message.parsed_key || message.content_deleted_at) return {}
  const object = await env.MAIL_STORE.get(message.parsed_key)
  if (!object) throw new HttpError(503, 'content_unavailable', '正文对象暂不可用，原件仍保留')
  return object.json<PreviewMail>()
}
function attachmentJSON(item: Row) {
  const { r2_key, ...rest } = item
  return { ...rest, size_bytes: rest.size_bytes ?? rest.size }
}
export async function listMessages(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams
  const { limit, time, id } = page(params)
  const q = (params.get('q') || '').trim().toLocaleLowerCase()
  if (Array.from(q).length > 200) bad('搜索词过长')
  const conditions = [`m.origin='cloudflare'`]
  const binds: any[] = []
  if (q) {
    conditions.push(`(instr(lower(COALESCE(m.subject,'')),?)>0 OR instr(lower(COALESCE(m.from_text,'')),?)>0 OR EXISTS(SELECT 1 FROM message_search ms WHERE ms.message_id=m.id AND instr(ms.body,?)>0))`)
    binds.push(q, q, q)
  }
  const status = params.get('status')
  if (status) {
    if (!['pending', 'sending', 'retry_wait', 'delivered', 'failed', 'cancelled', 'unarranged'].includes(status)) bad('status 无效')
    conditions.push(`COALESCE((SELECT state FROM deliveries WHERE message_id=m.id ORDER BY generation DESC LIMIT 1),'unarranged')=?`); binds.push(status)
  }
  const parse = params.get('parse_state')
  if (parse) {
    if (!['pending', 'parsing', 'ready', 'failed'].includes(parse)) bad('parse_state 无效')
    conditions.push('m.parse_state=?'); binds.push(parse)
  }
  const attachment = params.get('has_attachment')
  if (attachment !== null && attachment !== '') {
    if (attachment !== 'true' && attachment !== 'false') bad('has_attachment 无效')
    conditions.push('m.has_attachment=?'); binds.push(attachment === 'true' ? 1 : 0)
  }
  for (const [parameter, comparison] of [['received_after', '>='], ['received_before', '<=']]) {
    const date = params.get(parameter)
    if (date) {
      if (!Number.isFinite(Date.parse(date))) bad('时间参数无效')
      conditions.push(`m.received_at${comparison}?`); binds.push(new Date(date).toISOString())
    }
  }
  if (time) { conditions.push('(m.received_at,m.id)<(?,?)'); binds.push(time, id) }
  binds.push(limit + 1)
  const items = await rows(env, `SELECT m.id,COALESCE(m.subject,'') subject,COALESCE(m.from_text,'') "from",m.received_at,
    m.parse_state,m.size_bytes,m.read_at,m.has_attachment,m.content_deleted_at,m.arrival_count,m.search_index_truncated,COALESCE(substr(m.search_text,1,160),'') preview,
    (SELECT count(*) FROM deliveries WHERE message_id=m.id) delivery_count,
    COALESCE((SELECT state FROM deliveries WHERE message_id=m.id ORDER BY generation DESC LIMIT 1),'unarranged') delivery_state
    FROM messages m WHERE ${conditions.join(' AND ')} ORDER BY m.received_at DESC,m.id DESC LIMIT ?`, ...binds)
  return json(paged(items.map(item => ({ ...item, has_attachment: !!item.has_attachment, search_index_truncated: !!item.search_index_truncated })), limit, 'received_at', 'id'))
}

export async function messageRoute(request: Request, env: Env, owner: string, id: string, sub: string, part?: string): Promise<Response> {
  uuid(id)
  const method = request.method
  if (method === 'GET' && !sub) {
    const value = await required(env, `SELECT * FROM messages WHERE id=? AND origin='cloudflare'`, id)
    const parsed = await readParsed(env, value)
    const deliveries = (await rows(env, deliverySelect + ' WHERE d.message_id=? ORDER BY d.generation DESC', id)).map(item => deliveryJSON(env, item))
    return json({ message: {
      id, version: value.version, subject: value.subject || '', from: value.from_text || '', to: parsed.to || [],
      text: parsed.text || '', html: parsed.html || '', headers: parsed.headers || [], attachments: (parsed.attachments || []).map(attachmentJSON),
      sent_at: parsed.sent_at || null, rfc_message_id: parsed.rfc_message_id || null,
      envelope_from: value.envelope_from, envelope_to: value.envelope_recipient, parse_state: value.parse_state,
      parse_error: value.parse_error || value.policy_error, delivery_state: deliveries[0]?.effective_state || 'unarranged',
      received_at: value.received_at, last_received_at: value.last_received_at, arrival_count: value.arrival_count,
      size_bytes: value.size_bytes, raw_expired_at: value.raw_expired_at, content_deleted_at: value.content_deleted_at, read_at: value.read_at,
      has_attachment: !!value.has_attachment, raw_sha256: value.raw_sha256, action_snapshot: value.receive_mode,
      search_index_truncated: !!value.search_index_truncated,
      needs_review: !!parsed.needs_review, warnings: parsed.warnings || [],
      text_truncated: !!parsed.text_truncated, original_text_bytes: parsed.original_text_bytes,
      html_omitted: !!parsed.html_omitted, attachments_omitted_count: parsed.attachments_omitted_count || 0,
      content_policy_version: parsed.content_policy_version,
    }, deliveries })
  }
  if (method === 'PATCH' && !sub) {
    const input = await body(request); const expected = version(input.version)
    if (typeof input.read !== 'boolean') bad('read 必须为布尔值')
    const readAt = input.read ? now() : null
    const result = await env.DB.prepare(`UPDATE messages SET read_at=?,version=version+1 WHERE id=? AND version=? AND origin='cloudflare'`).bind(readAt, id, expected).run()
    if (!result.meta.changes) conflict()
    return json({ read_at: readAt, version: expected + 1 })
  }
  if (method === 'GET' && (sub === 'raw' || sub === 'attachments')) {
    const message = await required(env, `SELECT raw_key,parsed_key,raw_expired_at,content_deleted_at FROM messages WHERE id=? AND origin='cloudflare'`, id)
    if (message.content_deleted_at) gone()
    if (sub === 'raw' && message.raw_expired_at) throw new HttpError(410, 'raw_expired', '原件已按保留策略清理；已提取的正文仍可查看')
    let key = message.raw_key, contentType = 'message/rfc822', filename = 'mail-hero-message.eml'
    if (sub === 'attachments') {
      const parsed = await readParsed(env, message)
      const attachment = parsed.attachments?.find(item => item.part_id === part)
      if (!attachment) missing()
      if (attachment!.storage_status === 'omitted' || !attachment!.r2_key) throw new HttpError(410, 'attachment_omitted', '该附件未保存独立副本')
      key = attachment!.r2_key; contentType = attachment!.content_type; filename = attachment!.filename || 'attachment'
    }
    if (!key) gone()
    const object = await env.MAIL_STORE.get(key)
    if (!object) throw new HttpError(503, 'content_unavailable', '内容对象暂不可用')
    return new Response(object.body, { headers: {
      'Content-Type': contentType || 'application/octet-stream', 'Content-Length': String(object.size),
      'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename).replaceAll("'", '%27')}`,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    } })
  }
  if (method === 'POST' && sub === 'send') {
    const input = await body(request)
    const endpointID = uuid(input.endpoint_id, 'endpoint_id')
    const entry = await action(env, owner, input.action_request_id, 'send', id, endpointID)
    if (entry.result_ref) return json(await delivery(env, entry.result_ref), 201)
    const existing = await first(env, 'SELECT event_id FROM deliveries WHERE action_request_id=? AND message_id=?', input.action_request_id, id)
    if (existing) {
      await finishAction(env, entry, existing.event_id, 201)
      return json(await delivery(env, existing.event_id), 201)
    }
    const endpoint = await required(env, 'SELECT current_revision_id FROM webhook_endpoints WHERE id=? AND archived_at IS NULL', endpointID)
    await required(env, `SELECT id FROM messages WHERE id=? AND origin='cloudflare'`, id)
    const eventID = await createDelivery(env, { messageID: id, revisionID: endpoint.current_revision_id, actionID: input.action_request_id, retryMode: 'auto' })
    await finishAction(env, entry, eventID, 201)
    return json(await delivery(env, eventID), 201)
  }
  if (method === 'POST' && sub === 'reparse') {
    const input = await body(request)
    const entry = await action(env, owner, input.action_request_id, 'reparse', id, null)
    if (entry.result_ref) return json({ status: 'pending' }, 202)
    const stamp = now()
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE messages SET parse_state='pending',parse_error=NULL,claim_token=NULL,lease_until=NULL,version=version+1
        WHERE id=? AND origin='cloudflare' AND raw_key IS NOT NULL AND raw_expired_at IS NULL AND content_deleted_at IS NULL AND parse_state IN('ready','failed')
        AND NOT EXISTS(SELECT 1 FROM deliveries WHERE message_id=?) AND EXISTS(SELECT 1 FROM ui_actions WHERE id=? AND result_ref IS NULL)`).bind(id, id, entry.id),
      env.DB.prepare('UPDATE ui_actions SET result_ref=?,http_status=202 WHERE id=? AND changes()>0').bind(id, entry.id),
    ])
    if (!result[0].meta.changes) {
      const completed = await required(env, 'SELECT result_ref FROM ui_actions WHERE id=?', entry.id)
      if (!completed.result_ref) conflict('该邮件暂不能重新解析')
    }
    const message = await required(env, 'SELECT raw_key FROM messages WHERE id=?', id)
    await enqueue(env, { type: 'parse', key: message.raw_key })
    return json({ status: 'pending', queued_at: stamp }, 202)
  }
  if (method === 'DELETE' && sub === 'content') {
    const input = await body(request); const expected = version(input.version)
    const entry = await action(env, owner, input.action_request_id, 'delete_content', id, expected)
    if (!entry.result_ref) {
      const message = await required(env, `SELECT content_deleted_at,version FROM messages WHERE id=? AND origin='cloudflare'`, id)
      if (!message.content_deleted_at) await deleteMessageContent(env, id, expected)
      await finishAction(env, entry, id, 200)
    }
    return json({ deleted: true })
  }
  return missing()
}

export async function listDeliveries(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams
  const { limit, time, id } = page(params)
  const status = params.get('status') || ''
  if (status && !['pending', 'sending', 'retry_wait', 'delivered', 'failed', 'cancelled'].includes(status)) bad('status 无效')
  const outcome = params.get('attempt_outcome') || ''
  const outcomeSQL: Record<string, string> = {
    succeeded: "a.outcome='delivered'", retried: "a.outcome='retryable'",
    failed: "a.outcome IN('rejected','failed')", unknown: "a.outcome='interrupted'",
  }
  if (outcome && !Object.hasOwn(outcomeSQL, outcome)) bad('attempt_outcome 无效')
  if (!outcome && (params.has('from') || params.has('to'))) bad('按完成时间筛选需要 attempt_outcome')
  if (outcome && (!params.has('from') || !params.has('to'))) bad('按尝试结果筛选需要 from 和 to')
  // One event may have several matching attempts. Materializing distinct IDs
  // keeps the drill-down list distinct, while the chart counts attempts.
  const range = outcome ? deliveryRange(params) : null
  const matching = range ? ` JOIN (
    SELECT DISTINCT a.event_id FROM delivery_attempts a
    WHERE a.finished_at>=? AND a.finished_at<? AND ${outcomeSQL[outcome]}
  ) matched ON matched.event_id=d.event_id` : ''
  const binds: unknown[] = range ? [range.from, range.to] : []
  const conditions: string[] = []
  if (range) conditions.push("m.origin='cloudflare'")
  if (status) { conditions.push('d.state=?'); binds.push(status) }
  if (time) { conditions.push('(d.created_at,d.event_id)<(?,?)'); binds.push(time, id) }
  binds.push(limit + 1)
  const items = await rows(env, deliverySelect + matching + ` ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY d.created_at DESC,d.event_id DESC LIMIT ?`, ...binds)
  return json({ ...paged(items.map(item => deliveryJSON(env, item)), limit, 'created_at', 'event_id'),
    ...(range ? { count_semantics: 'distinct_delivery_events' } : {}) })
}

export async function deliveryRoute(request: Request, env: Env, owner: string, id: string, sub: string): Promise<Response> {
  uuid(id)
  if (request.method === 'GET' && !sub) {
    const value = await delivery(env, id)
    const record = await required(env, 'SELECT payload_key,payload_sha256 FROM deliveries WHERE event_id=?', id)
    let payload = null
    if (record.payload_key && !value.content_deleted) {
      const object = await env.MAIL_STORE.get(record.payload_key)
      if (!object) throw new HttpError(503, 'payload_unavailable', '冻结请求对象暂不可用')
      payload = await object.json()
    }
    const attempts = await rows(env, 'SELECT * FROM delivery_attempts WHERE event_id=? ORDER BY attempt_no DESC', id)
    return json({ delivery: value, payload, payload_sha256: record.payload_sha256, attempts })
  }
  if (request.method !== 'POST' || !['retry', 'cancel', 'replay'].includes(sub)) return missing()
  const input = await body(request)
  if (sub === 'replay') {
    const endpointID = uuid(input.endpoint_id, 'endpoint_id'), expected = version(input.message_version)
    const entry = await action(env, owner, input.action_request_id, 'replay', id, [endpointID, expected])
    if (entry.result_ref) return json(await delivery(env, entry.result_ref), 201)
    const existing = await first(env, 'SELECT event_id FROM deliveries WHERE action_request_id=? AND replay_of_event_id=?', input.action_request_id, id)
    if (existing) {
      await finishAction(env, entry, existing.event_id, 201)
      return json(await delivery(env, existing.event_id), 201)
    }
    const previous = await required(env, 'SELECT message_id FROM deliveries WHERE event_id=?', id)
    const endpoint = await required(env, 'SELECT current_revision_id FROM webhook_endpoints WHERE id=? AND archived_at IS NULL', endpointID)
    const eventID = await createDelivery(env, { messageID: previous.message_id, revisionID: endpoint.current_revision_id, actionID: input.action_request_id, replayOf: id, expectedMessageVersion: expected, retryMode: 'auto' })
    await finishAction(env, entry, eventID, 201)
    return json(await delivery(env, eventID), 201)
  }
  const entry = await action(env, owner, input.action_request_id, sub, id, null)
  if (!entry.result_ref) {
    const expected = await required(env, 'SELECT * FROM deliveries WHERE event_id=?', id)
    if (sub === 'retry' && (!expected.payload_key || Date.parse(expected.created_at) < Date.now() - 30 * 86400000)) conflict('内容不可用或事件重试期限已过')
    const result = await env.DB.batch([
      env.DB.prepare(sub === 'retry'
        ? `UPDATE deliveries SET state='pending',retry_mode='once',next_attempt_at=?,last_error=NULL WHERE event_id=? AND state IN('failed','retry_wait','cancelled') AND payload_key IS NOT NULL AND EXISTS(SELECT 1 FROM ui_actions WHERE id=? AND result_ref IS NULL) AND EXISTS(SELECT 1 FROM messages WHERE id=deliveries.message_id AND content_deleted_at IS NULL)`
        : `UPDATE deliveries SET state='cancelled',last_error='cancelled_by_owner' WHERE ? IS NOT NULL AND event_id=? AND state IN('pending','retry_wait','failed') AND EXISTS(SELECT 1 FROM ui_actions WHERE id=? AND result_ref IS NULL)`)
        .bind(now(), id, entry.id),
      env.DB.prepare('UPDATE ui_actions SET result_ref=?,http_status=? WHERE id=? AND changes()>0').bind(id, sub === 'retry' ? 202 : 200, entry.id),
      // A retry or cancel is a handling that may end without an attempt time of
      // its own: the resolved-exception clock restarts when the lifecycle next
      // sees the message resolved.
      env.DB.prepare('UPDATE messages SET resolved_at=NULL WHERE id=(SELECT message_id FROM deliveries WHERE event_id=?) AND resolved_at IS NOT NULL AND changes()>0').bind(id),
    ])
    if (!result[0].meta.changes) {
      const completed = await required(env, 'SELECT result_ref FROM ui_actions WHERE id=?', entry.id)
      if (!completed.result_ref) conflict(sub === 'cancel' ? '发送中或已完成的事件无法取消' : '该事件暂不能重试')
    }
  }
  if (sub === 'retry') await enqueue(env, { type: 'deliver', eventID: id })
  return json(await delivery(env, id), sub === 'retry' ? 202 : 200)
}
