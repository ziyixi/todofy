// The owner API's messages (mailhero.ui.v2 Message and MessageContent, and the two downloads): D1 index rows, the
// parsed record in R2, and the actions on a message. Inputs are plain values api-v2.ts read from the request; outputs
// are D1 rows (api-common.ts). Mail is untrusted: nothing here interprets its text.
import type { Env, ParsedMail } from './types'
import { HttpError } from './security.ts'
import { deleteMessageContent, enqueue, requestDelivery } from './pipeline.ts'
import { action, bad, conflict, delivery, finishAction, first, gone, missing, now, paged, required, rows, type Cursor, type Page, type Row } from './api-common.ts'

/** A parsed record as the parser and content policy wrote it (or {} before parsing and after deletion). */
export type ParsedRecord = Partial<ParsedMail> & { needs_review?: boolean; warnings?: string[] }
async function readParsed(env: Env, message: Row): Promise<ParsedRecord> {
  if (!message.parsed_key || message.content_deleted_at) return {}
  const object = await env.MAIL_STORE.get(message.parsed_key)
  if (!object) throw new HttpError(503, 'content_unavailable', '正文对象暂不可用，原件仍保留')
  return object.json<ParsedRecord>()
}

/** The columns of a Message; `delivery_state` is the stored state of the latest delivery, or `unarranged`. */
const messageSelect = `SELECT m.id,COALESCE(m.subject,'') subject,COALESCE(m.from_text,'') "from",m.received_at,m.last_received_at,
  m.arrival_count,m.size_bytes,m.parse_state,COALESCE(NULLIF(m.parse_error,''),m.policy_error) parse_error,m.read_at,m.has_attachment,
  m.content_deleted_at,m.raw_expired_at,m.search_index_truncated,COALESCE(substr(m.search_text,1,160),'') preview,m.envelope_from,
  m.envelope_recipient,m.raw_sha256,m.receive_mode,m.version,
  (SELECT count(*) FROM deliveries WHERE message_id=m.id) delivery_count,
  COALESCE((SELECT state FROM deliveries WHERE message_id=m.id ORDER BY generation DESC LIMIT 1),'unarranged') delivery_state
  FROM messages m`
function messageJSON(row: Row): Row {
  return { ...row, has_attachment: !!row.has_attachment, search_index_truncated: !!row.search_index_truncated }
}

/** The restrictions of ListMessages (api-v2.ts parses its filter into these). */
export interface MessageQuery {
  /** A phrase every match holds, already trimmed and lower-cased; null for none. */
  search: string | null
  /** `unarranged` or a stored delivery state of the latest delivery. */
  deliveryState: string | null
  parseState: string | null
  hasAttachment: boolean | null
  /** Inclusive bounds of received_at (ISO). */
  receivedAfter: string | null
  receivedBefore: string | null
  limit: number
  cursor: Cursor | null
}
export const MESSAGE_SEARCH_MAX = 200
export const DELIVERY_STATES = ['pending', 'sending', 'retry_wait', 'delivered', 'failed', 'cancelled'] as const
export const PARSE_STATES = ['pending', 'parsing', 'ready', 'failed'] as const

export async function listMessages(env: Env, query: MessageQuery): Promise<Page> {
  const conditions = [`m.origin='cloudflare'`]
  const binds: unknown[] = []
  if (query.search) {
    if (Array.from(query.search).length > MESSAGE_SEARCH_MAX) bad('搜索词过长')
    conditions.push(`(instr(lower(COALESCE(m.subject,'')),?)>0 OR instr(lower(COALESCE(m.from_text,'')),?)>0 OR EXISTS(SELECT 1 FROM message_search ms WHERE ms.message_id=m.id AND instr(ms.body,?)>0))`)
    binds.push(query.search, query.search, query.search)
  }
  if (query.deliveryState) {
    conditions.push(`COALESCE((SELECT state FROM deliveries WHERE message_id=m.id ORDER BY generation DESC LIMIT 1),'unarranged')=?`); binds.push(query.deliveryState)
  }
  if (query.parseState) { conditions.push('m.parse_state=?'); binds.push(query.parseState) }
  if (query.hasAttachment !== null) { conditions.push('m.has_attachment=?'); binds.push(query.hasAttachment ? 1 : 0) }
  if (query.receivedAfter) { conditions.push('m.received_at>=?'); binds.push(query.receivedAfter) }
  if (query.receivedBefore) { conditions.push('m.received_at<=?'); binds.push(query.receivedBefore) }
  if (query.cursor) { conditions.push('(m.received_at,m.id)<(?,?)'); binds.push(query.cursor.time, query.cursor.id) }
  binds.push(query.limit + 1)
  const items = await rows(env, `${messageSelect} WHERE ${conditions.join(' AND ')} ORDER BY m.received_at DESC,m.id DESC LIMIT ?`, ...binds)
  return paged(items.map(messageJSON), query.limit, 'received_at', 'id')
}

/** A message received through Email Routing (synthetic test and canary messages are not answered). */
export async function getMessage(env: Env, id: string): Promise<Row> {
  return messageJSON(await required(env, `${messageSelect} WHERE m.id=? AND m.origin='cloudflare'`, id))
}

