import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { detailOf, idOf, reasonOf, sendMessage } from './owner-api.mjs'
import { endpoint, environment, message, session, withRevision } from './native-env.mjs'
import { ROUTE_BLOCK_COOLDOWN_MS, ROUTE_BLOCK_GRACE_MS, ROUTE_BLOCK_MAX_RECHECKS, buildPayload, runJob, runMaintenance, syntheticTestMail } from '../src/native/pipeline.ts'
import { alertSignals, alertSnapshot } from '../src/native/alerts.ts'
import { CapacityLedger, reconcileCapacity } from '../src/native/capacity.ts'
import { decryptCredential, encryptCredential } from '../src/native/security.ts'

test('endpoint create retries share one identity and secrets are encrypted with revision binding', async () => {
  const env = environment(), api = await session(env), actionID = crypto.randomUUID()
  const [one, two] = await Promise.all([endpoint(api, {}, actionID), endpoint(api, {}, actionID)])
  assert.equal(one.id, two.id)
  assert.equal((await api('GET', '/endpoints')).data.endpoints.length, 1)
  assert.equal(JSON.stringify(one).includes('test-secret'), false)
  assert.equal('credential' in one, false)
  assert.equal(one.credential_configured, true)
  const stored = await env.DB.prepare('SELECT * FROM endpoint_revisions WHERE id=?').bind(one.current_revision_id).first()
  assert.notEqual(stored.credential_ciphertext, 'test-secret')
  assert.equal(await decryptCredential(env, stored.id, stored.url, stored.credential_ciphertext), 'test-secret')
  await assert.rejects(decryptCredential(env, stored.id, 'https://second.example.org/hooks/mail', stored.credential_ciphertext))
  const reused = await api('POST', `/endpoints?request_id=${actionID}`, { display_name: 'Different', uri: one.uri, credential: 'test-secret' })
  assert.equal(reused.status, 400)
  assert.equal(reasonOf(reused.data), 'REQUEST_ID_REUSED')
  assert.equal((await api('POST', '/endpoints', { display_name: 'No key', uri: one.uri, credential: 'test-secret' })).status, 400, 'request_id is required')
})

test('endpoint policy rejects private/unauthenticated targets and requires new credential for changed origin', async () => {
  const env = environment(), api = await session(env)
  const create = body => api('POST', `/endpoints?request_id=${crypto.randomUUID()}`, body)
  for (const uri of ['http://consumer.example.org/hooks/mail', 'https://127.0.0.1/hooks/mail', 'https://unlisted.example.org/hooks/mail', 'https://user:pass@consumer.example.org/hooks/mail']) {
    const refused = await create({ display_name: 'Bad', uri, credential: 'test-secret' })
    assert.equal(refused.status, 400)
    assert.equal(reasonOf(refused.data), 'TARGET_NOT_ALLOWED', uri)
  }
  const unauthenticated = await create({ display_name: 'Bad', uri: 'https://consumer.example.org/hooks', auth_type: 'none' })
  assert.deepEqual([unauthenticated.status, reasonOf(unauthenticated.data)], [400, 'AUTH_REQUIRED'])
  assert.equal(reasonOf((await create({ display_name: 'Bad', uri: 'https://consumer.example.org/hooks', auth_type: 'basic', credential: 'no-colon' })).data), 'INVALID_CREDENTIAL')
  const value = await endpoint(api)
  const update = (mask, body) => api('PATCH', `/endpoints/${value.id}?update_mask=${mask}`, body)
  const moved = await update('uri', { etag: value.etag, uri: 'https://second.example.org/hooks' })
  assert.deepEqual([moved.status, reasonOf(moved.data)], [400, 'CREDENTIAL_REQUIRED'])
  const changed = await update('uri,credential', { etag: value.etag, uri: 'https://second.example.org/hooks', credential: 'new-secret' })
  assert.equal(changed.status, 200, JSON.stringify(changed.data))
  assert.equal(changed.data.uri, 'https://second.example.org/hooks')
  assert.notEqual((await withRevision(api, changed.data)).current_revision_id, value.current_revision_id)
  const stale = await update('paused', { etag: value.etag, paused: true })
  assert.deepEqual([stale.status, reasonOf(stale.data)], [409, 'ETAG_MISMATCH'])
  // AIP-154: the mismatch carries the endpoint as it is now, the last detail, so no other GET is needed.
  assert.equal(stale.data.error.details.at(-1)['@type'], 'type.googleapis.com/mailhero.ui.v2.Endpoint')
  assert.deepEqual(detailOf(stale.data, 'mailhero.ui.v2.Endpoint'), (await api('GET', `/endpoints/${value.id}`)).data)
  assert.equal(detailOf(stale.data, 'mailhero.ui.v2.Endpoint').etag, changed.data.etag)
  // A full replacement could resume a paused target by accident: the mask is required.
  for (const mask of ['', '*']) assert.equal((await update(mask, { etag: changed.data.etag, display_name: 'Consumer', uri: changed.data.uri })).status, 400, mask)
  assert.equal((await api('PATCH', `/endpoints/${value.id}`, { etag: changed.data.etag, paused: true })).status, 400)
})

