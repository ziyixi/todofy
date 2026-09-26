import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { captureLifecyclePolicy, expireRawContent, lifecycleStorage, runLifecycle, safeTerminalSQL, terminalAnchorSQL } from '../src/native/lifecycle.ts'
import { alertConfiguration, alertSignals, deliverAlert, evaluateAlerts } from '../src/native/alerts.ts'
import { currentSettings, patchSettings, previewRetention } from '../src/native/api-settings.ts'
import { deleteMessageContent } from '../src/native/pipeline.ts'

class D1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:')
    const directory = new URL('../migrations/', import.meta.url)
    for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) this.sqlite.exec(readFileSync(new URL(file, directory), 'utf8'))
  }
  prepare(sql) {
    const db = this
    const make = args => ({ bind: (...values) => make(values),
      async all() { const results = db.sqlite.prepare(sql).all(...args).map(row => ({ ...row })); return { results, meta: { changes: Number(db.sqlite.prepare('SELECT changes() n').get().n) } } },
      async run() { return this.all() }, async first() { return (await this.all()).results[0] || null } })
    return make([])
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN')
    try { const output = []; for (const statement of statements) output.push(await statement.run()); this.sqlite.exec('COMMIT'); return output }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error }
  }
}
function environment() {
  const objects = new Set(), calls = []
  return { DB: new D1(), CREDENTIAL_KEY: 'ab'.repeat(32), RECEIVE_ADDRESS: 'hero@in.example.org', WEBHOOK_ALLOWED_HOSTS: 'alerts.example.org', objects, calls,
    MAIL_STORE: { async delete(key) { objects.delete(key) } },
    COORDINATOR: { idFromName: value => value, get() { return { async fetch(url, input) { calls.push({ url: String(url), body: input?.body ? JSON.parse(input.body) : null }); return new Response(null, { status: 204 }) } } } } }
}
const passthrough = callback => callback()
async function insert(env, values = {}) {
  const id = crypto.randomUUID(), timestamp = new Date(Date.now() - 60 * 86400000).toISOString()
  const row = { id, received_at: timestamp, last_received_at: timestamp, envelope_from: 'fixture@example.org', envelope_recipient: env.RECEIVE_ADDRESS,
    raw_key: `raw/${id}.eml`, size_bytes: 100, content_bytes: 140, receive_mode: 'archive', parse_state: 'ready', parsed_key: `parsed/${id}/message.json`, ...values }
  await env.DB.prepare(`INSERT INTO messages(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row)).run()
  env.objects.add(row.raw_key); env.objects.add(row.parsed_key)
  await env.DB.prepare('UPDATE app_settings SET logical_bytes=logical_bytes+?').bind(row.content_bytes).run()
  return id
}
const read = (env, id) => env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(id).first()
async function endpoint(env) {
  const id = crypto.randomUUID(), revision = crypto.randomUUID()
  await env.DB.prepare("INSERT INTO webhook_endpoints(id,label,created_at,updated_at) VALUES(?,'Synthetic','2026-01-01','2026-01-01')").bind(id).run()
  await env.DB.prepare("INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type,created_at) VALUES(?,?,1,'https://example.org','none','2026-01-01')").bind(revision, id).run()
  return revision
}
async function delivery(env, id, revision, state = 'delivered', extra = {}) {
  const row = { event_id: crypto.randomUUID(), message_id: id, endpoint_revision_id: revision, generation: 1, payload_sha256: '0'.repeat(64), state, next_attempt_at: '2026-01-01', created_at: '2026-01-01', delivered_at: state === 'delivered' ? '2026-01-02' : null, ...extra }
  await env.DB.prepare(`INSERT INTO deliveries(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row)).run()
}
const request = input => new Request('https://mail.example.org/api/v1/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })

test('new lifecycle defaults never retroactively enroll historical mail', async () => {
  const env = environment(), id = await insert(env)
  assert.deepEqual(await captureLifecyclePolicy(env), { lifecycle_policy_version: 1, raw_retention_days: 7, content_retention_days: 30, ledger_retention_days: 180 })
  await runLifecycle(env, { withMutation: passthrough, deleteContent: async () => assert.fail('historical delete') })
  assert.equal((await read(env, id)).retention_policy_version, null); assert.equal((await read(env, id)).retention_started_at, null)
})

test('routine alert and lifecycle query plans use live-only indexes instead of old tombstones', async () => {
  const env=environment()
  const pending=await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT min(m.received_at) FROM messages m WHERE m.origin='cloudflare' AND m.content_deleted_at IS NULL AND
    (m.parse_state IN('pending','parsing') OR (m.receive_mode='forward' AND
      (NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id) OR EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.state<>'delivered'))))`).all()
  assert.ok(pending.results.some(row=>row.detail.includes('messages_live_received_idx')),JSON.stringify(pending.results))
  const expiry=await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT m.id,m.version FROM messages m WHERE m.retention_policy_version IS NOT NULL AND m.retention_started_at IS NOT NULL AND ${safeTerminalSQL()}
    AND ((m.content_retention_days IS NOT NULL AND julianday('now')>=julianday(${terminalAnchorSQL()})+m.content_retention_days)
      OR (m.raw_expired_at IS NULL AND m.raw_key IS NOT NULL AND m.raw_retention_days IS NOT NULL AND julianday('now')>=julianday(${terminalAnchorSQL()})+m.raw_retention_days))
    ORDER BY m.retention_started_at,m.id LIMIT 1`).all()
  assert.ok(expiry.results.some(row=>row.detail.includes('messages_live_lifecycle_idx')),JSON.stringify(expiry.results))
  const retry=await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT id,version FROM messages WHERE raw_expired_at IS NOT NULL AND
    (raw_purged_at IS NULL OR raw_capacity_pending_key IS NOT NULL) AND content_deleted_at IS NULL ORDER BY raw_expired_at LIMIT 1`).all()
  assert.ok(retry.results.some(row=>row.detail.includes('messages_raw_purge_idx')),JSON.stringify(retry.results))
  const full=await env.DB.prepare('EXPLAIN QUERY PLAN SELECT id FROM messages WHERE content_purge_pending=1 LIMIT 1').all()
  assert.ok(full.results.some(row=>row.detail.includes('messages_content_purge_pending_idx')),JSON.stringify(full.results))
})

test('safe terminal excludes review, errors, leases and unacknowledged frozen revisions', async () => {
  const env = environment(), revision = await endpoint(env), other = await endpoint(env), good = await insert(env)
  for (const fields of [{ needs_review: 1 }, { policy_error: 'unavailable' }, { claim_token: 'claim' }, { lease_until: '2026-01-01' }, { parse_state: 'failed' }, { parse_state: 'pending' }]) await insert(env, fields)
  await insert(env, { receive_mode: 'forward', endpoint_revision_id: revision })
  const wrong = await insert(env, { receive_mode: 'forward', endpoint_revision_id: revision }); await delivery(env, wrong, other)
  const failed = await insert(env); await delivery(env, failed, revision, 'failed')
  const inFlight = await insert(env); await delivery(env, inFlight, revision, 'delivered', { claim_token: 'claim' })
  const forward = await insert(env, { receive_mode: 'forward', endpoint_revision_id: revision }); await delivery(env, forward, revision)
  assert.deepEqual((await env.DB.prepare(`SELECT m.id FROM messages m WHERE ${safeTerminalSQL()}`).all()).results.map(row => row.id).sort(), [good, forward].sort())
})

test('raw expiry retries R2 and capacity failures without double subtraction or losing parsed content', async () => {
  const env = environment(), id = await insert(env), initial = await read(env, id)
  let deleted = false, failCapacity = true
  env.MAIL_STORE.delete = async key => { if (!deleted) { deleted = true; throw new Error('synthetic R2 failure') }; env.objects.delete(key) }
  env.COORDINATOR.get = () => ({ async fetch(url, input) { env.calls.push({ url: String(url), body: JSON.parse(input.body) }); return new Response(null, { status: failCapacity ? 503 : 204 }) } })
  await assert.rejects(expireRawContent(env, id, 1, passthrough), /R2 failure/)
  let row = await read(env, id)
  assert.ok(row.raw_expired_at); assert.equal(row.pending_delete_bytes, 100); assert.equal(row.raw_purged_at, null)
  await assert.rejects(expireRawContent(env, id, 2, passthrough), /capacity_settlement/)
  row = await read(env, id)
  assert.equal(row.raw_key, null); assert.equal(row.content_bytes, 40); assert.equal(row.pending_delete_bytes, 0)
  assert.equal(row.raw_capacity_pending_key, initial.raw_key); assert.equal(row.content_deleted_at, null)
  assert.ok(env.objects.has(initial.parsed_key)); assert.equal((await currentSettings(env)).logical_bytes, 40)
  failCapacity = false; await expireRawContent(env, id, row.version, passthrough)
  row = await read(env, id); assert.equal(row.raw_capacity_pending_key, null); assert.equal((await currentSettings(env)).logical_bytes, 40)
  assert.equal(await expireRawContent(env, id, row.version, passthrough), false)
  assert.equal(env.calls.at(-1).body.bytes, 40); assert.equal(env.calls.at(-1).body.legacy_bytes, 140)
  assert.deepEqual(await lifecycleStorage(env), { pending_physical_delete_bytes: 0, bucket_actual_bytes: null, account_r2_bytes: null, measured_at: null, actual_usage_status: 'not_measured' })
})

test('backup mutation guard rejects before lifecycle state or object changes', async () => {
  const env = environment(), id = await insert(env)
  await assert.rejects(expireRawContent(env, id, 1, async () => { throw new Error('backup active') }), /backup active/)
  assert.equal((await read(env, id)).raw_expired_at, null); assert.equal(env.objects.size, 2)
})

test('terminal clocks protect failures and raw stage preserves parsed content', async () => {
  const env = environment(), policy = { retention_policy_version: 1, raw_retention_days: 7, content_retention_days: 30, ledger_retention_days: 180 }
  const newlySafe = await insert(env, policy), failed = await insert(env, { ...policy, parse_state: 'failed' })
  const rawDue = await insert(env, { ...policy, retention_started_at: new Date(Date.now() - 10 * 86400000).toISOString() })
  const contentDue = await insert(env, { ...policy, retention_started_at: new Date(Date.now() - 40 * 86400000).toISOString() }), deleted = []
  const result = await runLifecycle(env, { withMutation: passthrough, deleteContent: async id => { deleted.push(id); await env.DB.prepare("UPDATE messages SET content_deleted_at='2026-09-01' WHERE id=?").bind(id).run() } })
  assert.deepEqual(deleted, [contentDue]); assert.equal(result.processed, 2)
  assert.ok((await read(env, newlySafe)).retention_started_at); assert.equal((await read(env, failed)).retention_started_at, null)
  assert.ok((await read(env, rawDue)).raw_purged_at); assert.equal((await read(env, rawDue)).content_deleted_at, null)
})

test('a new pending delivery between lifecycle selection and tombstone CAS prevents automatic deletion', async () => {
  const env=environment(),revision=await endpoint(env)
  const id=await insert(env,{retention_policy_version:1,raw_retention_days:7,content_retention_days:30,
    retention_started_at:new Date(Date.now()-40*86400000).toISOString()})
  let races=0
  const result=await runLifecycle(env,{withMutation:passthrough,deleteContent:async(messageID,version)=>{
    // The outer SELECT observed an archived safe terminal. A manual send then
    // publishes a pending delivery without changing messages.version.
    races++;await delivery(env,messageID,revision,'pending')
    await deleteMessageContent(env,messageID,version,true)
  }})
  assert.equal(races,1);assert.equal(result.processed,0)
  const row=await read(env,id)
  assert.equal(row.content_deleted_at,null);assert.equal(row.content_bytes,140)
  assert.ok(env.objects.has(row.raw_key));assert.ok(env.objects.has(row.parsed_key))
  assert.equal((await env.DB.prepare('SELECT state FROM deliveries WHERE message_id=?').bind(id).first()).state,'pending')
})

test('preview binds policy, owner and version; history opt-in starts no immediate purge', async () => {
  const env = environment(), historical = await insert(env), fixed = await insert(env, { retention_policy_version: 1, raw_retention_days: 7, content_retention_days: 30 })
  const policy = { raw_retention_days: 3, content_retention_days: 20, ledger_retention_days: 180, apply_existing: true }
  await assert.rejects(patchSettings(request({ version: 1, ...policy }), env, 'owner'), /预览/)
  const query = new URLSearchParams(Object.entries(policy).map(([key, value]) => [key, String(value)]))
  const preview = await (await previewRetention(new Request(`https://mail.example.org/?${query}`), env, 'owner')).json()
  assert.equal(preview.historical_messages, 1); assert.equal(preview.bytes_to_clear, 0)
  await assert.rejects(patchSettings(request({ version: 1, ...policy, retention_confirmation: preview.preview_token }), env, 'other'), /预览/)
  await assert.rejects(patchSettings(request({ version: 1, ...policy, content_retention_days: 19, retention_confirmation: preview.preview_token }), env, 'owner'), /预览/)
  await patchSettings(request({ version: 1, ...policy, retention_confirmation: preview.preview_token }), env, 'owner')
  assert.equal((await read(env, historical)).raw_retention_days, 3); assert.equal((await read(env, historical)).retention_started_at, null)
  assert.equal((await read(env, historical)).content_deleted_at, null); assert.equal((await read(env, fixed)).raw_retention_days, 7)
  assert.equal((await captureLifecyclePolicy(env)).lifecycle_policy_version, 2)
})

