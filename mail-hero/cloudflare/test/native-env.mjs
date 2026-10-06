// The owner API tests' environment: real SQLite running the production migrations behind D1's small binding surface,
// an in-memory R2, a coordinator stub that creates deliveries with the same env (requestDelivery) and records wakes
// and jobs, and the owner API session (test/owner-api.mjs) through handleAPI. Synthetic data only.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { DELEGATED_PREFIX, handleAPI, handleDelegated } from '../src/native/api.ts'
import { handleDeliveryRequest } from '../src/native/pipeline.ts'
import { createEndpoint, idOf, ownerSession } from './owner-api.mjs'

// Real SQLite executes the production migration and SQL. This fixture emulates
// only D1's small binding surface; workerd/remote quotas need separate tests.
export class TestD1 {
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
export class Statement {
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
export class TestR2 {
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
export function environment() {
  const jobs = [], wakes = []
  const env = {
    DB: new TestD1(), MAIL_STORE: new TestR2(), RECEIVE_ADDRESS: 'hero@in.example.org',
    CREDENTIAL_KEY: '12'.repeat(32), DEV_AUTH_BYPASS: 'true', WEBHOOK_ALLOWED_HOSTS: 'consumer.example.org,second.example.org',
    ACCESS_ISSUER: 'https://test.cloudflareaccess.com', ACCESS_AUDIENCE: 'test-audience', ACCESS_OWNER: 'owner@example.org',
    jobs, wakes, COORDINATOR: { idFromName(name) { assert.equal(name, 'inbox-v1'); return name }, get() { return { async fetch(url, init) {
      if (new URL(url).pathname === '/mutation/begin') return Response.json({id: crypto.randomUUID()})
      // The coordinator creates the deliveries a request asks for (requestDelivery), with the same env here.
      if (new URL(url).pathname === '/deliveries/create') return handleDeliveryRequest(env, new Request(url, init))
      // ...and answers the owner API's heavy reads and attachment downloads the Worker forwards (api.ts).
      if (new URL(url).pathname.startsWith(DELEGATED_PREFIX + '/')) return handleDelegated(new Request(url, init), env)
      if (new URL(url).pathname === '/wake') wakes.push(Date.now())
      if (new URL(url).pathname === '/enqueue') jobs.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
      return new Response(null, { status: 204 })
    } } } },
  }
  return env
}
/** `api(method, path, body?, headers?)`: the owner API (mailhero.ui.v2) through handleAPI, as the UI calls it. */
export async function session(env) {
  const call = await ownerSession(request => handleAPI(request, env))
  call.env = env
  return call
}
/** A target (CreateEndpoint) with its UUID, its version (the etag) and its current revision's ID (from D1). */
export async function endpoint(api, fields = {}, requestId) {
  const value = await createEndpoint(api, fields, requestId)
  return withRevision(api, value)
}
export async function withRevision(api, value) {
  const id = idOf(value.name)
  const row = await api.env.DB.prepare('SELECT current_revision_id FROM webhook_endpoints WHERE id=?').bind(id).first()
  return { ...value, id, version: Number(value.etag), current_revision_id: row.current_revision_id }
}
/** A parsed synthetic message (Chinese subject and body, `options.parsed` merged into its record) in D1 and R2; answers its ID. */
export async function message(env, options = {}) {
  const id = crypto.randomUUID(), received = options.received_at || new Date().toISOString(), key = `parsed/${id}/test/message.json`, raw = `raw/${id}.eml`
  const parsed = { subject: options.subject || '中文合成邮件', from: [{ address: 'synthetic@example.org', name: 'Fixture' }], to: [], cc: [], reply_to: [], text: options.text || '独立服务测试正文', html: '', headers: [], attachments: [], sent_at: null, rfc_message_id: null, needs_review: false, warnings: [], ...options.parsed }
  const encoded = JSON.stringify(parsed)
  await env.MAIL_STORE.put(key, encoded)
  await env.MAIL_STORE.put(raw, 'Subject: Synthetic\r\n\r\nFixture')
  await env.DB.prepare(`INSERT INTO messages(id,received_at,last_received_at,envelope_from,envelope_recipient,raw_key,size_bytes,receive_mode,parse_state,parsed_key,content_bytes,subject,from_text,search_text)
    VALUES(?,?,?,'synthetic@example.org',?,?,32,'archive','ready',?,?,?,'Fixture',?)`)
    .bind(id, received, received, env.RECEIVE_ADDRESS, raw, key, encoded.length + 32, parsed.subject, parsed.text).run()
  await env.DB.prepare('INSERT INTO message_search(message_id,chunk_no,body) VALUES(?,0,?)').bind(id, parsed.text.toLowerCase()).run()
  return id
}
