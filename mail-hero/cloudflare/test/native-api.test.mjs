import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { generateKeyPair, SignJWT } from 'jose'
import { handleAPI } from '../src/native/api.ts'
import { authenticate, decryptCredential, encryptCredential, HttpError } from '../src/native/security.ts'

// Real SQLite executes the production migration and SQL. This fixture emulates
// only D1's small binding surface; workerd/remote quotas need separate tests.
class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:')
    const directory = new URL('../migrations/', import.meta.url)
    for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) this.sqlite.exec(readFileSync(new URL(file, directory), 'utf8'))
  }
  prepare(sql) { return new Statement(this, sql) }
  async batch(statements) {
    this.sqlite.exec('BEGIN')
    try { const results = statements.map(statement => statement.execute()); this.sqlite.exec('COMMIT'); return results }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error }
  }
}
class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args }
  bind(...args) { return new Statement(this.db, this.sql, args) }
  execute() {
    const statement = this.db.sqlite.prepare(this.sql)
    const results = statement.all(...this.args).map(row => ({ ...row }))
    const changes = Number(this.db.sqlite.prepare('SELECT changes() n').get().n)
    return { success: true, results, meta: { changes } }
  }
  async run() { return this.execute() }
  async all() { return this.execute() }
  async first(column) { const row = this.execute().results[0] ?? null; return column ? row?.[column] ?? null : row }
}
class TestR2 {
  entries = new Map()
  async put(key, data, options = {}) {
    const bytes = new Uint8Array(await new Response(data).arrayBuffer())
    this.entries.set(key, { bytes, customMetadata: options.customMetadata || {} })
    return this.get(key)
  }
  async get(key) {
    const entry = this.entries.get(key)
    if (!entry) return null
    return { key, size: entry.bytes.length, customMetadata: entry.customMetadata, body: new Blob([entry.bytes]).stream(),
      async json() { return JSON.parse(new TextDecoder().decode(entry.bytes)) },
      async text() { return new TextDecoder().decode(entry.bytes) }, async arrayBuffer() { return entry.bytes.slice().buffer } }
  }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.entries.delete(key) }
  async list({ prefix, limit = 1000 }) { return { objects: [...this.entries.keys()].filter(key => key.startsWith(prefix)).slice(0, limit).map(key => ({ key })), truncated: false } }
}
function environment() {
  const jobs = []
  return {
    DB: new TestD1(), MAIL_STORE: new TestR2(), RECEIVE_ADDRESS: 'hero@in.example.org',
    CREDENTIAL_KEY: '12'.repeat(32), DEV_AUTH_BYPASS: 'true', WEBHOOK_ALLOWED_HOSTS: 'consumer.example.org,second.example.org',
    ACCESS_ISSUER: 'https://test.cloudflareaccess.com', ACCESS_AUDIENCE: 'test-audience', ACCESS_OWNER: 'owner@example.org',
    jobs, COORDINATOR: { idFromName(name) { assert.equal(name, 'inbox-v1'); return name }, get() { return { async fetch(url, init) {
      if (new URL(url).pathname === '/mutation/begin') return Response.json({id: crypto.randomUUID()})
      if (new URL(url).pathname === '/enqueue') jobs.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
      return new Response(null, { status: 204 })
    } } } },
  }
}
async function session(env) {
  const response = await handleAPI(new Request('http://127.0.0.1:8787/api/v1/csrf'), env)
  assert.equal(response.status, 200)
  const { token } = await response.json()
  const cookie = response.headers.get('Set-Cookie').split(';')[0]
  return async (path, method = 'GET', input, extras = {}) => {
    const response = await handleAPI(new Request(`http://127.0.0.1:8787/api/v1${path}`, {
      method, headers: { Cookie: cookie, Origin: 'http://127.0.0.1:8787', 'X-CSRF-Token': token, 'Content-Type': 'application/json', ...extras },
      body: input === undefined ? undefined : JSON.stringify(input),
    }), env)
    const text = await response.text()
    let data; try { data = JSON.parse(text) } catch { data = text }
    return { response, status: response.status, data }
  }
}
async function endpoint(api, options = {}) {
  const result = await api('/endpoints', 'POST', { label: 'Consumer', url: 'https://consumer.example.org/hooks/mail', auth_type: 'bearer', credential: 'test-secret', action_request_id: crypto.randomUUID(), ...options })
  assert.equal(result.status, 201, JSON.stringify(result.data))
  return result.data
}
async function message(env, options = {}) {
  const id = crypto.randomUUID(), received = options.received_at || new Date().toISOString(), key = `parsed/${id}/test/message.json`, raw = `raw/${id}.eml`
  const parsed = { subject: options.subject || '中文合成邮件', from: [{ address: 'synthetic@example.org', name: 'Fixture' }], to: [], cc: [], reply_to: [], text: options.text || '独立服务测试正文', html: '', headers: [], attachments: [], sent_at: null, rfc_message_id: null, needs_review: false, warnings: [] }
  const encoded = JSON.stringify(parsed)
  await env.MAIL_STORE.put(key, encoded)
  await env.MAIL_STORE.put(raw, 'Subject: Synthetic\r\n\r\nFixture')
  await env.DB.prepare(`INSERT INTO messages(id,received_at,last_received_at,envelope_from,envelope_recipient,raw_key,size_bytes,receive_mode,parse_state,parsed_key,content_bytes,subject,from_text,search_text)
    VALUES(?,?,?,'synthetic@example.org',?,?,32,'archive','ready',?,?,?,'Fixture',?)`)
    .bind(id, received, received, env.RECEIVE_ADDRESS, raw, key, encoded.length + 32, parsed.subject, parsed.text).run()
  await env.DB.prepare('INSERT INTO message_search(message_id,chunk_no,body) VALUES(?,0,?)').bind(id, parsed.text.toLowerCase()).run()
  return id
}

