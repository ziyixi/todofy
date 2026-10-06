// The HTTP surface of mailhero.ui.v2 (src/native/api.ts, api-v2.ts): the old /api/v1 paths, the transcoder's
// transport behaviour behind Mail Hero's authentication, the two downloads, error bodies and logs, the write lease, and
// the typed client the UI uses. (The maintenance check in front of authentication is index.ts's: native-runtime.test.mjs.) Real SQLite with the production migrations (test/native-env.mjs); synthetic data only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createHttpClient, RpcStatusError } from '@ziyixi/proto/http-client'
import { MailHeroUiService } from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import { Delivery_State, DeliveryAttempt_Outcome } from '@ziyixi/proto/mailhero/ui/v2/delivery_pb'
import { handleAPI, handleDelegated } from '../src/native/api.ts'
import { codeReason, fromHttpError } from '../src/native/api-v2.ts'
import { HttpError } from '../src/native/security.ts'
import { idOf, query, quote, reasonOf, sendMessage } from './owner-api.mjs'
import { endpoint, environment, message, session } from './native-env.mjs'

const ORIGIN = 'http://127.0.0.1:8787'
const get = (env, path, init = {}) => handleAPI(new Request(`${ORIGIN}${path}`, init), env)

test('every /api/v1 path answers 410 reload_required in the old envelope, after Access', async () => {
  const env = environment()
  for (const [method, path] of [['GET', '/api/v1/settings'], ['GET', '/api/v1/csrf'], ['PATCH', '/api/v1/settings'], ['GET', `/api/v1/messages/${crypto.randomUUID()}/raw`], ['GET', '/api/v1']]) {
    const response = await get(env, path, { method })
    assert.equal(response.status, 410, path)
    const body = await response.json()
    assert.deepEqual(Object.keys(body.error), ['code', 'message', 'request_id'])
    assert.deepEqual([body.error.code, body.error.message], ['reload_required', 'Mail Hero 已更新，请刷新页面'])
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/)
  }
  // Without a login, the old envelope as the old API answered it: nothing is said about the new API.
  delete env.DEV_AUTH_BYPASS
  const refused = await handleAPI(new Request('https://mail.example.org/api/v1/settings'), env)
  assert.equal(refused.status, 401)
  assert.deepEqual([(await refused.json()).error.code], ['unauthorized'])
  const v2 = await handleAPI(new Request('https://mail.example.org/api/v2/settings'), env)
  assert.equal(v2.status, 401)
  assert.equal(reasonOf(await v2.json()), 'UNAUTHORIZED')
  assert.equal((await handleAPI(new Request('https://mail.example.org/api/csrf'), env)).status, 401)
})

test('the transcoder behind Access: Status errors, 405 with Allow, OPTIONS, HEAD, strict reads and the body limit', async () => {
  const env = environment(), api = await session(env)
  const notFound = await api('GET', '/nothing')
  assert.deepEqual([notFound.status, reasonOf(notFound.data)], [404, 'NOT_FOUND'])
  assert.equal((await get(env, '/api/other')).status, 404)
  const wrong = await api('PUT', '/settings', {})
  assert.deepEqual([wrong.status, wrong.response.headers.get('allow'), reasonOf(wrong.data)], [405, 'GET, HEAD, PATCH, OPTIONS', 'METHOD_NOT_ALLOWED'])
  const options = await api('OPTIONS', '/settings')
  assert.deepEqual([options.status, options.response.headers.get('allow'), options.response.headers.get('access-control-allow-origin')], [204, 'GET, HEAD, PATCH, OPTIONS', null])
  const head = await api('HEAD', '/settings')
  assert.deepEqual([head.status, head.data], [200, ''])
  for (const [method, path, body] of [['GET', '/settings?unknown=1'], ['GET', '/messages?limit=50'], ['PATCH', '/settings?update_mask=send_paused', { etag: '1', send_paused: true, unknown: 1 }],
    ['PATCH', '/settings?update_mask=nothing', { etag: '1' }], ['PATCH', '/settings?update_mask=send_paused', { etag: 'v1', send_paused: true }],
    ['PATCH', '/settings?update_mask=mode', { etag: '1', mode: 'unknown' }], ['POST', `/messages/${crypto.randomUUID()}:send`, { endpoint: 'endpoints/x', request_id: crypto.randomUUID() }],
    ['POST', `/messages/${crypto.randomUUID()}:send`, { endpoint: `endpoints/${crypto.randomUUID()}`, request_id: 'not-a-uuid' }], ['GET', '/messages/not-a-uuid']]) {
    const result = await api(method, path, body)
    assert.deepEqual([result.status, reasonOf(result.data)], [400, 'BAD_REQUEST'], `${method} ${path}`)
  }
  const large = await api('PATCH', '/settings?update_mask=send_paused', JSON.stringify({ etag: '1', send_paused: true, padding: 'x'.repeat(70_000) }))
  assert.deepEqual([large.status, reasonOf(large.data)], [400, 'BAD_REQUEST'])
  // A Status body: the code, the google.rpc.Code name, the reason with the API's domain, Chinese copy, the request ID.
  const missing = await api('GET', `/messages/${crypto.randomUUID()}`)
  assert.equal(missing.status, 404)
  assert.equal(missing.data.error.status, 'NOT_FOUND')
  assert.deepEqual(missing.data.error.details.map(detail => detail['@type'].split('/')[1]), ['google.rpc.ErrorInfo', 'google.rpc.LocalizedMessage', 'google.rpc.RequestInfo'])
  assert.equal(missing.data.error.details[0].domain, 'mail-hero.ziyixi.science')
  assert.equal(missing.data.error.details[1].message, '记录不存在')
  assert.match(missing.data.error.details[2].request_id, /^[0-9a-f]{16}$/)
})