test('credential rotation changes same-origin revisions only, clears auth blocks and preserves identities', async () => {
  const env = environment(), api = await session(env)
  let value = await endpoint(api)
  const firstRevision = value.current_revision_id
  value = await withRevision(api, (await api('PATCH', `/endpoints/${value.id}?update_mask=uri`, { etag: value.etag, uri: 'https://consumer.example.org/hooks/v2' })).data)
  const secondRevision = value.current_revision_id
  const anotherID = crypto.randomUUID()
  await env.DB.prepare(`INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type,credential_ciphertext,created_at) VALUES(?,?,99,'https://second.example.org/hooks','bearer',?,?)`)
    .bind(anotherID, value.id, await encryptCredential(env, anotherID, 'https://second.example.org/hooks', 'separate'), new Date().toISOString()).run()
  await env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_401' WHERE id=?").bind(firstRevision).run()
  const result = await api('POST', `/endpoints/${value.id}:rotateCredential`, { etag: value.etag, credential: 'rotated-secret' })
  assert.equal(result.status, 200, JSON.stringify(result.data))
  assert.equal(result.data.affected_revision_count, 2)
  assert.equal(result.data.endpoint.etag, String(value.version + 1))
  for (const id of [firstRevision, secondRevision]) {
    const row = await env.DB.prepare('SELECT * FROM endpoint_revisions WHERE id=?').bind(id).first()
    assert.equal(await decryptCredential(env, id, row.url, row.credential_ciphertext), 'rotated-secret')
    assert.equal(row.blocked_reason, null)
    assert.equal(row.blocked_until, null)
  }
  const unrelated = await env.DB.prepare('SELECT * FROM endpoint_revisions WHERE id=?').bind(anotherID).first()
  assert.equal(await decryptCredential(env, anotherID, unrelated.url, unrelated.credential_ciphertext), 'separate')
})

test('endpoint diagnostics report only verified policy and synthetic tests are idempotent', async () => {
  const env = environment(), api = await session(env), target = await endpoint(api)
  const check = await api('GET', `/endpoints/${target.id}:check`)
  assert.equal(check.status, 200)
  assert.deepEqual(check.data, { uri_allowed: true, dns: 'not_checked', tls: 'not_checked', consumer: 'not_checked' })
  env.WEBHOOK_ALLOWED_HOSTS = 'second.example.org'
  assert.deepEqual((await api('GET', `/endpoints/${target.id}:check`)).data, { dns: 'blocked', tls: 'not_checked', consumer: 'not_checked' })
  env.WEBHOOK_ALLOWED_HOSTS = 'consumer.example.org,second.example.org'
  const action = crypto.randomUUID()
  const first = await api('POST', `/endpoints/${target.id}:test`, { request_id: action })
  assert.equal(first.status, 200, JSON.stringify(first.data))
  const second = await api('POST', `/endpoints/${target.id}:test`, { request_id: action })
  assert.deepEqual(Object.keys(first.data), ['delivery'])
  assert.equal(first.data.delivery.name, second.data.delivery.name)
  assert.deepEqual([first.data.delivery.state, first.data.delivery.retry_mode, first.data.delivery.endpoint], ['pending', 'once', `endpoints/${target.id}`])
  const eventID = idOf(first.data.delivery.name)
  assert.equal((await api('GET', '/messages')).data.messages, undefined, 'a synthetic test is not mail')
  assert.equal((await api('GET', '/deliveries')).data.deliveries.length, 1)
  assert.ok(env.jobs.length > 0)
  // The owner's connection test is unchanged by ops-v1: a single attempt, no canary marker, the golden bytes.
  const row = await env.DB.prepare('SELECT m.id,m.received_at,m.canary_run_id,d.retry_mode FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.event_id=?').bind(eventID).first()
  assert.equal(row.canary_run_id, null); assert.equal(row.retry_mode, 'once')
  const frozen = await (await env.MAIL_STORE.get(`payload/${eventID}.json`)).text()
  assert.equal(frozen, buildPayload(eventID, row.id, row.received_at, syntheticTestMail(), env.RECEIVE_ADDRESS, env.RECEIVE_ADDRESS))
  assert.equal('canary' in JSON.parse(frozen), false)
  const delivery = (await api('GET', `/deliveries/${eventID}`)).data
  assert.equal(delivery.canary, undefined)
  assert.equal((await api('GET', `/messages/${idOf(delivery.message)}`)).status, 404, 'the synthetic message is not answered')
})

test('setup does not claim real routing success; scheduler failure remains visible without breaking mailbox settings', async () => {
  const env = environment(), api = await session(env)
  env.COORDINATOR.get = () => ({ async fetch() { return Response.json({ pending: 3, failed: 2, oldest: Date.now() - 60000, next_alarm: null }) } })
  const status = await api('GET', '/setupStatus')
  assert.equal(status.status, 200)
  assert.equal(status.data.checks.find(item => item.id === 'edge').result, 'pending')
  assert.equal(status.data.checks.find(item => item.id === 'received').result, 'pending')
  assert.equal(status.data.checks.find(item => item.id === 'scheduler').result, 'warning')
  const overview = await api('GET', '/overview')
  assert.equal(overview.data.scheduler.failed_job_count, 2)
  assert.ok(overview.data.warnings.some(item => item.includes('失败记录')))
  assert.ok(overview.data.warnings.some(item => item.includes('alarm')))
  env.COORDINATOR.get = () => ({ async fetch() { throw new Error('secret-internal-error') } })
  const offline = await api('GET', '/overview')
  assert.equal(offline.status, 200)
  assert.equal(offline.data.scheduler.available, undefined)
  assert.equal(JSON.stringify(offline.data).includes('secret-internal-error'), false)
  assert.equal((await api('GET', '/settings')).status, 200)
})