test('native API defaults are archive with no retention, maintenance blocks mutations only', async () => {
  const env = environment(), api = await session(env)
  const initial = await api('/settings')
  assert.equal(initial.status, 200)
  assert.equal(initial.data.mode, 'archive')
  assert.equal(initial.data.retention_days, null)
  assert.equal(initial.response.headers.get('Cache-Control'), 'no-store')
  env.MAINTENANCE_MODE = 'true'
  assert.equal((await api('/settings', 'PATCH', { version: 1, mode: 'archive' })).status, 503)
  assert.equal((await api('/settings')).status, 200)
  const overview = await api('/overview')
  assert.ok(overview.data.warnings.some(item => item.includes('维护模式')))
})

test('Access validates signature, audience and owner; fake header and remote dev bypass fail closed', async () => {
  const env = environment(); delete env.DEV_AUTH_BYPASS
  const keys = await generateKeyPair('RS256')
  const sign = (overrides = {}) => new SignJWT({ email: env.ACCESS_OWNER, ...overrides }).setProtectedHeader({ alg: 'RS256' }).setIssuer(env.ACCESS_ISSUER).setAudience(env.ACCESS_AUDIENCE).setSubject('synthetic-user').setIssuedAt().setExpirationTime('10m').sign(keys.privateKey)
  const request = async overrides => new Request('https://mail.example.org/api/v1/settings', { headers: { 'Cf-Access-Jwt-Assertion': await sign(overrides) } })
  assert.equal(await authenticate(await request(), env, async () => keys.publicKey), env.ACCESS_OWNER)
  await assert.rejects(authenticate(await request(), { ...env, ACCESS_AUDIENCE: 'different-audience' }, async () => keys.publicKey), error => error instanceof HttpError && error.status === 401)
  await assert.rejects(authenticate(await request({ email: 'other@example.org' }), env, async () => keys.publicKey), error => error instanceof HttpError && error.status === 401)
  await assert.rejects(authenticate(new Request('https://mail.example.org', { headers: { 'Cf-Access-Jwt-Assertion': 'present-but-not-a-token' } }), env, async () => keys.publicKey), /Access/)
  env.DEV_AUTH_BYPASS = 'true'
  assert.equal((await handleAPI(new Request('https://mail.example.org/api/v1/settings'), env)).status, 503)
})