test('future settings changes never adopt history implicitly', async () => {
  const env = environment(), historical = await insert(env)
  await patchSettings(request({ version: 1, raw_retention_days: 10, content_retention_days: 40 }), env, 'owner')
  assert.equal((await read(env, historical)).retention_policy_version, null); assert.equal((await captureLifecyclePolicy(env)).content_retention_days, 40)
})

test('alerts deduplicate daily, resolve and include only status metrics', async () => {
  const env = environment(), time = Date.now()
  await env.DB.prepare('UPDATE app_settings SET logical_bytes=4000000000,logical_limit_bytes=5000000000,created_at=?').bind(new Date(time - 40 * 3600000).toISOString()).run()
  await evaluateAlerts(env, time); await evaluateAlerts(env, time + 1000)
  const rows = (await env.DB.prepare('SELECT * FROM alert_notifications').all()).results
  assert.equal(rows.length, 2)
  for (const row of rows) { assert.equal(row.state, 'disabled'); assert.deepEqual(Object.keys(JSON.parse(row.payload_json)).sort(), ['type', 'id', 'code', 'state', 'severity', 'observed_at', 'metrics', 'management_path'].sort()) }
  await env.DB.prepare('UPDATE app_settings SET logical_bytes=0,last_backup_at=?').bind(new Date(time).toISOString()).run(); await evaluateAlerts(env, time + 2000)
  assert.equal((await env.DB.prepare("SELECT count(*) n FROM alert_notifications WHERE transition='resolved'").first()).n, 2)
  assert.equal((await env.DB.prepare('SELECT count(*) n FROM alerts WHERE active=1').first()).n, 0)
  assert.deepEqual(alertSignals({ logical_bytes: 96, logical_limit_bytes: 100, created_at: new Date(time).toISOString(), parse_failed: 0 }, time).filter(signal => signal.active).map(signal => signal.code), ['capacity_95'])
  const reserved=alertSignals({logical_bytes:20,logical_limit_bytes:100,capacity_used_bytes:96,capacity_limit_bytes:100,created_at:new Date(time).toISOString(),parse_failed:0},time).find(signal=>signal.active)
  assert.equal(reserved.code,'capacity_95');assert.equal(reserved.metrics.logical_bytes,20);assert.equal(reserved.metrics.used_bytes,96);assert.equal(reserved.metrics.capacity_accounting_available,1)
})