// Problem 3: route-class rejections must not silently and permanently halt forwarding.
async function queued(env, api) {
  const target = await endpoint(api), id = await message(env)
  const sent = await sendMessage(api, id, target.id)
  assert.equal(sent.status, 200, JSON.stringify(sent.data))
  return { target, eventID: idOf(sent.data.delivery.name) }
}
/** GetEndpoint's wire Endpoint. */
const getEndpoint = async (api, id) => (await api('GET', `/endpoints/${id}`)).data
const deliveryRow = (env, id) => env.DB.prepare('SELECT * FROM deliveries WHERE event_id=?').bind(id).first()
const revisionRow = (env, id) => env.DB.prepare('SELECT r.* FROM endpoint_revisions r JOIN deliveries d ON d.endpoint_revision_id=r.id WHERE d.event_id=?').bind(id).first()
// Advances only persisted pacing clocks; production backoff and cooldowns stay intact.
async function attempt(t, env, eventID, status, { due = true } = {}) {
  const statements = [env.DB.prepare('UPDATE webhook_endpoints SET next_send_at=NULL'), env.DB.prepare('UPDATE app_settings SET next_send_at=NULL')]
  if (due) statements.push(env.DB.prepare("UPDATE deliveries SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE event_id=?").bind(eventID))
  await env.DB.batch(statements)
  let calls = 0
  const fetch = t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status }) })
  try {
    const next = await runJob(env, { type: 'deliver', eventID })
    const outcome = (await env.DB.prepare('SELECT outcome FROM delivery_attempts WHERE event_id=? ORDER BY attempt_no DESC LIMIT 1').bind(eventID).first())?.outcome
    return { next, calls, outcome, delivery: await deliveryRow(env, eventID), revision: await revisionRow(env, eventID) }
  } finally { fetch.mock.restore() }
}

test('404, 405 and redirects retry within the grace period without blocking the revision', async t => {
  const env = environment(), api = await session(env), { eventID } = await queued(env, api)
  const first = await attempt(t, env, eventID, 404)
  assert.equal(first.calls, 1)
  assert.equal(first.delivery.state, 'retry_wait'); assert.equal(first.delivery.last_error, 'http_404'); assert.equal(first.outcome, 'retryable')
  assert.equal(first.revision.blocked_reason, null); assert.equal(first.revision.blocked_until, null)
  assert.ok(first.delivery.blocking_since); assert.equal(first.next, Date.parse(first.delivery.next_attempt_at))
  for (const status of [405, 308]) {
    const again = await attempt(t, env, eventID, status)
    assert.equal(again.delivery.state, 'retry_wait'); assert.equal(again.revision.blocked_reason, null)
    assert.equal(again.delivery.blocking_since, first.delivery.blocking_since, 'one rejection episode keeps its start')
  }
  const recovered = await attempt(t, env, eventID, 503)
  assert.equal(recovered.delivery.blocking_since, null, 'a non-route outcome ends the episode')
})

test('a route rejection after the grace period blocks with an automatic recheck; success clears it and another 404 re-blocks', async t => {
  const env = environment(), api = await session(env), { target, eventID } = await queued(env, api)
  await env.DB.prepare('UPDATE deliveries SET blocking_since=? WHERE event_id=?').bind(new Date(Date.now() - ROUTE_BLOCK_GRACE_MS - 60_000).toISOString(), eventID).run()
  const blocked = await attempt(t, env, eventID, 404)
  assert.equal(blocked.revision.blocked_reason, 'http_404'); assert.equal(blocked.outcome, 'rejected')
  const until = Date.parse(blocked.revision.blocked_until)
  assert.ok(Math.abs(until - Date.now() - ROUTE_BLOCK_COOLDOWN_MS) < 60_000)
  assert.equal(blocked.delivery.state, 'retry_wait'); assert.equal(blocked.delivery.next_attempt_at, blocked.revision.blocked_until)
  assert.equal(blocked.next, until, 'the scheduler job re-runs at the end of the cooldown')
  assert.equal(new Date((await getEndpoint(api, target.id)).block_expire_time).toISOString(), blocked.revision.blocked_until)
  // New mail frozen onto the blocked revision waits for the same recheck.
  const later = await sendMessage(api, await message(env), target.id)
  const waiting = await attempt(t, env, idOf(later.data.delivery.name), 204)
  assert.equal(waiting.calls, 0); assert.equal(waiting.next, until); assert.equal(waiting.delivery.state, 'pending')
  const gated = await attempt(t, env, eventID, 204, { due: false })
  assert.equal(gated.calls, 0); assert.equal(gated.next, until)
  // Cooldown over: a still-missing route re-blocks at once, without a new grace period.
  await env.DB.prepare("UPDATE endpoint_revisions SET blocked_until='2000-01-01T00:00:00.000Z' WHERE id=?").bind(blocked.revision.id).run()
  const reblocked = await attempt(t, env, eventID, 404)
  assert.equal(reblocked.calls, 1); assert.equal(reblocked.revision.blocked_reason, 'http_404'); assert.ok(Date.parse(reblocked.revision.blocked_until) > Date.now())
  await env.DB.prepare("UPDATE endpoint_revisions SET blocked_until='2000-01-01T00:00:00.000Z' WHERE id=?").bind(blocked.revision.id).run()
  const delivered = await attempt(t, env, eventID, 204)
  assert.equal(delivered.calls, 1); assert.equal(delivered.delivery.state, 'delivered'); assert.equal(delivered.delivery.blocking_since, null)
  assert.equal(delivered.revision.blocked_reason, null); assert.equal(delivered.revision.blocked_until, null)
})