test('Access aliases preserve one canonical owner and still require every JWT check', async () => {
  const env = environment(); delete env.DEV_AUTH_BYPASS
  env.ACCESS_OWNER = '  owner@example.org  '
  env.ACCESS_OWNER_ALIASES = ' github-owner@example.org, , second-login@example.org '
  const keys = await generateKeyPair('RS256'), unrelatedKeys = await generateKeyPair('RS256')
  const sign = (email, overrides = {}, privateKey = keys.privateKey) => new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(overrides.issuer ?? env.ACCESS_ISSUER)
    .setAudience(overrides.audience ?? env.ACCESS_AUDIENCE).setSubject('synthetic-user')
    .setIssuedAt().setExpirationTime(overrides.expires ?? '10m').sign(privateKey)
  const request = token => new Request('https://mail.example.org/api/v1/settings', { headers: { 'Cf-Access-Jwt-Assertion': token } })
  const authenticateToken = token => authenticate(request(token), env, async () => keys.publicKey)
  for (const email of ['owner@example.org', 'github-owner@example.org', 'second-login@example.org']) {
    assert.equal(await authenticateToken(await sign(email)), 'owner@example.org')
  }
  for (const email of ['unlisted@example.org', 'GITHUB-owner@example.org', ' github-owner@example.org ']) {
    await assert.rejects(authenticateToken(await sign(email)), error => error instanceof HttpError && error.status === 401)
  }
  for (const token of [
    await sign('github-owner@example.org', { issuer: 'https://other.cloudflareaccess.com' }),
    await sign('github-owner@example.org', { audience: 'wrong-audience' }),
    await sign('github-owner@example.org', { expires: '1 second ago' }),
    await sign('github-owner@example.org', {}, unrelatedKeys.privateKey),
    'present-but-not-a-token',
  ]) await assert.rejects(authenticateToken(token), error => error instanceof HttpError && error.status === 401)
})

test('Access aliases cannot replace a missing canonical owner or exceed the personal alias limit', async () => {
  const env = environment(); delete env.DEV_AUTH_BYPASS
  env.ACCESS_OWNER_ALIASES = 'github-owner@example.org'
  const keys = await generateKeyPair('RS256')
  const token = await new SignJWT({ email: 'github-owner@example.org' }).setProtectedHeader({ alg: 'RS256' })
    .setIssuer(env.ACCESS_ISSUER).setAudience(env.ACCESS_AUDIENCE).setSubject('synthetic-user')
    .setIssuedAt().setExpirationTime('10m').sign(keys.privateKey)
  const request = new Request('https://mail.example.org/api/v1/settings', { headers: { 'Cf-Access-Jwt-Assertion': token } })
  for (const owner of [undefined, '', '   ']) {
    await assert.rejects(authenticate(request, { ...env, ACCESS_OWNER: owner }, async () => keys.publicKey), error => error instanceof HttpError && error.status === 503)
  }
  const aliases = Array.from({ length: 9 }, (_, i) => `login-${i}@example.org`).join(',')
  await assert.rejects(authenticate(request, { ...env, ACCESS_OWNER_ALIASES: aliases }, async () => keys.publicKey), error => error instanceof HttpError && error.status === 503)
})

test('mutations require matching signed owner CSRF cookie and same-origin request', async () => {
  const env = environment(), api = await session(env)
  assert.equal((await api('/settings', 'PATCH', { version: 1, send_paused: true }, { Origin: 'https://attacker.example' })).status, 403)
  assert.equal((await api('/settings', 'PATCH', { version: 1, send_paused: true }, { 'X-CSRF-Token': 'forged' })).status, 403)
  assert.equal((await api('/settings', 'PATCH', { version: 1, send_paused: true })).status, 200)
})

test('endpoint create retries share one identity and secrets are encrypted with revision binding', async () => {
  const env = environment(), api = await session(env), actionID = crypto.randomUUID()
  const [one, two] = await Promise.all([endpoint(api, { action_request_id: actionID }), endpoint(api, { action_request_id: actionID })])
  assert.equal(one.id, two.id)
  assert.equal((await api('/endpoints')).data.items.length, 1)
  assert.equal(JSON.stringify(one).includes('test-secret'), false)
  assert.equal('credential_ciphertext' in one, false)
  const stored = await env.DB.prepare('SELECT * FROM endpoint_revisions WHERE id=?').bind(one.current_revision_id).first()
  assert.notEqual(stored.credential_ciphertext, 'test-secret')
  assert.equal(await decryptCredential(env, stored.id, stored.url, stored.credential_ciphertext), 'test-secret')
  await assert.rejects(decryptCredential(env, stored.id, 'https://second.example.org/hooks/mail', stored.credential_ciphertext))
  const conflict = await api('/endpoints', 'POST', { label: 'Different', url: one.url, credential: 'test-secret', action_request_id: actionID })
  assert.equal(conflict.status, 409)
})

