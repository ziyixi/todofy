import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { NEVER_DUE, captureLifecyclePolicy, expireRawContent, lifecycleStorage, resolvedFloorSQL, resolvedTerminalSQL, runLifecycle, safeTerminalSQL, terminalAnchorSQL } from '../src/native/lifecycle.ts'
import { alertConfiguration, alertSignals, alertSnapshot, deliverAlert, evaluateAlerts } from '../src/native/alerts.ts'
import { currentSettings, patchSettings, previewRetention } from '../src/native/api-settings.ts'
import { deleteMessageContent, runMaintenance } from '../src/native/pipeline.ts'

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

test('periodic maintenance queries are index ranges over due, unsettled or in-flight rows', async () => {
  const env=environment()
  const plan=async (sql, ...values)=>(await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all()).results.map(row=>row.detail)
  const uses=(details, index, search=true)=>assert.ok(details.some(detail=>detail.includes(index) && (!search || detail.startsWith('SEARCH'))),JSON.stringify(details))
  const unsettled="m.origin='cloudflare' AND m.content_deleted_at IS NULL AND m.retention_started_at IS NULL"
  uses(await plan(`SELECT m.id FROM messages m INDEXED BY messages_unsettled_idx WHERE ${unsettled} AND (m.received_at,m.id)>(?,?) ORDER BY m.received_at,m.id LIMIT 20`,'2026-01-01','x'),'messages_unsettled_idx')
  const due=await plan(`SELECT m.id,(${safeTerminalSQL()}) safe FROM messages m INDEXED BY messages_lifecycle_due_idx WHERE m.origin='cloudflare' AND m.content_deleted_at IS NULL
    AND m.lifecycle_due_at IS NOT NULL AND m.lifecycle_due_at<=? ORDER BY m.lifecycle_due_at,m.id LIMIT 1`,'2026-01-01')
  uses(due,'messages_lifecycle_due_idx'); assert.ok(!due.some(detail=>detail.includes('TEMP B-TREE')),JSON.stringify(due))
  uses(await plan(`SELECT id FROM messages INDEXED BY messages_due_missing_idx WHERE origin='cloudflare' AND content_deleted_at IS NULL AND retention_started_at IS NOT NULL AND lifecycle_due_at IS NULL LIMIT 50`),'messages_due_missing_idx',false)
  uses(await plan('SELECT sum(pending_delete_bytes) FROM messages INDEXED BY messages_pending_delete_idx WHERE pending_delete_bytes>0'),'messages_pending_delete_idx',false)
  uses(await plan(`SELECT min(received_at),sum(parse_state='failed') FROM messages INDEXED BY messages_live_lifecycle_idx
    WHERE origin='cloudflare' AND content_deleted_at IS NULL AND parse_state IN('pending','parsing','failed')`),'messages_live_lifecycle_idx')
  uses(await plan(`SELECT raw_key FROM messages INDEXED BY messages_live_lifecycle_idx WHERE parse_state='parsing' AND lease_until<=? AND origin='cloudflare' AND content_deleted_at IS NULL`,'2026-01-01'),'messages_live_lifecycle_idx')
  uses(await plan(`SELECT min(d.created_at) FROM deliveries d INDEXED BY deliveries_due_idx JOIN messages m ON m.id=d.message_id WHERE d.state IN('pending','retry_wait','sending') AND m.content_deleted_at IS NULL`),'deliveries_due_idx')
  uses(await plan(`SELECT id FROM alert_notifications INDEXED BY alert_notifications_created_idx WHERE created_at<? AND state IN('sent','failed','disabled') ORDER BY created_at LIMIT 20`,'2026-01-01'),'alert_notifications_created_idx')
  // Repair: legacy route blocks and events held past their window are found by partial indexes.
  uses(await plan(`SELECT id FROM endpoint_revisions INDEXED BY endpoint_revisions_uncooled_idx
    WHERE blocked_reason IS NOT NULL AND blocked_until IS NULL AND (blocked_reason IN('http_404','http_405') OR blocked_reason GLOB 'http_3[0-9][0-9]') AND blocked_rechecks<8`),'endpoint_revisions_uncooled_idx',false)
  // Resolved exceptions: the settings re-arm and the preview count read unsettled mail only.
  uses(await plan(`UPDATE messages AS m SET lifecycle_due_at=max(?,${resolvedFloorSQL('m')}) WHERE m.id IN(SELECT id FROM messages INDEXED BY messages_unsettled_idx
    WHERE origin='cloudflare' AND content_deleted_at IS NULL AND retention_started_at IS NULL AND resolved_at IS NOT NULL)
    AND EXISTS(SELECT 1 FROM app_settings WHERE id=1 AND version=? AND updated_at=?)`,'2026-01-01',2,'2026-01-01'),'messages_unsettled_idx',false)
  uses(await plan(`SELECT count(*) FROM messages m INDEXED BY messages_unsettled_idx WHERE ${unsettled} AND ${resolvedTerminalSQL()}`),'messages_unsettled_idx',false)
  uses(await plan(`UPDATE deliveries SET state='failed' WHERE event_id IN(SELECT event_id FROM deliveries INDEXED BY deliveries_waiting_created_idx
    WHERE state IN('pending','retry_wait') AND created_at<=? AND (retry_mode='auto' OR created_at<=?) ORDER BY created_at LIMIT 20)`,'2026-01-01','2026-01-01'),'deliveries_waiting_created_idx')
  const full=await plan('SELECT id FROM messages WHERE content_purge_pending=1 LIMIT 1')
  assert.ok(full.some(detail=>detail.includes('messages_content_purge_pending_idx')),JSON.stringify(full))
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
  // Two purged stages end the pass; the clock sweep follows in the next one.
  assert.equal((await read(env, newlySafe)).retention_started_at, null)
  await runLifecycle(env, { withMutation: passthrough, deleteContent: async () => assert.fail('nothing else is due') })
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

const DAY = 86400000
const iso = time => new Date(time).toISOString()
const policy = { retention_policy_version: 1, raw_retention_days: 7, content_retention_days: 30, ledger_retention_days: 180 }
const noDelete = { withMutation: passthrough, deleteContent: async () => assert.fail('unexpected content deletion') }

test('lifecycle due times: clock start, heal, raw stage, moved anchor and unsafe rows', async () => {
  const env = environment(), revision = await endpoint(env), time = Date.now()
  const fresh = await insert(env, policy)
  const started = iso(time - 2 * DAY)
  const healed = await insert(env, { ...policy, retention_started_at: started })
  const noRetention = await insert(env, { ...policy, content_retention_days: null, raw_retention_days: null, retention_started_at: started })
  const rawDue = await insert(env, { ...policy, retention_started_at: iso(time - 10 * DAY) })
  const moved = await insert(env, { ...policy, receive_mode: 'forward', endpoint_revision_id: revision, retention_started_at: iso(time - 10 * DAY), lifecycle_due_at: iso(time - 3 * DAY) })
  await delivery(env, moved, revision, 'delivered', { delivered_at: iso(time - DAY) })
  const unsafe = await insert(env, { ...policy, retention_started_at: iso(time - 40 * DAY), lifecycle_due_at: iso(time - 10 * DAY), needs_review: 1 })
  const result = await runLifecycle(env, noDelete)
  assert.equal(result.processed, 1)
  const clocked = await read(env, fresh)
  assert.ok(Date.parse(clocked.retention_started_at) >= time)
  assert.equal(clocked.lifecycle_due_at, iso(Date.parse(clocked.retention_started_at) + 7 * DAY), 'raw is the earliest stage')
  assert.equal((await read(env, healed)).lifecycle_due_at, iso(Date.parse(started) + 7 * DAY), 'rows clocked by an older Worker are healed')
  assert.equal((await read(env, noRetention)).lifecycle_due_at, NEVER_DUE)
  const raw = await read(env, rawDue)
  assert.ok(raw.raw_purged_at); assert.equal(raw.lifecycle_due_at, iso(time - 10 * DAY + 30 * DAY), 'after raw expiry only content remains due')
  assert.equal((await read(env, moved)).lifecycle_due_at, iso(time - DAY + 7 * DAY), 'a later delivery moves the anchor')
  const postponed = await read(env, unsafe)
  assert.equal(postponed.content_deleted_at, null); assert.ok(Date.parse(postponed.lifecycle_due_at) > time + DAY - 60_000)
  // Nothing else is due, so a second run touches no content.
  assert.equal((await runLifecycle(env, noDelete)).processed, 0)
})

test('the retention sweep pages through unsettled mail with a durable cursor', async () => {
  const env = environment(), base = Date.now() - 50 * DAY
  const ids = []
  for (let i = 0; i < 25; i++) ids.push(await insert(env, { ...policy, received_at: iso(base + i * 1000), last_received_at: iso(base + i * 1000), needs_review: i === 3 || i === 22 ? 0 : 1 }))
  const cursor = async () => (await env.DB.prepare("SELECT value FROM maintenance WHERE id='retention_sweep_cursor'").first())?.value
  assert.equal((await runLifecycle(env, noDelete)).continueSoon, true)
  assert.equal(await cursor(), `${iso(base + 19000)}|${ids[19]}`)
  assert.ok((await read(env, ids[3])).retention_started_at); assert.equal((await read(env, ids[22])).retention_started_at, null)
  await runLifecycle(env, noDelete)
  assert.equal(await cursor(), '', 'a short page restarts the sweep')
  assert.ok((await read(env, ids[22])).retention_started_at)
  assert.equal((await env.DB.prepare('SELECT count(*) n FROM messages WHERE retention_started_at IS NOT NULL').first()).n, 2)
})

test('alerts report stopped deliveries, policy errors and target state without failed-delivery saturation', async () => {
  const env = environment(), time = Date.now(), revision = await endpoint(env)
  const endpointID = (await env.DB.prepare('SELECT endpoint_id FROM endpoint_revisions WHERE id=?').bind(revision).first()).endpoint_id
  await env.DB.prepare('UPDATE webhook_endpoints SET current_revision_id=? WHERE id=?').bind(revision, endpointID).run()
  await env.DB.prepare("UPDATE app_settings SET mode='forward',current_endpoint_id=?,last_backup_at=?").bind(endpointID, iso(time)).run()
  const failed = await insert(env, { receive_mode: 'forward', endpoint_revision_id: revision })
  await delivery(env, failed, revision, 'failed', { created_at: iso(time - 5 * DAY) })
  await insert(env, { policy_error: 'policy_unavailable' })
  let snapshot = await alertSnapshot(env)
  assert.equal(snapshot.oldest_pending_at, null, 'a failed delivery is not pending forever')
  assert.equal(snapshot.delivery_failed, 1); assert.equal(snapshot.policy_error, 1)
  let active = alertSignals(snapshot, time).filter(signal => signal.active).map(signal => signal.code)
  assert.deepEqual(active.sort(), ['delivery_failed', 'policy_error'])
  // Retry now waits behind a blocked current revision with an automatic recheck.
  await env.DB.prepare("UPDATE deliveries SET state='retry_wait' WHERE message_id=?").bind(failed).run()
  await env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_404',blocked_until=? WHERE id=?").bind(iso(time + 3600_000), revision).run()
  snapshot = await alertSnapshot(env)
  assert.equal(snapshot.delivery_failed, 0); assert.equal(snapshot.oldest_pending_at, iso(time - 5 * DAY))
  const blocked = alertSignals(snapshot, time).find(signal => signal.code === 'endpoint_blocked')
  assert.equal(blocked.active, true); assert.equal(blocked.severity, 'critical')
  assert.deepEqual(blocked.metrics, { waiting_deliveries: 1, current_blocked: 1, auto_recheck: 1 })
  await env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason=NULL,blocked_until=NULL").run()
  await env.DB.prepare("UPDATE webhook_endpoints SET paused=1,paused_reason='retry_after_over_24h'").run()
  snapshot = await alertSnapshot(env)
  active = alertSignals(snapshot, time).filter(signal => signal.active)
  assert.deepEqual(active.map(signal => signal.code).sort(), ['endpoint_paused', 'pending_stale', 'policy_error'])
  assert.deepEqual(active.find(signal => signal.code === 'endpoint_paused').metrics, { waiting_deliveries: 1 })
  await evaluateAlerts(env, time)
  const stored = (await env.DB.prepare('SELECT code,metrics_json FROM alerts WHERE active=1 ORDER BY code').all()).results
  assert.deepEqual(stored.map(row => row.code), ['endpoint_paused', 'pending_stale', 'policy_error'])
  assert.ok(stored.every(row => !/@|http/.test(row.metrics_json)), 'metrics are counts only')
})

test('endpoint alert signals need the owner unless every waiting block rechecks automatically', () => {
  const base = { logical_bytes: 0, logical_limit_bytes: 100, created_at: new Date().toISOString(), last_backup_at: new Date().toISOString(), parse_failed: 0 }
  const signal = value => alertSignals({ ...base, ...value }).find(item => item.code === 'endpoint_blocked')
  assert.equal(signal({}).active, false)
  assert.deepEqual(signal({ blocked_waiting: 2, blocked_permanent_waiting: 0 }).metrics, { waiting_deliveries: 2, current_blocked: 0, auto_recheck: 1 })
  assert.deepEqual(signal({ blocked_waiting: 2, blocked_permanent_waiting: 1 }).metrics, { waiting_deliveries: 2, current_blocked: 0, auto_recheck: 0 })
  assert.deepEqual(signal({ current_blocked: 1, current_auto_recheck: 0 }).metrics, { waiting_deliveries: 0, current_blocked: 1, auto_recheck: 0 })
  assert.equal(alertSignals({ ...base, current_paused: 1 }).find(item => item.code === 'endpoint_paused').active, true)
  assert.deepEqual(alertSignals(base).filter(item => item.active), [])
})

test('confirming history clears any due time together with the clock', async () => {
  const env = environment(), historical = await insert(env, { lifecycle_due_at: '2026-01-01T00:00:00.000Z' })
  // Even a stale resolution on history restarts: every clock starts after the confirmation.
  const resolved = await insert(env, { policy_error: 'policy_unavailable', resolved_at: '2026-01-01T00:00:00.000Z', lifecycle_due_at: '2026-03-01T00:00:00.000Z' })
  const preview = await (await previewRetention(new Request('https://mail.example.org/?apply_existing=true'), env, 'owner')).json()
  await patchSettings(request({ version: 1, apply_existing: true, retention_confirmation: preview.preview_token }), env, 'owner')
  const row = await read(env, historical)
  assert.equal(row.retention_policy_version, 2); assert.equal(row.lifecycle_due_at, null)
  const adopted = await read(env, resolved)
  assert.equal(adopted.retention_policy_version, 2); assert.deepEqual([adopted.resolved_at, adopted.lifecycle_due_at], [null, null])
})

test('the lifecycle phase stays within the Free D1 per-invocation query budget in its worst case', async t => {
  const env = environment(), time = Date.now()
  env.MAIL_STORE.list = async () => ({ objects: [], truncated: false })
  for (let i = 0; i < 25; i++) await insert(env, { ...policy, needs_review: 1 })
  for (let i = 0; i < 2; i++) await insert(env, { ...policy, retention_started_at: iso(time - 50 * DAY), lifecycle_due_at: iso(time - 30 * DAY - i), needs_review: 1 })
  const deleted = []
  for (let i = 0; i < 3; i++) deleted.push(await insert(env, { ...policy, retention_started_at: iso(time - 40 * DAY), lifecycle_due_at: iso(time - 10 * DAY + i) }))
  await insert(env, { ...policy, retention_started_at: iso(time - 60 * DAY) })
  await env.DB.prepare("INSERT INTO maintenance(id,value) VALUES('maintenance_phase','lifecycle')").run()
  // Count every statement, including each statement inside a batch.
  let statements = 0
  const prepare = env.DB.prepare.bind(env.DB), batch = env.DB.batch.bind(env.DB)
  env.DB.prepare = sql => { const make = inner => ({ bind: (...values) => make(inner.bind(...values)), inner,
    async all() { statements++; return inner.all() }, async run() { statements++; return inner.run() }, async first() { statements++; return inner.first() } }); return make(prepare(sql)) }
  env.DB.batch = async list => { statements += list.length; return batch(list.map(item => item.inner)) }
  await runMaintenance(env)
  t.diagnostic(`worst-case lifecycle phase: ${statements} D1 statements`)
  assert.ok(statements <= 44, `lifecycle phase used ${statements} D1 statements`)
  assert.equal((await env.DB.prepare('SELECT count(*) n FROM messages WHERE content_deleted_at IS NOT NULL').first()).n, 2)
})

test('only owner-resolved exceptions qualify for the resolved period', async () => {
  const env = environment(), revision = await endpoint(env)
  const cases = {
    replayDelivered: [true, {}, ['failed', { last_error: 'retry_window_expired' }], ['delivered']],
    ownerCancelled: [true, {}, ['cancelled', { last_error: 'cancelled_by_owner' }]],
    cancelledThenDelivered: [true, {}, ['cancelled', { last_error: 'cancelled_by_owner' }], ['failed', { last_error: 'http_404' }], ['delivered']],
    laterReplayCancelled: [true, {}, ['failed'], ['delivered'], ['cancelled', { last_error: 'cancelled_by_owner' }]],
    policyErrorSent: [true, { policy_error: 'policy_revision_missing' }, ['delivered']],
    needsReviewSent: [true, { needs_review: 1 }, ['failed', { last_error: 'message_needs_review' }], ['delivered']],
    // A failure after the last delivered event is the owner's latest outcome: unresolved.
    deliveredThenFailed: [false, {}, ['delivered'], ['failed', { last_error: 'http_500' }]],
    laterReplayExpired: [false, {}, ['failed'], ['delivered'], ['failed', { last_error: 'retry_window_expired' }]],
    laterReplaySystemCancelled: [false, {}, ['failed'], ['delivered'], ['cancelled', { last_error: 'content_deleted' }]],
    // NULL-policy history adopts nothing, a policy error included.
    policyErrorHistory: [false, { retention_policy_version: null, policy_error: 'policy_unavailable' }, ['delivered']],
    windowExpired: [false, {}, ['failed', { last_error: 'retry_window_expired' }]],
    needsReview: [false, { needs_review: 1 }, ['failed', { last_error: 'message_needs_review' }]],
    systemCancelled: [false, {}, ['cancelled', { last_error: null }]],
    cancelledAndFailed: [false, {}, ['cancelled', { last_error: 'cancelled_by_owner' }], ['failed', { last_error: 'http_500' }]],
    replayPending: [false, {}, ['failed'], ['delivered'], ['pending']],
    replayRetrying: [false, {}, ['failed'], ['delivered'], ['retry_wait']],
    replaySending: [false, {}, ['failed'], ['delivered'], ['sending']],
    claimedEvent: [false, {}, ['failed'], ['delivered', { claim_token: 'claim' }]],
    reparsing: [false, { claim_token: 'claim', lease_until: '2999-01-01' }, ['failed'], ['delivered']],
    parseFailed: [false, { parse_state: 'failed' }, ['failed'], ['delivered']],
    noEvents: [false, {}],
    history: [false, { retention_policy_version: null }, ['failed'], ['delivered']],
    deleted: [false, { content_deleted_at: '2026-09-01' }, ['failed'], ['delivered']],
  }
  const ids = {}
  for (const [name, [, fields, ...events]] of Object.entries(cases)) {
    ids[name] = await insert(env, { ...policy, receive_mode: 'forward', endpoint_revision_id: revision, ...fields })
    for (const [index, [state, extra]] of events.entries()) await delivery(env, ids[name], revision, state, { generation: index + 1, ...extra })
  }
  const found = new Set((await env.DB.prepare(`SELECT m.id FROM messages m WHERE ${resolvedTerminalSQL()}`).all()).results.map(row => row.id))
  for (const [name, [expected]] of Object.entries(cases)) assert.equal(found.has(ids[name]), expected, name)
})

test('resolved deletions stay within the Free D1 per-invocation query budget in their worst case', async t => {
  const env = environment(), time = Date.now(), revision = await endpoint(env)
  env.MAIL_STORE.list = async () => ({ objects: [], truncated: false })
  for (let i = 0; i < 25; i++) await insert(env, { ...policy, needs_review: 1 })
  for (let i = 0; i < 2; i++) await insert(env, { ...policy, retention_started_at: iso(time - 50 * DAY), lifecycle_due_at: iso(time - 30 * DAY - i), needs_review: 1 })
  for (let i = 0; i < 3; i++) {
    const id = await insert(env, { ...policy, receive_mode: 'forward', endpoint_revision_id: revision, resolved_at: iso(time - 70 * DAY), lifecycle_due_at: iso(time - 10 * DAY + i) })
    await delivery(env, id, revision, 'failed', { last_error: 'retry_window_expired' }); await delivery(env, id, revision, 'delivered', { generation: 2 })
  }
  await env.DB.prepare("INSERT INTO maintenance(id,value) VALUES('maintenance_phase','lifecycle')").run()
  let statements = 0
  const prepare = env.DB.prepare.bind(env.DB), batch = env.DB.batch.bind(env.DB)
  env.DB.prepare = sql => { const make = inner => ({ bind: (...values) => make(inner.bind(...values)), inner,
    async all() { statements++; return inner.all() }, async run() { statements++; return inner.run() }, async first() { statements++; return inner.first() } }); return make(prepare(sql)) }
  env.DB.batch = async list => { statements += list.length; return batch(list.map(item => item.inner)) }
  await runMaintenance(env)
  t.diagnostic(`worst-case resolved lifecycle phase: ${statements} D1 statements`)
  assert.ok(statements <= 44, `lifecycle phase used ${statements} D1 statements`)
  assert.equal((await env.DB.prepare('SELECT count(*) n FROM messages WHERE content_deleted_at IS NOT NULL').first()).n, 2)
})

test('a settings update that loses its version race re-arms nothing; the winner re-arms from its committed period', async () => {
  const env = environment(), revision = await endpoint(env), time = Date.now(), resolvedAt = iso(time - 10 * DAY)
  const id = await insert(env, { ...policy, receive_mode: 'forward', endpoint_revision_id: revision, resolved_at: resolvedAt, lifecycle_due_at: iso(time + 50 * DAY) })
  await delivery(env, id, revision, 'failed', { last_error: 'retry_window_expired' }); await delivery(env, id, revision, 'delivered', { generation: 2 })
  // Both read version 1; the winner commits a longer period before the loser's batch runs.
  const batch = env.DB.batch.bind(env.DB)
  env.DB.batch = async list => { env.DB.batch = batch; await patchSettings(request({ version: 1, resolved_retention_days: 90 }), env, 'owner'); return batch(list) }
  await assert.rejects(patchSettings(request({ version: 1, resolved_retention_days: null }), env, 'owner'), error => error.status === 409)
  assert.equal((await currentSettings(env)).resolved_retention_days, 90)
  assert.equal((await read(env, id)).lifecycle_due_at, iso(Date.parse(resolvedAt) + 90 * DAY), 'the lower bound under the committed period, not cleared')
})

test('migration 0009 never leaves the resolved period shorter than the existing content period', () => {
  const directory = new URL('../migrations/', import.meta.url), files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort()
  const upgrade = content => {
    const sqlite = new DatabaseSync(':memory:')
    for (const file of files) {
      if (file.startsWith('0009')) sqlite.prepare('UPDATE app_settings SET content_retention_days=? WHERE id=1').run(content)
      sqlite.exec(readFileSync(new URL(file, directory), 'utf8'))
    }
    return { ...sqlite.prepare('SELECT content_retention_days,resolved_retention_days FROM app_settings WHERE id=1').get() }
  }
  assert.deepEqual(upgrade(30), { content_retention_days: 30, resolved_retention_days: 60 })
  assert.deepEqual(upgrade(90), { content_retention_days: 90, resolved_retention_days: 90 })
  assert.deepEqual(upgrade(null), { content_retention_days: null, resolved_retention_days: null }, 'content kept forever: resolved exceptions too')
})