test('401 and 403 block permanently until the owner acts', async t => {
  for (const status of [401, 403]) {
    const env = environment(), api = await session(env), { eventID } = await queued(env, api)
    const rejected = await attempt(t, env, eventID, status)
    assert.equal(rejected.revision.blocked_reason, `http_${status}`); assert.equal(rejected.revision.blocked_until, null)
    assert.equal(rejected.delivery.state, 'retry_wait'); assert.equal(rejected.delivery.blocking_since, null)
    assert.equal(rejected.next, null); assert.equal(rejected.outcome, 'rejected')
    const halted = await attempt(t, env, eventID, 204)
    assert.equal(halted.calls, 0); assert.equal(halted.next, null)
  }
})

test('a manual single attempt blocks a route rejection immediately with the cooldown and is not resent', async t => {
  const env = environment(), api = await session(env), { eventID } = await queued(env, api)
  // Owner retry of an exhausted automatic event is one manual attempt, beyond the 48-attempt cap.
  await env.DB.prepare("UPDATE deliveries SET state='failed',last_error='retry_window_expired',attempt_count=60 WHERE event_id=?").bind(eventID).run()
  assert.equal((await api('POST', `/deliveries/${eventID}:retry`, { request_id: crypto.randomUUID() })).status, 200)
  assert.equal((await deliveryRow(env, eventID)).retry_mode, 'once')
  const rejected = await attempt(t, env, eventID, 405)
  assert.equal(rejected.revision.blocked_reason, 'http_405'); assert.ok(Date.parse(rejected.revision.blocked_until) > Date.now() + ROUTE_BLOCK_COOLDOWN_MS - 60_000)
  assert.equal(rejected.outcome, 'rejected'); assert.equal(rejected.delivery.state, 'failed'); assert.equal(rejected.next, null)
  // Automatic events recheck when the cooldown ends; the manual attempt is over.
  await env.DB.prepare("UPDATE endpoint_revisions SET blocked_until='2000-01-01T00:00:00.000Z' WHERE id=?").bind(rejected.revision.id).run()
  const later = await attempt(t, env, eventID, 204)
  assert.equal(later.calls, 0); assert.equal(later.next, null); assert.equal(later.delivery.state, 'failed')
})

test('the send claim respects a cooldown that appears after the gate', async t => {
  for (const [until, sent] of [[new Date(Date.now() + 3600_000).toISOString(), 0], ['2000-01-01T00:00:00.000Z', 1]]) {
    const env = environment(), api = await session(env), { eventID } = await queued(env, api)
    const get = env.MAIL_STORE.get.bind(env.MAIL_STORE)
    // The payload read happens between the gate and the claim UPDATE.
    env.MAIL_STORE.get = async key => {
      if (key.startsWith('payload/')) await env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_404',blocked_until=?").bind(until).run()
      return get(key)
    }
    const result = await attempt(t, env, eventID, 204)
    assert.equal(result.calls, sent, until)
    assert.equal(result.delivery.state, sent ? 'delivered' : 'pending')
    assert.equal(result.delivery.attempt_count, sent)
  }
})

test('owner unblock clears every revision of the endpoint, retries waiting events now and wakes the scheduler', async () => {
  const env = environment(), api = await session(env)
  const target = await endpoint(api)
  const changed = await withRevision(api, (await api('PATCH', `/endpoints/${target.id}?update_mask=uri`, { etag: target.etag, uri: 'https://consumer.example.org/hooks/v2' })).data)
  const future = new Date(Date.now() + 5 * 3600_000).toISOString()
  await env.DB.batch([
    env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_404',blocked_until=? WHERE id=?").bind(future, target.current_revision_id),
    env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_401' WHERE id=?").bind(changed.current_revision_id),
  ])
  const events = []
  for (const revision of [target.current_revision_id, changed.current_revision_id]) {
    const id = await message(env), eventID = crypto.randomUUID()
    await env.DB.prepare(`INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,payload_key,payload_sha256,state,next_attempt_at,created_at,blocking_since)
      VALUES(?,?,?,1,?,'synthetic-hash','retry_wait',?,?,?)`).bind(eventID, id, revision, `payload/${eventID}.json`, future, new Date().toISOString(), new Date(Date.now() - 3600_000).toISOString()).run()
    events.push(eventID)
  }
  const listed = (await api('GET', '/endpoints')).data.endpoints[0]
  assert.equal(listed.blocked_reason, 'http_401'); assert.equal(listed.block_expire_time, undefined)
  const staleUnblock = await api('POST', `/endpoints/${target.id}:unblock`, { etag: target.etag })
  assert.deepEqual([staleUnblock.status, detailOf(staleUnblock.data, 'mailhero.ui.v2.Endpoint')?.etag], [409, changed.etag])
  assert.equal((await api('POST', `/endpoints/${crypto.randomUUID()}:unblock`, { etag: '1' })).status, 404)
  const before = env.wakes.length, actionID = crypto.randomUUID()
  const result = await api('POST', `/endpoints/${target.id}:unblock`, { etag: changed.etag, request_id: actionID })
  assert.equal(result.status, 200, JSON.stringify(result.data))
  assert.equal(result.data.affected_revision_count, 2)
  assert.equal(result.data.endpoint.etag, String(changed.version + 1))
  assert.equal(env.wakes.length, before + 1)
  const revisions = (await env.DB.prepare('SELECT blocked_reason,blocked_until FROM endpoint_revisions WHERE endpoint_id=?').bind(target.id).all()).results
  assert.deepEqual(revisions.map(row => ({ ...row })), [{ blocked_reason: null, blocked_until: null }, { blocked_reason: null, blocked_until: null }])
  for (const eventID of events) {
    const row = await deliveryRow(env, eventID)
    assert.equal(row.blocking_since, null); assert.ok(Date.parse(row.next_attempt_at) <= Date.now()); assert.equal(row.state, 'retry_wait')
  }
  const replay = await api('POST', `/endpoints/${target.id}:unblock`, { etag: changed.etag, request_id: actionID })
  assert.deepEqual(replay.data, result.data, 'a lost response replays the original result')
  assert.equal((await getEndpoint(api, target.id)).etag, String(changed.version + 1))
  assert.equal((await env.DB.prepare("SELECT count(*) n FROM maintenance WHERE id LIKE 'endpoint_unblock:%'").first()).n, 0)
})