/** Every code src/native throws as an HttpError: its own calls, the pipeline's error(), api-common's bad() and the policy rules. */
function thrownCodes() {
  const codes = new Set(['invalid_request']) // bad(message) without a code
  const dir = new URL('../src/native/', import.meta.url)
  for (const file of readdirSync(dir).filter(name => name.endsWith('.ts'))) {
    const source = readFileSync(new URL(file, dir), 'utf8')
    for (const pattern of [/new HttpError\(\s*\d+\s*,\s*'([a-z0-9_]+)'/g, /\berror\(\s*\d+\s*,\s*'([a-z0-9_]+)'\s*\)/g, /\bbad\([^()]*,\s*'([a-z0-9_]+)'\s*\)/g]) {
      for (const match of source.matchAll(pattern)) codes.add(match[1])
    }
    for (const match of source.matchAll(/\bpolicyError\([^()]*,\s*'([a-z_]+)'\s*\)/g)) codes.add(`retention_${match[1]}`)
  }
  return codes
}

test('every code the modules and the pipeline throw maps to its own reason; an unmapped code is INTERNAL, never guessed', () => {
  // The backup machine API's own authentication (backup.ts): never reaches the owner API, whose errors it does not use.
  const machine = new Set(['backup_unauthorized', 'backup_unconfigured'])
  const codes = thrownCodes()
  assert.ok(codes.size >= 45, `found ${codes.size} codes: the scan lost its patterns`)
  for (const code of ['etag_mismatch', 'version_conflict', 'message_not_ready', 'retention_days_range', 'invalid_time_range', 'unauthorized']) assert.ok(codes.has(code), code)
  for (const code of codes) {
    if (machine.has(code)) continue
    assert.notEqual(codeReason(code), null, `${code} has no reason: name it in api-v2.ts ALIASES or errors.proto`)
  }
  // An unknown code is INTERNAL whatever its status: a new 409 is not a stale etag, a new 400 not the caller's fault.
  for (const status of [400, 404, 409, 422, 503]) {
    const error = fromHttpError(new HttpError(status, 'some_new_code', 'x'))
    assert.deepEqual([error.reason, error.httpStatus], ['INTERNAL', 500], String(status))
  }
  for (const code of ['constructor', 'toString', '__proto__', 'INTERNAL', 'internal', 'Etag_mismatch', 'retention_other']) assert.equal(codeReason(code), null, code)
  assert.deepEqual([codeReason('version_conflict'), codeReason('etag_mismatch'), codeReason('retention_ledger_minimum')], ['ETAG_MISMATCH', 'ETAG_MISMATCH', 'INVALID_RETENTION_POLICY'])
  const gone = fromHttpError(new HttpError(410, 'raw_expired', 'x'), true)
  assert.deepEqual([gone.reason, gone.httpStatus], ['RAW_EXPIRED', 410])
  const rule = fromHttpError(new HttpError(400, 'retention_raw_after_content', 'x'))
  assert.deepEqual([rule.reason, rule.metadata], ['INVALID_RETENTION_POLICY', { rule: 'raw_after_content' }])
})

test('a refused request logs one line of its request ID, status and reason, nothing of the request', async t => {
  const env = environment(), api = await session(env), lines = []
  t.mock.method(console, 'log', line => lines.push(line))
  const secret = 'secret-search-text'
  await api('GET', `/messages${query({ filter: `${quote(secret)} OR x` })}`)
  await api('GET', '/settings')
  assert.equal(lines.length, 1)
  assert.deepEqual(Object.keys(JSON.parse(lines[0])), ['request_id', 'status', 'reason'])
  assert.deepEqual([JSON.parse(lines[0]).status, JSON.parse(lines[0]).reason], [400, 'BAD_REQUEST'])
  assert.equal(lines[0].includes(secret), false)
})

test('mutations run under the coordinator write lease: a backup snapshot refuses them, reads go on', async () => {
  const env = environment(), api = await session(env)
  const get = env.COORDINATOR.get
  let leases = 0
  env.COORDINATOR.get = id => {
    const stub = get(id)
    return { fetch: (url, init) => {
      const path = new URL(url).pathname
      if (path === '/mutation/begin') { leases++; return new Response(null, { status: 409 }) }
      return stub.fetch(url, init)
    } }
  }
  const refused = await api('PATCH', '/settings?update_mask=send_paused', { etag: '1', send_paused: true })
  assert.deepEqual([refused.status, reasonOf(refused.data)], [503, 'BACKUP_IN_PROGRESS'])
  assert.equal(leases, 1)
  assert.equal((await api('GET', '/settings')).data.send_paused, undefined, 'nothing changed')
  assert.equal(leases, 1, 'a read takes no lease')
})

test('downloads stream the raw message and stored attachments with the private headers; gone content is 410', async () => {
  const env = environment(), api = await session(env)
  const id = await message(env, { parsed: { attachments: [
    { part_id: '1.2', filename: '报告 "季度".pdf', content_type: 'application/pdf', size: 5, storage_status: 'stored', r2_key: 'parsed/x/attachment-1' },
    { part_id: '1.3', filename: 'big.bin', content_type: 'application/octet-stream', size: 3_000_000, storage_status: 'omitted', omitted_reason: 'size_limit' },
  ] } })
  await env.MAIL_STORE.put('parsed/x/attachment-1', 'bytes')
  // An attachment's key is in the parsed record (up to about 4 MiB of JSON): the coordinator streams it, never the raw message.
  const forwarded = []
  const coordinator = env.COORDINATOR.get
  env.COORDINATOR.get = name => {
    const stub = coordinator(name)
    return { fetch: (url, init) => { if (new URL(url).pathname.startsWith('/owner-api/')) forwarded.push(new URL(url).pathname); return stub.fetch(url, init) } }
  }
  const content = (await api('GET', `/messages/${id}/content`)).data
  assert.deepEqual(content.attachments, [
    { part_id: '1.2', filename: '报告 "季度".pdf', mime_type: 'application/pdf', size_bytes: 5, storage_state: 'stored', download_uri: `/api/v2/messages/${id}/attachments/1.2` },
    { part_id: '1.3', filename: 'big.bin', mime_type: 'application/octet-stream', size_bytes: 3000000, storage_state: 'omitted', omitted_reason: 'size_limit' },
  ])
  const file = await get(env, content.attachments[0].download_uri)
  assert.equal(file.status, 200)
  assert.equal(await file.text(), 'bytes')
  assert.deepEqual(['content-type', 'content-disposition', 'cache-control', 'x-content-type-options', 'content-length'].map(name => file.headers.get(name)),
    ['application/pdf', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent('报告 "季度".pdf')}`, 'no-store', 'nosniff', '5'])
  assert.match(file.headers.get('content-security-policy'), /^default-src 'self'/, 'the private headers of every response, as before')
  for (const [path, status, reason] of [
    [`/api/v2/messages/${id}/attachments/1.3`, 410, 'ATTACHMENT_OMITTED'], [`/api/v2/messages/${id}/attachments/9`, 404, 'NOT_FOUND'],
    [`/api/v2/messages/${crypto.randomUUID()}/raw`, 404, 'NOT_FOUND'], ['/api/v2/messages/nope/raw', 400, 'BAD_REQUEST'],
    [`/api/v2/messages/${id}/attachments/%E0%A4%A`, 400, 'BAD_REQUEST'], [`/api/v2/messages/${id}/raw?x=1`, 400, 'BAD_REQUEST'],
  ]) {
    const response = await get(env, path)
    assert.deepEqual([response.status, reasonOf(await response.json())], [status, reason], path)
  }
  assert.deepEqual(forwarded, [`/owner-api/api/v2/messages/${id}/content`, `/owner-api/api/v2/messages/${id}/attachments/1.2`,
    `/owner-api/api/v2/messages/${id}/attachments/1.3`, `/owner-api/api/v2/messages/${id}/attachments/9`], 'the Worker refuses a bad path itself and serves the raw message')
  const post = await get(env, `/api/v2/messages/${id}/raw`, { method: 'POST' })
  assert.deepEqual([post.status, post.headers.get('allow')], [405, 'GET'])
  const postAttachment = await get(env, `/api/v2/messages/${id}/attachments/1.2`, { method: 'POST' })
  assert.deepEqual([postAttachment.status, postAttachment.headers.get('allow')], [405, 'GET'])
  assert.equal(forwarded.length, 4, 'a refused method is not forwarded')
  await env.DB.prepare("UPDATE messages SET raw_expired_at='2026-09-01T00:00:00.000Z' WHERE id=?").bind(id).run()
  const expired = await get(env, `/api/v2/messages/${id}/raw`)
  assert.deepEqual([expired.status, reasonOf(await expired.json())], [410, 'RAW_EXPIRED'])
  assert.equal((await api('GET', `/messages/${id}`)).data.raw_download_uri, undefined)
  assert.equal((await get(env, content.attachments[0].download_uri)).status, 200, 'attachments outlive the raw message')
})

test('message content maps the parsed record, older shapes included, and shows warnings as codes', async () => {
  const env = environment(), api = await session(env)
  const id = await message(env, { parsed: {
    to: [{ address: 'a@example.org', name: 'A' }, 'b@example.org'], headers: [{ key: 'subject', value: 'x' }], sent_at: '2026-09-30T10:00:00.000Z',
    rfc_message_id: '<id@example.org>', html: '<p>x</p>', needs_review: true, warnings: ['attached_or_opaque_message', 'a_future_code'],
    text_truncated: true, original_text_bytes: 2_000_000, html_omitted: false, attachments_omitted_count: 3, content_policy_version: 'storage-v1',
  } })
  const content = (await api('GET', `/messages/${id}/content`)).data
  assert.deepEqual(content, {
    name: `messages/${id}/content`, recipients: [{ address: 'a@example.org', display_name: 'A' }, { address: 'b@example.org' }],
    send_time: '2026-09-30T10:00:00Z', rfc_message_id: '<id@example.org>', text: '独立服务测试正文', html: '<p>x</p>',
    headers: [{ key: 'subject', value: 'x' }], needs_review: true, warnings: ['attached_or_opaque_message', 'a_future_code'],
    text_truncated: true, original_text_bytes: 2000000, omitted_attachment_count: 3, content_policy_version: 'storage-v1',
  })
  // A Date header outside the years 1-9999 has no Timestamp: the content is still answered.
  const odd = await message(env, { parsed: { sent_at: '+275760-09-13T00:00:00.000Z' } })
  assert.equal((await api('GET', `/messages/${odd}/content`)).data.send_time, undefined)
  await env.MAIL_STORE.delete(`parsed/${odd}/test/message.json`)
  const unavailable = await api('GET', `/messages/${odd}/content`)
  assert.deepEqual([unavailable.status, reasonOf(unavailable.data)], [503, 'CONTENT_UNAVAILABLE'])
})

test('reparse, attempts, payload and the message filter of ListDeliveries', async () => {
  const env = environment(), api = await session(env), target = await endpoint(api)
  const id = await message(env), other = await message(env)
  await env.DB.prepare("UPDATE messages SET parse_state='failed',parse_error='parse_timeout' WHERE id=?").bind(other).run()
  assert.equal((await api('GET', `/messages/${other}`)).data.parse_error, 'parse_timeout')
  const reparse = await api('POST', `/messages/${other}:reparse`, { request_id: crypto.randomUUID() })
  assert.equal(reparse.status, 200, JSON.stringify(reparse.data))
  assert.deepEqual([reparse.data.parse_state, reparse.data.parse_error], ['pending', undefined])
  assert.ok(env.jobs.some(job => job.body?.type === 'parse'))
  const sent = await sendMessage(api, id, target.id)
  const eventID = idOf(sent.data.delivery.name)
  const notAgain = await api('POST', `/messages/${id}:reparse`, { request_id: crypto.randomUUID() })
  assert.deepEqual([notAgain.status, reasonOf(notAgain.data)], [400, 'NOT_REPARSABLE'], 'a message with a delivery is not parsed again')
  for (let n = 1; n <= 3; n++) {
    await env.DB.prepare('INSERT INTO delivery_attempts(id,event_id,attempt_no,started_at,finished_at,http_status,duration_ms,outcome,error_code) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), eventID, n, '2026-09-30T00:00:00.000Z', n < 3 ? '2026-09-30T00:00:01.000Z' : null, n < 3 ? 503 : null, n < 3 ? 120 : null, n < 3 ? 'retryable' : null, n < 3 ? 'http_503' : null).run()
  }
  const page = await api('GET', `/deliveries/${eventID}/attempts?page_size=2`)
  assert.deepEqual(page.data.delivery_attempts.map(item => item.name), [3, 2].map(n => `deliveries/${eventID}/attempts/${n}`))
  assert.deepEqual(page.data.delivery_attempts[0], { name: `deliveries/${eventID}/attempts/3`, start_time: '2026-09-30T00:00:00Z' }, 'still running')
  const rest = await api('GET', `/deliveries/${eventID}/attempts?page_size=2&page_token=${page.data.next_page_token}`)
  assert.deepEqual([rest.data.delivery_attempts.map(item => item.name), rest.data.next_page_token], [[`deliveries/${eventID}/attempts/1`], undefined])
  assert.equal((await api('GET', `/deliveries/${crypto.randomUUID()}/attempts?page_token=${page.data.next_page_token}`)).status, 400, 'a token of another parent')
  const one = await api('GET', `/deliveries/${eventID}/attempts/1`)
  assert.deepEqual(one.data, { name: `deliveries/${eventID}/attempts/1`, start_time: '2026-09-30T00:00:00Z', finish_time: '2026-09-30T00:00:01Z', http_status: 503, duration_ms: 120, outcome: 'retryable', error_code: 'http_503' })
  assert.equal((await api('GET', `/deliveries/${eventID}/attempts/9`)).status, 404)
  assert.equal((await api('GET', `/deliveries/${crypto.randomUUID()}/attempts`)).status, 404)
  const byMessage = await api('GET', `/deliveries${query({ filter: `message = ${quote(`messages/${id}`)}` })}`)
  assert.deepEqual(byMessage.data.deliveries.map(item => item.name), [`deliveries/${eventID}`])
  assert.equal((await api('GET', `/deliveries${query({ filter: `message = ${quote(`messages/${other}`)}` })}`)).data.deliveries, undefined)
  assert.equal((await api('GET', `/deliveries${query({ filter: `message = messages` })}`)).status, 400)
  assert.equal((await api('GET', `/deliveries/${crypto.randomUUID()}/payload`)).status, 404)
})

test('the typed client the UI uses round-trips every kind of call through the transcoder', async () => {
  const env = environment(), api = await session(env), target = await endpoint(api), id = await message(env)
  const csrf = await handleAPI(new Request(`${ORIGIN}/api/csrf`), env)
  const { token } = await csrf.json(), cookie = csrf.headers.get('set-cookie').split(';')[0]
  const client = createHttpClient(MailHeroUiService, call => handleAPI(new Request(`${ORIGIN}${call.url}`, { method: call.httpMethod, body: call.body,
    headers: { Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': token, ...(call.body === undefined ? {} : { 'Content-Type': 'application/json' }) } }), env))
  const listed = await client.listMessages({ filter: quote('独立服务'), pageSize: 10 })
  assert.deepEqual(listed.messages.map(item => item.name), [`messages/${id}`])
  const message_ = await client.getMessage({ name: `messages/${id}` })
  const read = await client.updateMessage({ message: { name: message_.name, etag: message_.etag, read: true }, updateMask: { paths: ['read', 'etag'] } })
  assert.equal(read.read, true)
  const sent = await client.sendMessage({ name: `messages/${id}`, endpoint: target.name, requestId: crypto.randomUUID() })
  assert.equal(sent.delivery.state, Delivery_State.PENDING)
  const settings = await client.updateSettings({ settings: { name: 'settings', etag: '1', sendPaused: true }, updateMask: { paths: ['send_paused', 'etag'] } })
  assert.deepEqual([settings.sendPaused, settings.effectiveSendPaused], [true, true])
  assert.equal((await client.getDelivery({ name: sent.delivery.name })).effectiveState, Delivery_State.PAUSED)
  const stats = await client.summarizeDeliveryAttempts({ parent: 'deliveries/-', startTime: { seconds: 1_790_000_000n, nanos: 0 }, endTime: { seconds: 1_790_086_400n, nanos: 0 } })
  assert.deepEqual([stats.timeZone, stats.buckets.length], ['UTC', 2])
  assert.equal(DeliveryAttempt_Outcome.DELIVERED, 1)
  await assert.rejects(client.getEndpoint({ name: `endpoints/${crypto.randomUUID()}` }), error => error instanceof RpcStatusError && error.status.reason === 'NOT_FOUND')
})

test('the coordinator answers the two heavy reads the Worker forwards, and nothing else', async () => {
  const env = environment(), api = await session(env), id = await message(env)
  const forwarded = []
  const get = env.COORDINATOR.get
  env.COORDINATOR.get = name => {
    const stub = get(name)
    return { fetch: (url, init) => { if (new URL(url).pathname.startsWith('/owner-api/')) forwarded.push(new URL(url).pathname); return stub.fetch(url, init) } }
  }
  const lines = []
  const log = console.log
  console.log = line => lines.push(line)
  try {
    assert.equal((await api('GET', `/messages/${id}/content`)).data.text, '独立服务测试正文')
    assert.equal((await api('GET', '/deliveries/-/attempts:summarize?start_time=2026-09-25T00:00:00Z&end_time=2026-09-26T00:00:00Z')).status, 200)
    const zone = await api('GET', '/deliveries/-/attempts:summarize?start_time=2026-09-25T00:00:00Z&end_time=2026-09-26T00:00:00Z&time_zone=Mars%2FBase')
    assert.deepEqual([zone.status, reasonOf(zone.data)], [400, 'INVALID_TIME_ZONE'], "the coordinator's Status reaches the owner as it is")
    const head = await api('HEAD', `/messages/${id}/content`)
    assert.deepEqual([head.status, head.data], [200, ''])
    await api('GET', `/messages/${id}`)
    assert.equal((await api('POST', `/messages/${id}/content`, {})).status, 405, 'only reads are forwarded')
  } finally { console.log = log }
  assert.deepEqual(forwarded, [`/owner-api/api/v2/messages/${id}/content`, '/owner-api/api/v2/deliveries/-/attempts:summarize',
    '/owner-api/api/v2/deliveries/-/attempts:summarize', `/owner-api/api/v2/messages/${id}/content`])
  assert.deepEqual(lines.map(line => JSON.parse(line).reason), ['INVALID_TIME_ZONE', 'METHOD_NOT_ALLOWED'], 'the Worker logs what the coordinator refused')
  // The coordinator's side serves those routes only, whatever it is asked.
  for (const path of ['/owner-api/api/v2/settings', '/owner-api/api/v2/messages', `/owner-api/api/v2/messages/${id}`, `/owner-api/api/v2/messages/${id}/raw`, '/owner-api/x']) {
    const response = await handleDelegated(new Request(`https://coordinator${path}`), env)
    assert.equal(response.status, 404, path)
  }
  const post = await handleDelegated(new Request(`https://coordinator/owner-api/api/v2/messages/${id}/content`, { method: 'POST' }), env)
  assert.equal(post.status, 404, 'a mutation never runs in the coordinator')
  // An unreachable coordinator is a failed dependency.
  env.COORDINATOR.get = () => ({ fetch: async () => { throw new Error('secret-internal') } })
  const down = await api('GET', `/messages/${id}/content`)
  assert.deepEqual([down.status, reasonOf(down.data)], [503, 'UNAVAILABLE'])
  assert.equal(JSON.stringify(down.data).includes('secret'), false)
})