test('endpoint policy rejects private/unauthenticated targets and requires new credential for changed origin', async () => {
  const env = environment(), api = await session(env)
  for (const url of ['http://consumer.example.org/hooks/mail', 'https://127.0.0.1/hooks/mail', 'https://unlisted.example.org/hooks/mail', 'https://user:pass@consumer.example.org/hooks/mail']) {
    assert.equal((await api('/endpoints', 'POST', { label: 'Bad', url, credential: 'test-secret', action_request_id: crypto.randomUUID() })).status, 400)
  }
  assert.equal((await api('/endpoints', 'POST', { label: 'Bad', url: 'https://consumer.example.org/hooks', auth_type: 'none', action_request_id: crypto.randomUUID() })).status, 400)
  const value = await endpoint(api)
  assert.equal((await api(`/endpoints/${value.id}`, 'PATCH', { version: value.version, url: 'https://second.example.org/hooks' })).status, 400)
  const changed = await api(`/endpoints/${value.id}`, 'PATCH', { version: value.version, url: 'https://second.example.org/hooks', credential: 'new-secret' })
  assert.equal(changed.status, 200)
  assert.notEqual(changed.data.current_revision_id, value.current_revision_id)
  assert.equal((await api(`/endpoints/${value.id}`, 'PATCH', { version: value.version, paused: true })).status, 409)
})

test('credential rotation changes same-origin revisions only, clears auth blocks and preserves identities', async () => {
  const env = environment(), api = await session(env)
  let value = await endpoint(api)
  const firstRevision = value.current_revision_id
  value = (await api(`/endpoints/${value.id}`, 'PATCH', { version: value.version, url: 'https://consumer.example.org/hooks/v2' })).data
  const secondRevision = value.current_revision_id
  const anotherID = crypto.randomUUID()
  await env.DB.prepare(`INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type,credential_ciphertext,created_at) VALUES(?,?,99,'https://second.example.org/hooks','bearer',?,?)`)
    .bind(anotherID, value.id, await encryptCredential(env, anotherID, 'https://second.example.org/hooks', 'separate'), new Date().toISOString()).run()
  await env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_401' WHERE id=?").bind(firstRevision).run()
  const result = await api(`/endpoints/${value.id}/rotate-credential`, 'POST', { version: value.version, credential: 'rotated-secret' })
  assert.equal(result.status, 200)
  assert.equal(result.data.affected_revisions, 2)
  for (const id of [firstRevision, secondRevision]) {
    const row = await env.DB.prepare('SELECT * FROM endpoint_revisions WHERE id=?').bind(id).first()
    assert.equal(await decryptCredential(env, id, row.url, row.credential_ciphertext), 'rotated-secret')
    assert.equal(row.blocked_reason, null)
  }
  const unrelated = await env.DB.prepare('SELECT * FROM endpoint_revisions WHERE id=?').bind(anotherID).first()
  assert.equal(await decryptCredential(env, anotherID, unrelated.url, unrelated.credential_ciphertext), 'separate')
})

test('retention enabling requires owner/version/days-bound preview and never deletes content in settings request', async () => {
  const env = environment(), api = await session(env)
  const id = await message(env, { received_at: new Date(Date.now() - 60 * 86400000).toISOString() })
  assert.equal((await api('/settings', 'PATCH', { version: 1, retention_days: 30 })).status, 400)
  const preview = await api('/settings/retention-preview?days=30')
  assert.equal(preview.status, 200)
  assert.equal(preview.data.candidates, 1)
  assert.equal((await api('/settings', 'PATCH', { version: 1, retention_days: 20, retention_confirmation: preview.data.preview_token })).status, 400)
  assert.equal((await api('/settings', 'PATCH', { version: 1, retention_days: 30, retention_confirmation: preview.data.preview_token })).status, 200)
  assert.equal((await env.DB.prepare('SELECT content_deleted_at FROM messages WHERE id=?').bind(id).first()).content_deleted_at, null)
  assert.equal((await api('/settings', 'PATCH', { version: 1, send_paused: true })).status, 409)
  assert.equal((await api('/settings', 'PATCH', { version: 2, retention_days: null })).status, 200)
})