test('overview counts come from trigger-maintained counters that match the ledger', async () => {
  const env = environment(), api = await session(env), target = await endpoint(api)
  const ids = [await message(env), await message(env), await message(env)]
  await env.DB.prepare("UPDATE messages SET origin='synthetic_test' WHERE id=?").bind(ids[2]).run()
  const states = ['pending', 'retry_wait', 'sending', 'delivered', 'failed', 'cancelled']
  for (const [index, state] of states.entries()) {
    await env.DB.prepare(`INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,payload_sha256,state,next_attempt_at,created_at)
      VALUES(?,?,?,?,'synthetic-hash',?,'2026-09-25T00:00:00.000Z','2026-09-25T00:00:00.000Z')`).bind(crypto.randomUUID(), ids[index % 2], target.current_revision_id, index + 1, state).run()
  }
  await env.DB.prepare("UPDATE deliveries SET state='delivered' WHERE state IN('sending','retry_wait')").run()
  await env.DB.prepare("UPDATE deliveries SET state='failed' WHERE state='cancelled'").run()
  await env.DB.prepare("DELETE FROM deliveries WHERE state='pending'").run()
  await env.DB.prepare("UPDATE messages SET parse_state='failed' WHERE id=?").bind(ids[1]).run()
  const expected = await env.DB.prepare(`SELECT (SELECT count(*) FROM messages WHERE origin='cloudflare') messages,
    (SELECT count(*) FROM deliveries WHERE state IN('pending','retry_wait','sending')) pending,(SELECT count(*) FROM deliveries WHERE state='failed') failed,
    (SELECT count(*) FROM deliveries WHERE state='delivered') delivered,1 parse_failed`).first()
  const overview = await api('GET', '/overview')
  assert.equal(overview.status, 200)
  const counts = ({ message_count = 0, pending_delivery_count = 0, failed_delivery_count = 0, delivered_count = 0, parse_failed_count = 0 }) =>
    ({ messages: message_count, pending: pending_delivery_count, failed: failed_delivery_count, delivered: delivered_count, parse_failed: parse_failed_count })
  assert.deepEqual(counts(overview.data), { ...expected })
  assert.deepEqual(counts(overview.data), { messages: 2, pending: 0, failed: 2, delivered: 3, parse_failed: 1 })
})

test('owner unblock keeps the persistent backoff of events that no block was holding', async () => {
  const env = environment(), api = await session(env), { target, eventID } = await queued(env, api)
  const future = new Date(Date.now() + 5 * 3600_000).toISOString()
  await env.DB.prepare("UPDATE deliveries SET state='retry_wait',last_error='http_503',next_attempt_at=?,blocking_since=? WHERE event_id=?").bind(future, new Date().toISOString(), eventID).run()
  const current = await getEndpoint(api, target.id)
  const result = await api('POST', `/endpoints/${target.id}:unblock`, { etag: current.etag })
  assert.equal(result.data.affected_revision_count, undefined, 'no revision was blocked (0 is omitted)')
  assert.equal(result.data.endpoint.etag, String(Number(current.etag) + 1))
  const row = await deliveryRow(env, eventID)
  assert.equal(row.next_attempt_at, future); assert.equal(row.blocking_since, null)
})

test('an expired cooldown is sendable, so it is neither a paused delivery nor an active block', async () => {
  const env = environment(), api = await session(env), { target, eventID } = await queued(env, api)
  await env.DB.batch([env.DB.prepare("UPDATE app_settings SET mode='forward',current_endpoint_id=?").bind(target.id),
    env.DB.prepare("UPDATE deliveries SET state='retry_wait' WHERE event_id=?").bind(eventID)])
  for (const [until, blocked] of [[new Date(Date.now() + 3600_000).toISOString(), 1], ['2000-01-01T00:00:00.000Z', 0], [null, 1]]) {
    await env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_404',blocked_until=?").bind(until).run()
    assert.equal((await api('GET', `/deliveries/${eventID}`)).data.effective_state, blocked ? 'paused' : 'retry_wait', String(until))
    const snapshot = await alertSnapshot(env)
    assert.equal(snapshot.current_blocked, blocked, String(until)); assert.equal(snapshot.blocked_waiting, blocked, String(until))
  }
})

// The repair phase, with the raw-object scan already checkpointed and a scheduler stub.
async function repair(env) {
  await env.DB.batch([env.DB.prepare("DELETE FROM maintenance WHERE id='maintenance_phase'"),
    env.DB.prepare("INSERT OR REPLACE INTO maintenance(id,value) VALUES('raw_reconcile_after',?)").bind(String(Date.now() + 86400000))])
  const get = env.COORDINATOR.get
  env.COORDINATOR.get = id => { const stub = get(id); return { fetch: (url, init) => new URL(url).pathname === '/capacity/reconcile' ? Response.json({ checked: 0, released: 0 }) : stub.fetch(url, init) } }
  try { return (await runMaintenance(env)).jobs.filter(job => job.type === 'deliver').map(job => job.eventID).sort() }
  finally { env.COORDINATOR.get = get }
}