test('alert webhook enforces HTTPS host and retries exact bytes; authentication failure stops', async t => {
  const env = environment(), time = Date.now()
  Object.assign(env, { ALERT_WEBHOOK_URL: 'https://alerts.example.org/notify', ALERT_WEBHOOK_TOKEN: 's'.repeat(32) })
  assert.equal(alertConfiguration(env).configured, true)
  assert.equal(alertConfiguration({ ...env, ALERT_WEBHOOK_URL: 'https://other.example.org/notify' }).configuration_error, true)
  assert.equal(alertConfiguration({ ...env, ALERT_WEBHOOK_URL: 'http://alerts.example.org/notify' }).configuration_error, true)
  await env.DB.prepare('UPDATE app_settings SET logical_bytes=logical_limit_bytes').run(); await evaluateAlerts(env, time)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => { calls.push(options); return new Response(null, { status: calls.length === 1 ? 429 : 401, headers: { 'Retry-After': '120' } }) })
  await deliverAlert(env, time); assert.equal(await deliverAlert(env, time + 61000), false); await deliverAlert(env, time + 121000)
  assert.equal(calls.length, 2); assert.equal(calls[0].body, calls[1].body); assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key'])
  const row = await env.DB.prepare('SELECT * FROM alert_notifications').first()
  assert.equal(row.state, 'failed'); assert.equal(row.last_error, 'http_401'); assert.equal(row.attempts, 2)
  assert.equal(row.payload_json.includes(env.ALERT_WEBHOOK_TOKEN), false)
})

test('crashed final alert attempt cannot exceed durable retry limit', async t => {
  const env = environment(), time = Date.now()
  Object.assign(env, { ALERT_WEBHOOK_URL: 'https://alerts.example.org/notify', ALERT_WEBHOOK_TOKEN: 's'.repeat(32) })
  await env.DB.prepare('UPDATE app_settings SET logical_bytes=logical_limit_bytes').run(); await evaluateAlerts(env, time)
  await env.DB.prepare("UPDATE alert_notifications SET state='sending',attempts=8,lease_until=?").bind(new Date(time - 1000).toISOString()).run()
  t.mock.method(globalThis, 'fetch', async () => assert.fail('ninth network attempt'))
  await deliverAlert(env, time); assert.equal((await env.DB.prepare('SELECT state FROM alert_notifications').first()).state, 'failed')
})