test('message API searches Chinese body, exposes safe details and optimistic read state', async () => {
  const env = environment(), api = await session(env), id = await message(env)
  const list = await api('/messages?q=' + encodeURIComponent('独立服务'))
  assert.equal(list.data.items[0].id, id)
  const detail = await api(`/messages/${id}`)
  assert.equal(detail.data.message.text, '独立服务测试正文')
  assert.equal(JSON.stringify(detail.data).includes('parsed/'), false)
  assert.equal((await api(`/messages/${id}`, 'PATCH', { read: true, version: 1 })).status, 200)
  assert.equal((await api(`/messages/${id}`, 'PATCH', { read: false, version: 1 })).status, 409)
  const raw = await api(`/messages/${id}/raw`)
  assert.equal(raw.status, 200)
  assert.match(raw.response.headers.get('Content-Disposition'), /^attachment/)
})

test('send/retry/cancel/replay use durable IDs and deleted content cannot be sent or downloaded', async () => {
  const env = environment(), api = await session(env), target = await endpoint(api), id = await message(env)
  const action = crypto.randomUUID()
  const first = await api(`/messages/${id}/send`, 'POST', { endpoint_id: target.id, action_request_id: action })
  assert.equal(first.status, 201, JSON.stringify(first.data))
  const duplicate = await api(`/messages/${id}/send`, 'POST', { endpoint_id: target.id, action_request_id: action })
  assert.equal(duplicate.data.event_id, first.data.event_id)
  const eventID = first.data.event_id
  const payload = (await api(`/deliveries/${eventID}`)).data.payload
  assert.equal(payload.event_id, eventID)
  assert.equal(payload.type, 'mail.received.v1')
  const cancel = await api(`/deliveries/${eventID}/cancel`, 'POST', { action_request_id: crypto.randomUUID() })
  assert.equal(cancel.status, 200)
  assert.equal(cancel.data.state, 'cancelled')
  const retry = await api(`/deliveries/${eventID}/retry`, 'POST', { action_request_id: crypto.randomUUID() })
  assert.equal(retry.status, 202)
  assert.equal(retry.data.event_id, eventID)
  assert.equal((await api(`/deliveries/${eventID}`)).data.payload.event_id, eventID)
  const currentMessage = (await api(`/messages/${id}`)).data.message
  const replay = await api(`/deliveries/${eventID}/replay`, 'POST', { action_request_id: crypto.randomUUID(), endpoint_id: target.id, message_version: currentMessage.version })
  assert.equal(replay.status, 201)
  assert.notEqual(replay.data.event_id, eventID)
  assert.equal(replay.data.generation, 2)
  const deletion = await api(`/messages/${id}/content`, 'DELETE', { action_request_id: crypto.randomUUID(), version: currentMessage.version })
  assert.equal(deletion.status, 200)
  assert.equal((await api(`/messages/${id}/raw`)).status, 410)
  assert.equal((await api(`/messages/${id}/send`, 'POST', { endpoint_id: target.id, action_request_id: crypto.randomUUID() })).status, 410)
  assert.equal((await api(`/deliveries/${eventID}`)).data.payload, null)
})