/** The parsed record of a message: {} before parsing and after the content was deleted. */
export async function readMessageContent(env: Env, id: string): Promise<ParsedRecord> {
  return readParsed(env, await required(env, `SELECT parsed_key,content_deleted_at FROM messages WHERE id=? AND origin='cloudflare'`, id))
}

/** Marks a message read or unread if it is still at `expected` (its version); answers the message. */
export async function markRead(env: Env, id: string, expected: number, read: boolean): Promise<Row> {
  const result = await env.DB.prepare(`UPDATE messages SET read_at=?,version=version+1 WHERE id=? AND version=? AND origin='cloudflare'`)
    .bind(read ? now() : null, id, expected).run()
  if (!result.meta.changes) {
    await getMessage(env, id) // NOT_FOUND first
    conflict()
  }
  return getMessage(env, id)
}

/** Sends a parsed message without a delivery to an endpoint (its current revision); answers the delivery. */
export async function sendMessage(env: Env, owner: string, id: string, endpointID: string, actionID: string): Promise<Row> {
  const entry = await action(env, owner, actionID, 'send', id, endpointID)
  if (entry.result_ref) return delivery(env, entry.result_ref)
  const existing = await first(env, 'SELECT event_id FROM deliveries WHERE action_request_id=? AND message_id=?', actionID, id)
  if (existing) {
    await finishAction(env, entry, existing.event_id, 201)
    return delivery(env, existing.event_id)
  }
  const endpoint = await required(env, 'SELECT current_revision_id FROM webhook_endpoints WHERE id=? AND archived_at IS NULL', endpointID)
  await required(env, `SELECT id FROM messages WHERE id=? AND origin='cloudflare'`, id)
  const eventID = await requestDelivery(env, { kind: 'message', options: { messageID: id, revisionID: endpoint.current_revision_id, actionID, retryMode: 'auto' } })
  await finishAction(env, entry, eventID, 201)
  return delivery(env, eventID)
}

/** Parses a message again (READY or FAILED, raw kept, no delivery); answers the message (PENDING). */
export async function reparseMessage(env: Env, owner: string, id: string, actionID: string): Promise<Row> {
  const entry = await action(env, owner, actionID, 'reparse', id, null)
  if (entry.result_ref) return getMessage(env, id)
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE messages SET parse_state='pending',parse_error=NULL,claim_token=NULL,lease_until=NULL,version=version+1
      WHERE id=? AND origin='cloudflare' AND raw_key IS NOT NULL AND raw_expired_at IS NULL AND content_deleted_at IS NULL AND parse_state IN('ready','failed')
      AND NOT EXISTS(SELECT 1 FROM deliveries WHERE message_id=?) AND EXISTS(SELECT 1 FROM ui_actions WHERE id=? AND result_ref IS NULL)`).bind(id, id, entry.id),
    env.DB.prepare('UPDATE ui_actions SET result_ref=?,http_status=202 WHERE id=? AND changes()>0').bind(id, entry.id),
  ])
  if (!result[0].meta.changes) {
    const completed = await required(env, 'SELECT result_ref FROM ui_actions WHERE id=?', entry.id)
    if (!completed.result_ref) {
      await getMessage(env, id) // NOT_FOUND first
      throw new HttpError(409, 'not_reparsable', '该邮件暂不能重新解析')
    }
  }
  const message = await required(env, 'SELECT raw_key FROM messages WHERE id=?', id)
  await enqueue(env, { type: 'parse', key: message.raw_key })
  return getMessage(env, id)
}

/** Deletes a message's content (if it is still at `expected`); answers the message. */
export async function clearMessageContent(env: Env, owner: string, id: string, expected: number, actionID: string): Promise<Row> {
  const entry = await action(env, owner, actionID, 'delete_content', id, expected)
  if (!entry.result_ref) {
    const message = await required(env, `SELECT content_deleted_at,version FROM messages WHERE id=? AND origin='cloudflare'`, id)
    if (!message.content_deleted_at) await deleteMessageContent(env, id, expected)
    await finishAction(env, entry, id, 200)
  }
  return getMessage(env, id)
}

/**
 * A download: the raw message, or an attachment's stored copy (`part`), streamed from R2 as an attachment with
 * no-store, nosniff and a sandboxing CSP. Not part of mailhero.ui.v2 (bytes up to 25 MiB): api.ts serves it next to the
 * transcoder, an attachment from the coordinator (finding its key reads the whole parsed record).
 */
export async function downloadMessage(env: Env, id: string, part?: string): Promise<Response> {
  const message = await required(env, `SELECT raw_key,parsed_key,raw_expired_at,content_deleted_at FROM messages WHERE id=? AND origin='cloudflare'`, id)
  if (message.content_deleted_at) gone()
  if (part === undefined && message.raw_expired_at) throw new HttpError(410, 'raw_expired', '原件已按保留策略清理；已提取的正文仍可查看')
  let key = message.raw_key, contentType = 'message/rfc822', filename = 'mail-hero-message.eml'
  if (part !== undefined) {
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