test('repair rechecks route blocks written without a cooldown, expires events held past their window and enqueues only due events', async t => {
  const env = environment(), api = await session(env), day = 86400000, ago = ms => new Date(Date.now() - ms).toISOString()
  // A 404 block as the previous Worker wrote it: no blocked_until.
  const legacy = await queued(env, api)
  await env.DB.batch([env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_404',blocked_until=NULL WHERE endpoint_id=?").bind(legacy.target.id),
    env.DB.prepare("UPDATE deliveries SET state='retry_wait',next_attempt_at=? WHERE event_id=?").bind(ago(60_000), legacy.eventID)])
  // An auth block holds automatic and manual events of several ages.
  const auth = await endpoint(api), held = {}
  for (const [name, mode, age] of [['expired', 'auto', 8 * day], ['manual', 'once', 8 * day], ['recent', 'auto', 60_000]]) {
    const sent = await sendMessage(api, await message(env), auth.id)
    held[name] = idOf(sent.data.delivery.name)
    await env.DB.prepare("UPDATE deliveries SET state='retry_wait',retry_mode=?,created_at=?,next_attempt_at=? WHERE event_id=?").bind(mode, ago(age), ago(60_000), held[name]).run()
  }
  await env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_401',blocked_until=NULL WHERE endpoint_id=?").bind(auth.id).run()
  // An unblocked target: one event due now, one still in its backoff.
  const due = await queued(env, api), backoff = await queued(env, api)
  await env.DB.batch([env.DB.prepare("UPDATE deliveries SET state='retry_wait',next_attempt_at=? WHERE event_id=?").bind(ago(60_000), due.eventID),
    env.DB.prepare("UPDATE deliveries SET state='retry_wait',next_attempt_at=? WHERE event_id=?").bind(new Date(Date.now() + 3600_000).toISOString(), backoff.eventID)])
  const jobs = await repair(env)
  assert.deepEqual(jobs, [legacy.eventID, due.eventID].sort(), 'blocked, expired and not-yet-due events are not enqueued')
  const revision = id => env.DB.prepare('SELECT blocked_reason,blocked_until FROM endpoint_revisions WHERE endpoint_id=?').bind(id).first()
  const converted = await revision(legacy.target.id)
  assert.equal(converted.blocked_reason, 'http_404'); assert.ok(Date.parse(converted.blocked_until) <= Date.now())
  assert.deepEqual({ ...await revision(auth.id) }, { blocked_reason: 'http_401', blocked_until: null })
  const states = Object.fromEntries(await Promise.all(Object.entries(held).map(async ([name, id]) => [name, (await deliveryRow(env, id))])))
  assert.equal(states.expired.state, 'failed'); assert.equal(states.expired.last_error, 'retry_window_expired')
  assert.equal(states.manual.state, 'retry_wait', 'a manual retry keeps its 30-day window'); assert.equal(states.recent.state, 'retry_wait')
  // The legacy block now clears on success like any automatic-recheck block.
  const delivered = await attempt(t, env, legacy.eventID, 204)
  assert.equal(delivered.calls, 1); assert.equal(delivered.delivery.state, 'delivered')
  assert.deepEqual({ ...await revision(legacy.target.id) }, { blocked_reason: null, blocked_until: null })
})

// Bounded automatic rechecks: eight cooldowns (about two days), then the owner decides.
const expireCooldown = (env, revision) => env.DB.prepare("UPDATE endpoint_revisions SET blocked_until='2000-01-01T00:00:00.000Z' WHERE id=?").bind(revision).run()
const pastGrace = (env, eventID) => env.DB.prepare('UPDATE deliveries SET blocking_since=? WHERE event_id=?').bind(new Date(Date.now() - ROUTE_BLOCK_GRACE_MS - 60_000).toISOString(), eventID).run()

test('route blocks recheck automatically eight times, about two days, then stay blocked until the owner acts', async t => {
  assert.equal(ROUTE_BLOCK_MAX_RECHECKS, 8)
  const env = environment(), api = await session(env), { target, eventID } = await queued(env, api)
  await env.DB.prepare("UPDATE app_settings SET mode='forward',current_endpoint_id=?").bind(target.id).run()
  await pastGrace(env, eventID)
  let result = await attempt(t, env, eventID, 404)
  assert.equal(result.revision.blocked_rechecks, 1); assert.equal(result.next, Date.parse(result.revision.blocked_until))
  assert.equal((await getEndpoint(api, target.id)).blocked_recheck_count, 1)
  let cooldowns = 1
  // Every recheck at the end of a cooldown arms the next until eight were armed.
  for (let recheck = 1; recheck < ROUTE_BLOCK_MAX_RECHECKS; recheck++) {
    await expireCooldown(env, result.revision.id)
    result = await attempt(t, env, eventID, 404)
    assert.equal(result.calls, 1); assert.equal(result.outcome, 'rejected'); assert.equal(result.delivery.state, 'retry_wait')
    assert.equal(result.revision.blocked_rechecks, recheck + 1); assert.ok(Date.parse(result.revision.blocked_until) > Date.now() + ROUTE_BLOCK_COOLDOWN_MS - 60_000)
    assert.equal(result.next, Date.parse(result.revision.blocked_until)); cooldowns++
  }
  assert.equal(cooldowns * ROUTE_BLOCK_COOLDOWN_MS, 48 * 3600_000)
  // The eighth recheck is the last: the block becomes permanent, like an auth rejection.
  await expireCooldown(env, result.revision.id)
  result = await attempt(t, env, eventID, 404)
  assert.equal(result.calls, 1); assert.equal(result.outcome, 'rejected'); assert.equal(result.next, null)
  assert.deepEqual({ reason: result.revision.blocked_reason, until: result.revision.blocked_until, rechecks: result.revision.blocked_rechecks }, { reason: 'http_404', until: null, rechecks: 8 })
  assert.equal(result.delivery.state, 'retry_wait'); assert.equal(result.delivery.last_error, 'http_404')
  const halted = await attempt(t, env, eventID, 204)
  assert.equal(halted.calls, 0); assert.equal(halted.next, null); assert.equal(halted.delivery.state, 'retry_wait')
  const listed = await getEndpoint(api, target.id)
  assert.equal(listed.blocked_recheck_count, 8); assert.equal(listed.block_expire_time, undefined); assert.equal(listed.blocked_reason, 'http_404')
  // Alerts treat it as permanent: no automatic recheck remains.
  const snapshot = await alertSnapshot(env)
  assert.equal(snapshot.current_blocked, 1); assert.equal(snapshot.current_auto_recheck, 0); assert.equal(snapshot.blocked_permanent_waiting, 1)
  assert.equal(alertSignals(snapshot).find(signal => signal.code === 'endpoint_blocked').metrics.auto_recheck, 0)
  // The repair phase never re-arms it.
  await repair(env)
  assert.equal((await revisionRow(env, eventID)).blocked_until, null)
})