test('endpoint diagnostics report only verified policy and synthetic tests are idempotent', async () => {
  const env = environment(), api = await session(env), target = await endpoint(api)
  const check = await api(`/endpoints/${target.id}/check`, 'POST', {})
  assert.equal(check.status, 200)
  assert.equal(check.data.url_valid, true)
  assert.equal(check.data.dns_status, 'not_checked')
  assert.equal(check.data.business_contract, 'not_verified')
  const action = crypto.randomUUID()
  const first = await api(`/endpoints/${target.id}/test`, 'POST', { action_request_id: action })
  assert.equal(first.status, 202, JSON.stringify(first.data))
  const second = await api(`/endpoints/${target.id}/test`, 'POST', { action_request_id: action })
  assert.equal(first.data.event_id, second.data.event_id)
  assert.equal(first.data.synthetic_test, true)
  assert.equal((await api('/messages')).data.items.length, 0)
  assert.equal((await api('/deliveries')).data.items.length, 1)
  assert.ok(env.jobs.length > 0)
})

test('a lost action acknowledgement still resolves the original event after endpoint changes', async () => {
  const env = environment(), api = await session(env), target = await endpoint(api), id = await message(env), actionID = crypto.randomUUID()
  const first = await api(`/messages/${id}/send`, 'POST', { endpoint_id: target.id, action_request_id: actionID })
  assert.equal(first.status, 201)
  // Model the commit/response boundary: the delivery exists, but the API's
  // separate action completion did not become visible to the caller.
  await env.DB.prepare('UPDATE ui_actions SET result_ref=NULL,http_status=NULL WHERE action_request_id=?').bind(actionID).run()
  assert.equal((await api(`/endpoints/${target.id}`, 'PATCH', { version: target.version, url: 'https://consumer.example.org/hooks/v2' })).status, 200)
  const retry = await api(`/messages/${id}/send`, 'POST', { endpoint_id: target.id, action_request_id: actionID })
  assert.equal(retry.status, 201)
  assert.equal(retry.data.event_id, first.data.event_id)
  assert.equal((await api('/deliveries')).data.items.length, 1)
})

test('internal database failure does not echo errors or credentials to a browser', async () => {
  const env = environment(), api = await session(env)
  env.DB.prepare = () => { throw new Error('postgres://secret-user:secret-password@private-host') }
  const response = await api('/settings')
  assert.equal(response.status, 503)
  assert.equal(response.data.error.code, 'service_unavailable')
  assert.equal(JSON.stringify(response.data).includes('secret'), false)
})

test('setup does not claim real routing success; scheduler failure remains visible without breaking mailbox settings', async () => {
  const env = environment(), api = await session(env)
  env.COORDINATOR.get = () => ({ async fetch() { return Response.json({ pending: 3, failed: 2, oldest: Date.now() - 60000, next_alarm: null }) } })
  const status = await api('/setup/status')
  assert.equal(status.status, 200)
  assert.equal(status.data.checks.find(item => item.id === 'edge').status, 'pending')
  assert.equal(status.data.checks.find(item => item.id === 'received').status, 'pending')
  assert.equal(status.data.checks.find(item => item.id === 'scheduler').status, 'warning')
  const overview = await api('/overview')
  assert.equal(overview.data.scheduler.failed, 2)
  assert.ok(overview.data.warnings.some(item => item.includes('失败记录')))
  assert.ok(overview.data.warnings.some(item => item.includes('alarm')))
  env.COORDINATOR.get = () => ({ async fetch() { throw new Error('secret-internal-error') } })
  const offline = await api('/overview')
  assert.equal(offline.status, 200)
  assert.equal(offline.data.scheduler.available, false)
  assert.equal(JSON.stringify(offline.data).includes('secret-internal-error'), false)
  assert.equal((await api('/settings')).status, 200)
})

test('maintenance rejects every browser mutation route and reports effective pause truthfully', async () => {
  const env = environment(), api = await session(env)
  env.MAINTENANCE_MODE = 'true'
  for (const [method, path] of [['POST', '/endpoints'], ['PATCH', '/settings'], ['DELETE', `/messages/${crypto.randomUUID()}/content`], ['POST', `/deliveries/${crypto.randomUUID()}/retry`]]) {
    assert.equal((await api(path, method, {})).status, 503)
  }
  const settings = await api('/settings')
  assert.equal(settings.data.send_paused, false)
  assert.equal(settings.data.effective_send_paused, true)
  const overview = await api('/overview')
  assert.ok(overview.data.warnings.some(item => item.includes('维护模式')))
  assert.equal(overview.data.warnings.some(item => item.includes('收信继续')), false)
})