test('a delivered recheck clears the block and resets its recheck count', async t => {
  const env = environment(), api = await session(env), { target, eventID } = await queued(env, api)
  await pastGrace(env, eventID)
  let result = await attempt(t, env, eventID, 404)
  for (let i = 0; i < 2; i++) { await expireCooldown(env, result.revision.id); result = await attempt(t, env, eventID, 308) }
  assert.equal(result.revision.blocked_rechecks, 3)
  await expireCooldown(env, result.revision.id)
  const delivered = await attempt(t, env, eventID, 204)
  assert.equal(delivered.delivery.state, 'delivered')
  assert.deepEqual({ reason: delivered.revision.blocked_reason, until: delivered.revision.blocked_until, rechecks: delivered.revision.blocked_rechecks }, { reason: null, until: null, rechecks: 0 })
  assert.equal((await getEndpoint(api, target.id)).blocked_recheck_count, undefined, '0 is omitted')
  // Success never lifts a permanent block or its count: those need the owner.
  await env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_401',blocked_rechecks=2 WHERE id=?").bind(delivered.revision.id).run()
  const later = await sendMessage(api, await message(env), target.id)
  const gated = await attempt(t, env, idOf(later.data.delivery.name), 204)
  assert.equal(gated.calls, 0); assert.equal(gated.revision.blocked_reason, 'http_401'); assert.equal(gated.revision.blocked_rechecks, 2)
})

test('owner unblock and credential rotation reset the recheck count of the blocks they clear', async t => {
  const env = environment(), api = await session(env), { target, eventID } = await queued(env, api)
  const revision = target.current_revision_id
  await env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_404',blocked_until=NULL,blocked_rechecks=8 WHERE id=?").bind(revision).run()
  const result = await api('POST', `/endpoints/${target.id}:unblock`, { etag: target.etag })
  assert.equal(result.data.affected_revision_count, 1)
  assert.equal(result.data.endpoint.etag, String(target.version + 1))
  assert.deepEqual({ ...await env.DB.prepare('SELECT blocked_reason,blocked_until,blocked_rechecks FROM endpoint_revisions WHERE id=?').bind(revision).first() },
    { blocked_reason: null, blocked_until: null, blocked_rechecks: 0 })
  // A still-missing route gets its grace again, then a fresh set of rechecks.
  const retried = await attempt(t, env, eventID, 404)
  assert.equal(retried.revision.blocked_reason, null); assert.equal(retried.outcome, 'retryable')
  await pastGrace(env, eventID)
  assert.equal((await attempt(t, env, eventID, 404)).revision.blocked_rechecks, 1)
  // Rotation clears auth-class blocks only, and with them their count; a URL change starts at zero.
  const changed = await withRevision(api, (await api('PATCH', `/endpoints/${target.id}?update_mask=uri`, { etag: String(target.version + 1), uri: 'https://consumer.example.org/hooks/v2' })).data)
  assert.equal(changed.blocked_recheck_count, undefined, '0 is omitted')
  await env.DB.batch([
    env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_404',blocked_until=NULL,blocked_rechecks=8 WHERE id=?").bind(revision),
    env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_401',blocked_until=NULL,blocked_rechecks=3 WHERE id=?").bind(changed.current_revision_id),
  ])
  assert.equal((await api('POST', `/endpoints/${target.id}:rotateCredential`, { etag: changed.etag, credential: 'rotated-secret' })).status, 200)
  const rows = Object.fromEntries((await env.DB.prepare('SELECT id,blocked_reason,blocked_rechecks FROM endpoint_revisions WHERE endpoint_id=?').bind(target.id).all()).results.map(row => [row.id, [row.blocked_reason, row.blocked_rechecks]]))
  assert.deepEqual(rows, { [revision]: ['http_404', 8], [changed.current_revision_id]: [null, 0] })
})

test('the repair phase converts legacy route blocks only while automatic rechecks remain', async () => {
  const env = environment(), api = await session(env), ago = new Date(Date.now() - 60_000).toISOString()
  const legacy = await queued(env, api), exhausted = await queued(env, api)
  await env.DB.batch([
    env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_404',blocked_until=NULL,blocked_rechecks=3 WHERE endpoint_id=?").bind(legacy.target.id),
    env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_302',blocked_until=NULL,blocked_rechecks=8 WHERE endpoint_id=?").bind(exhausted.target.id),
    env.DB.prepare("UPDATE deliveries SET state='retry_wait',next_attempt_at=? WHERE event_id IN(?,?)").bind(ago, legacy.eventID, exhausted.eventID),
  ])
  assert.deepEqual(await repair(env), [legacy.eventID], 'the exhausted block holds its event')
  const revision = id => env.DB.prepare('SELECT blocked_reason,blocked_until,blocked_rechecks FROM endpoint_revisions WHERE endpoint_id=?').bind(id).first()
  const converted = await revision(legacy.target.id)
  assert.equal(converted.blocked_reason, 'http_404'); assert.ok(Date.parse(converted.blocked_until) <= Date.now()); assert.equal(converted.blocked_rechecks, 3)
  assert.deepEqual({ ...await revision(exhausted.target.id) }, { blocked_reason: 'http_302', blocked_until: null, blocked_rechecks: 8 })
  await repair(env)
  assert.equal((await revision(exhausted.target.id)).blocked_until, null, 'never re-armed')
})

test('a manual single attempt counts its route block and, with no rechecks left, waits for the owner', async t => {
  const env = environment(), api = await session(env), { eventID } = await queued(env, api)
  const retry = async () => {
    await env.DB.prepare("UPDATE deliveries SET state='failed',last_error='retry_window_expired' WHERE event_id=?").bind(eventID).run()
    assert.equal((await api('POST', `/deliveries/${eventID}:retry`, { request_id: crypto.randomUUID() })).status, 200)
  }
  const revision = (await revisionRow(env, eventID)).id
  // An episode in progress: six rechecks used, the next one due.
  await env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_405',blocked_until='2000-01-01T00:00:00.000Z',blocked_rechecks=6 WHERE id=?").bind(revision).run()
  await retry()
  let result = await attempt(t, env, eventID, 405)
  assert.equal(result.revision.blocked_rechecks, 7); assert.ok(result.revision.blocked_until); assert.equal(result.delivery.state, 'failed'); assert.equal(result.next, null)
  await expireCooldown(env, revision); await retry()
  result = await attempt(t, env, eventID, 405)
  assert.equal(result.revision.blocked_rechecks, 8); assert.ok(result.revision.blocked_until); assert.equal(result.delivery.state, 'failed')
  // No automatic recheck is left: the block is permanent and the event waits for the owner.
  await expireCooldown(env, revision); await retry()
  result = await attempt(t, env, eventID, 405)
  assert.equal(result.calls, 1); assert.equal(result.outcome, 'rejected'); assert.equal(result.next, null)
  assert.equal(result.revision.blocked_until, null); assert.equal(result.revision.blocked_rechecks, 8); assert.equal(result.revision.blocked_reason, 'http_405')
  assert.equal(result.delivery.state, 'retry_wait'); assert.equal(result.delivery.retry_mode, 'once')
  assert.equal((await attempt(t, env, eventID, 204)).calls, 0)
})

test('a count left by an older Worker on an unblocked revision never shortens the next block episode', async t => {
  const env = environment(), api = await session(env), { target, eventID } = await queued(env, api)
  const revision = (await revisionRow(env, eventID)).id
  // An older Worker's unblock or delivered recheck cleared the block, not its count.
  await env.DB.prepare('UPDATE endpoint_revisions SET blocked_reason=NULL,blocked_until=NULL,blocked_rechecks=8 WHERE id=?').bind(revision).run()
  assert.equal((await getEndpoint(api, target.id)).blocked_recheck_count, undefined, 'an unblocked revision has used no rechecks')
  await pastGrace(env, eventID)
  const result = await attempt(t, env, eventID, 404)
  assert.equal(result.revision.blocked_rechecks, 1, 'a fresh episode'); assert.ok(result.revision.blocked_until)
  assert.equal(result.next, Date.parse(result.revision.blocked_until)); assert.equal(result.delivery.state, 'retry_wait')
  assert.equal((await getEndpoint(api, target.id)).blocked_recheck_count, 1)
})

test('reconcileCapacity returns zero counts on 409 conflict and CapacityLedger rejects invalid bootstrap settings', async () => {
  const env = environment()
  env.COORDINATOR.get = () => ({ fetch: async () => new Response(null, { status: 409 }) })
  assert.deepEqual(await reconcileCapacity(env), { checked: 0, released: 0 })
  env.COORDINATOR.get = () => ({ fetch: async () => new Response(null, { status: 503 }) })
  await assert.rejects(reconcileCapacity(env), /capacity_reconciliation_unavailable/)

  const sqlite = new DatabaseSync(':memory:')
  const storage = {
    transactionSync(fn) { return fn() },
    sql: {
      exec(sql, ...args) {
        const rows = sqlite.prepare(sql).all(...args).map(row => ({ ...row }))
        return { toArray: () => rows, one: () => rows[0] }
      },
    },
  }
  await env.DB.prepare('UPDATE app_settings SET logical_limit_bytes=0 WHERE id=1').run()
  const ledger = new CapacityLedger(storage, env)
  await assert.rejects(ledger.initialize(), /capacity_bootstrap_unavailable/)
  await env.DB.prepare('DELETE FROM app_settings WHERE id=1').run()
  await assert.rejects(ledger.initialize(), /capacity_bootstrap_unavailable/)
})
