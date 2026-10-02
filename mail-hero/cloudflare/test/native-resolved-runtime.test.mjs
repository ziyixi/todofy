import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { migrationStatements } from './migrations.mjs'
import { query, reasonOf } from './owner-api.mjs'

// Owner-resolved exception retention in workerd with the real migrations, D1
// and R2. The Worker keeps its real clock: tests move time by seeding past
// resolution and attempt times, never by mocking Date.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DAY = 86400000, HOUR = 3600000
const iso = time => new Date(time).toISOString()
const ago = ms => iso(Date.now() - ms)
let bundled
async function script() {
  bundled ??= (await build({ stdin: { contents: `
    import app from './src/native/index';
    import { runLifecycle } from './src/native/lifecycle';
    import { deleteMessageContent, runMaintenance } from './src/native/pipeline';
    // The scheduler is a stub; this test drives each lifecycle pass itself.
    export class StubCoordinator {
      async fetch(request) {
        if (new URL(request.url).pathname === '/mutation/begin') return Response.json({ id: crypto.randomUUID() });
        return new Response(null, { status: 204 });
      }
    }
    export default { async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === '/__test/lifecycle') {
        // One production lifecycle phase, exactly as the maintenance alarm runs it.
        await env.DB.prepare("INSERT INTO maintenance(id,value) VALUES('maintenance_phase','lifecycle') ON CONFLICT(id) DO UPDATE SET value=excluded.value").run();
        return Response.json(await runMaintenance(env));
      }
      if (url.pathname === '/__test/race') {
        // A replay publishes a pending event after the resolved recheck, before the tombstone.
        const input = await request.json();
        return Response.json(await runLifecycle(env, { withMutation: operation => operation(), deleteContent: async (id, version, resolved) => {
          const stamp = new Date().toISOString();
          await env.DB.prepare("INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,payload_sha256,state,next_attempt_at,created_at) VALUES(?,?,?,99,'synthetic-hash','pending',?,?)")
            .bind(input.event_id, id, input.revision, stamp, stamp).run();
          await deleteMessageContent(env, id, version, resolved ?? true);
        } }));
      }
      if (url.pathname === '/__test/race-setting') {
        // The owner's committed PATCH lands after the candidate was selected,
        // before the resolved recheck and the tombstone.
        const input = await request.json();
        return Response.json(await runLifecycle(env, { withMutation: async operation => {
          await env.DB.prepare('UPDATE app_settings SET resolved_retention_days=?,version=version+1 WHERE id=1').bind(input.days).run();
          return operation();
        }, deleteContent: (id, version, resolved) => deleteMessageContent(env, id, version, resolved ?? true) }));
      }
      if (url.pathname === '/__test/delete') {
        const input = await request.json();
        try { await deleteMessageContent(env, input.id, input.version, { dueBy: input.before }); return Response.json({ deleted: true }); }
        catch (error) { return Response.json({ deleted: false, status: error.status ?? null }); }
      }
      return app.fetch(request, env, ctx);
    }};`, resolveDir: root, sourcefile: 'native-resolved-entry.ts', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false })).outputFiles[0].text
  return bundled
}
async function runtime(t) {
  const temp = await mkdtemp(join(tmpdir(), 'mail-hero-resolved-'))
  const mf = new Miniflare(convertV4MiniflareOptions({ name: 'mail-hero-resolved-test', modules: true, script: await script(),
    compatibilityDate: '2026-09-07', host: '127.0.0.1', port: 0,
    d1Databases: { DB: 'resolved-test' }, d1Persist: join(temp, 'd1'), r2Buckets: ['MAIL_STORE'], r2Persist: join(temp, 'r2'),
    durableObjects: { COORDINATOR: { className: 'StubCoordinator' } },
    bindings: { RECEIVE_ADDRESS: 'inbox@mail.example.org', DEV_AUTH_BYPASS: 'true', ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
      ACCESS_AUDIENCE: 'synthetic', ACCESS_OWNER: 'owner@example.org', CREDENTIAL_KEY: 'a'.repeat(64), WEBHOOK_ALLOWED_HOSTS: 'consumer.example.org',
      FORCE_SEND_PAUSED: 'true', MAINTENANCE_MODE: 'false' },
    serviceBindings: { ASSETS: () => new Response('synthetic') },
    outboundService: () => { throw new Error('no outbound request is expected') } }))
  t.after(async () => { await mf.dispose(); await rm(temp, { recursive: true, force: true }) })
  await mf.ready
  const db = await mf.getD1Database('DB'), store = await mf.getR2Bucket('MAIL_STORE')
  for (const name of (await readdir(join(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort()) {
    await db.batch(migrationStatements(await readFile(join(root, 'migrations', name), 'utf8')).map(sql => db.prepare(sql)))
  }
  const post = async (path, input) => {
    const response = await mf.dispatchFetch('http://localhost' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input ?? {}) })
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  const csrf = await mf.dispatchFetch('http://localhost/api/csrf'), token = (await csrf.json()).token, cookie = csrf.headers.get('set-cookie').split(';')[0]
  /** mailhero.ui.v2 through the Worker: {status, data} in the wire JSON. */
  const api = async (path, method = 'GET', input) => {
    const response = await mf.dispatchFetch('http://localhost/api/v2' + path, { method, body: input === undefined ? undefined : JSON.stringify(input),
      headers: { Origin: 'http://localhost', Cookie: cookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json' } })
    return { status: response.status, data: await response.json() }
  }
  const PERIODS = ['raw_retention_days', 'content_retention_days', 'ledger_retention_days', 'resolved_retention_days']
  /** Settings as these tests read them: a period kept forever as null, the etag as the version it names. */
  const settingsOf = data => ({ ...data, version: Number(data.etag), ...Object.fromEntries(PERIODS.map(key => [key, data[key] ?? null])) })
  const getSettings = async () => settingsOf((await api('/settings')).data)
  /** UpdateSettings of the fields `input` names besides version, retention_confirmation and apply_existing (null: cleared). */
  const patchSettings = async ({ version, retention_confirmation, apply_existing, ...fields }) => {
    const mask = [...Object.keys(fields), 'etag'].join(',')
    const body = { etag: String(version), ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)) }
    const result = await api(`/settings${query({ update_mask: mask, retention_confirmation, apply_existing })}`, 'PATCH', body)
    return result.status === 200 ? { status: 200, data: settingsOf(result.data) } : result
  }
  /** PreviewRetentionPolicy of the stored policy with the periods `changes` holds (null: kept forever). */
  const previewRetention = async (changes = {}) => {
    const policy = { ...Object.fromEntries(PERIODS.map(key => [key, null])), ...await getSettings(), ...changes }
    const result = await api(`/settings:previewRetentionPolicy${query(Object.fromEntries([...PERIODS, 'apply_existing'].map(key => [key, policy[key]])))}`)
    if (result.status !== 200) return result
    const data = result.data
    return { status: 200, data: { ...data, preview_token: data.confirmation_token, resolved_retention_days: data.resolved_retention_days ?? null,
      resolved_messages: data.resolved_message_count ?? 0, historical_messages: data.historical_message_count ?? 0 } }
  }
  /** The rule an INVALID_RETENTION_POLICY names. */
  const ruleOf = data => data.error.details[0].metadata?.rule
  const endpoint = crypto.randomUUID(), revision = crypto.randomUUID(), date = new Date().toISOString()
  await db.batch([
    db.prepare("INSERT INTO webhook_endpoints(id,label,current_revision_id,created_at,updated_at) VALUES(?,'Synthetic',?,?,?)").bind(endpoint, revision, date, date),
    db.prepare("INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type,credential_ciphertext,created_at) VALUES(?,?,1,'https://consumer.example.org/hook','bearer','synthetic-not-decrypted',?)").bind(revision, endpoint, date),
  ])
  const insert = (table, row) => db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row)).run()
  // Synthetic forward mail frozen to the revision, with its content and events in R2.
  async function seed({ events = [], message = {}, received = ago(70 * DAY) } = {}) {
    const id = crypto.randomUUID(), raw = `raw/${id}.eml`, parsed = `parsed/${id}/seed/message.json`
    await store.put(raw, 'Subject: Synthetic\r\n\r\nFixture'); await store.put(parsed, '{"subject":"合成邮件"}')
    await insert('messages', { id, received_at: received, last_received_at: received, envelope_from: 'sender@example.org', envelope_recipient: 'inbox@mail.example.org',
      raw_key: raw, size_bytes: 31, receive_mode: 'forward', endpoint_revision_id: revision, parse_state: 'ready', parsed_key: parsed, content_bytes: 100,
      retention_policy_version: 1, raw_retention_days: 7, content_retention_days: 30, ledger_retention_days: 180, ...message })
    const ids = []
    for (const [index, event] of events.entries()) {
      const eventID = crypto.randomUUID(), { finished, created, ...fields } = event
      await store.put(`payload/${eventID}.json`, '{"type":"mail.received.v1"}')
      await insert('deliveries', { event_id: eventID, message_id: id, endpoint_revision_id: revision, generation: index + 1, payload_key: `payload/${eventID}.json`,
        payload_sha256: 'synthetic-hash', payload_size_bytes: 27, next_attempt_at: created ?? received, created_at: created ?? received, delivered_at: fields.state === 'delivered' ? finished : null, ...fields })
      if (finished) await insert('delivery_attempts', { id: crypto.randomUUID(), event_id: eventID, attempt_no: 1, started_at: finished, finished_at: finished,
        outcome: fields.state === 'delivered' ? 'delivered' : 'failed' })
      ids.push(eventID)
    }
    return { id, raw, parsed, events: ids }
  }
  const read = id => db.prepare('SELECT * FROM messages WHERE id=?').bind(id).first()
  const objects = async value => (await Promise.all([value.raw, value.parsed, ...value.events.map(id => `payload/${id}.json`)].map(key => store.head(key)))).filter(Boolean).length
  const lifecycle = () => post('/__test/lifecycle')
  return { mf, db, store, api, post, seed, read, objects, lifecycle, revision, getSettings, patchSettings, previewRetention, ruleOf }
}
// A failed original event that a later replay delivered.
const replayed = (failedAt, deliveredAt) => [{ state: 'failed', last_error: 'retry_window_expired', finished: failedAt }, { state: 'delivered', finished: deliveredAt }]

test('workerd: an exception resolved by a replay is deleted exactly after the resolved period, never before', { timeout: 60000 }, async t => {
  const { db, seed, read, objects, lifecycle } = await runtime(t)
  const message = await seed({ events: replayed(ago(63 * DAY), ago(62 * DAY)) })
  const before = Date.now()
  await lifecycle()
  let row = await read(message.id)
  // The sweep records the resolution; its due time is a lower bound from then.
  assert.ok(Date.parse(row.resolved_at) >= before && Date.parse(row.resolved_at) <= Date.now(), row.resolved_at)
  assert.equal(row.lifecycle_due_at, iso(Date.parse(row.resolved_at) + 60 * DAY))
  assert.equal(row.retention_started_at, null); assert.equal(row.content_deleted_at, null)
  // The replay attempt is the last handling, 60 days less 10 minutes ago: not yet due.
  const almost = ago(60 * DAY - 10 * 60000)
  await db.batch([db.prepare('UPDATE messages SET resolved_at=?,lifecycle_due_at=? WHERE id=?').bind(ago(61 * DAY), ago(1000), message.id),
    db.prepare('UPDATE delivery_attempts SET finished_at=? WHERE event_id=?').bind(almost, message.events[1])])
  await lifecycle()
  row = await read(message.id)
  assert.equal(row.content_deleted_at, null, 'never before the period has passed')
  assert.equal(row.lifecycle_due_at, iso(Date.parse(almost) + 60 * DAY), 'the precise due time from the latest attempt')
  assert.equal(await objects(message), 4)
  // Five seconds past the period: all content goes.
  await db.batch([db.prepare('UPDATE messages SET lifecycle_due_at=? WHERE id=?').bind(ago(1000), message.id),
    db.prepare('UPDATE delivery_attempts SET finished_at=? WHERE event_id=?').bind(ago(60 * DAY + 5000), message.events[1])])
  await lifecycle()
  row = await read(message.id)
  assert.ok(row.content_deleted_at); assert.equal(row.raw_key, null); assert.equal(row.parsed_key, null); assert.equal(row.content_purge_pending, 0)
  assert.equal(await objects(message), 0, 'raw, parsed and frozen payloads are gone')
  const events = (await db.prepare('SELECT payload_key,state FROM deliveries WHERE message_id=? ORDER BY generation').bind(message.id).all()).results
  assert.deepEqual(events.map(event => event.payload_key), [null, null]); assert.equal(events[1].state, 'delivered', 'the delivery ledger stays')
})

test('workerd: an owner cancel resolves the exception, and a later cancel restarts its clock', { timeout: 60000 }, async t => {
  const { db, api, seed, read, objects, lifecycle } = await runtime(t)
  const cancelled = await seed({ events: [{ state: 'failed', last_error: 'retry_window_expired', finished: ago(65 * DAY) }] })
  const result = await api(`/deliveries/${cancelled.events[0]}:cancel`, 'POST', { request_id: crypto.randomUUID() })
  assert.equal(result.status, 200, JSON.stringify(result.data))
  // Previously resolved, then replayed; the replay is still retrying.
  const restarted = await seed({ events: [{ state: 'cancelled', last_error: 'cancelled_by_owner', finished: ago(65 * DAY) }, { state: 'retry_wait', finished: ago(64 * DAY) }],
    message: { resolved_at: ago(61 * DAY), lifecycle_due_at: ago(1000) } })
  const before = Date.now()
  await lifecycle()
  let row = await read(cancelled.id)
  assert.ok(Date.parse(row.resolved_at) >= before); assert.equal(row.lifecycle_due_at, iso(Date.parse(row.resolved_at) + 60 * DAY))
  row = await read(restarted.id)
  assert.equal(row.content_deleted_at, null, 'a retrying replay is in flight')
  assert.deepEqual([row.resolved_at, row.lifecycle_due_at], [null, null], 'unresolved at its due time: the recorded resolution is dropped')
  // The owner cancels the replay: resolved again, and the cancel itself also drops
  // any stale resolution, so the clock restarts from this handling.
  await db.prepare('UPDATE messages SET resolved_at=? WHERE id=?').bind(ago(61 * DAY), restarted.id).run()
  assert.equal((await api(`/deliveries/${restarted.events[1]}:cancel`, 'POST', { request_id: crypto.randomUUID() })).status, 200)
  assert.equal((await read(restarted.id)).resolved_at, null)
  await db.prepare('UPDATE messages SET lifecycle_due_at=? WHERE id IN(?,?)').bind(ago(1000), restarted.id, cancelled.id).run()
  await db.prepare('UPDATE messages SET resolved_at=? WHERE id=?').bind(ago(61 * DAY), cancelled.id).run()
  const second = Date.now()
  await lifecycle()
  row = await read(cancelled.id)
  assert.ok(row.content_deleted_at, 'the cancelled exception is deleted after the period'); assert.equal(await objects(cancelled), 0)
  row = await read(restarted.id)
  assert.equal(row.content_deleted_at, null, 'never from the stale resolution')
  assert.ok(Date.parse(row.resolved_at) >= second); assert.equal(row.lifecycle_due_at, iso(Date.parse(row.resolved_at) + 60 * DAY))
  assert.equal(await objects(restarted), 4)
})

test('workerd: unresolved failures, in-flight replays and NULL-policy history are never deleted', { timeout: 60000 }, async t => {
  const { db, post, seed, read, objects, lifecycle } = await runtime(t)
  // Every row is armed and resolved long ago, the worst stale state possible.
  const stale = { resolved_at: ago(400 * DAY), lifecycle_due_at: ago(1000) }
  const history = { retention_policy_version: null, raw_retention_days: null, content_retention_days: null, ledger_retention_days: null }
  const cases = {
    expired: await seed({ events: [{ state: 'failed', last_error: 'retry_window_expired', finished: ago(65 * DAY) }], message: stale }),
    review: await seed({ events: [{ state: 'failed', last_error: 'message_needs_review' }], message: { ...stale, needs_review: 1 } }),
    systemCancel: await seed({ events: [{ state: 'cancelled', last_error: null, finished: ago(65 * DAY) }], message: stale }),
    inFlight: await seed({ events: [...replayed(ago(65 * DAY), ago(64 * DAY)), { state: 'pending' }], message: stale }),
    // The owner's latest replay failed after the delivered one, with or without an attempt.
    laterFailure: await seed({ events: [...replayed(ago(65 * DAY), ago(64 * DAY)), { state: 'failed', last_error: 'retry_window_expired' }], message: stale }),
    laterAttemptFailed: await seed({ events: [...replayed(ago(65 * DAY), ago(64 * DAY)), { state: 'failed', last_error: 'http_500', finished: ago(63 * DAY) }], message: stale }),
    // Pre-lifecycle history, with or without a policy error, never adopts the period.
    history: await seed({ events: replayed(ago(65 * DAY), ago(64 * DAY)), message: { ...stale, ...history } }),
    policyErrorHistory: await seed({ received: ago(400 * DAY), events: [{ state: 'delivered', finished: ago(390 * DAY) }],
      message: { ...stale, ...history, receive_mode: 'archive', endpoint_revision_id: null, policy_error: 'policy_unavailable' } }),
    fresh: await seed({ events: [{ state: 'failed', last_error: 'retry_window_expired', finished: ago(65 * DAY) }] }),
  }
  for (let pass = 0; pass < 4; pass++) await lifecycle()
  for (const [name, value] of Object.entries(cases)) {
    const row = await read(value.id)
    assert.equal(row.content_deleted_at, null, name); assert.equal(await objects(value), 2 + value.events.length, name)
    // Seen unresolved: any recorded resolution is dropped with its due time.
    assert.deepEqual([row.resolved_at, row.lifecycle_due_at], [null, null], name)
    // The tombstone itself refuses them atomically, whatever stale state the caller believes.
    await db.prepare('UPDATE messages SET resolved_at=? WHERE id=?').bind(ago(400 * DAY), value.id).run()
    assert.deepEqual(await post('/__test/delete', { id: value.id, version: row.version, before: new Date().toISOString() }), { deleted: false, status: 409 }, name)
  }
})

test('workerd: the owner applying the policy to history starts its resolved clock at confirmation', { timeout: 60000 }, async t => {
  const { api, seed, read, lifecycle, getSettings, patchSettings, previewRetention } = await runtime(t)
  const history = await seed({ received: ago(400 * DAY), events: [{ state: 'delivered', finished: ago(390 * DAY) }],
    message: { receive_mode: 'archive', endpoint_revision_id: null, policy_error: 'policy_unavailable', retention_policy_version: null, raw_retention_days: null, content_retention_days: null, ledger_retention_days: null } })
  await lifecycle()
  assert.equal((await read(history.id)).resolved_at, null)
  const settings = (await getSettings())
  const preview = (await previewRetention({ apply_existing: true })).data
  assert.equal(preview.historical_messages, 1)
  const confirmed = Date.now()
  assert.equal((await patchSettings({ version: settings.version, apply_existing: true, retention_confirmation: preview.preview_token })).status, 200)
  await lifecycle()
  const row = await read(history.id)
  assert.equal(row.content_deleted_at, null); assert.ok(Date.parse(row.resolved_at) >= confirmed, 'counted from the confirmation, not from its old delivery')
  assert.equal(row.lifecycle_due_at, iso(Date.parse(row.resolved_at) + 60 * DAY))
})

test('workerd: a later replay that fails without an attempt, or an owner retry, never lets a stale resolution delete', { timeout: 60000 }, async t => {
  const { db, api, seed, read, objects, lifecycle } = await runtime(t)
  // Resolved 61 days ago; eight days ago the owner replayed again and that event is held.
  const held = await seed({ events: [...replayed(ago(81 * DAY), ago(80 * DAY)), { state: 'retry_wait', created: ago(8 * DAY) }], message: { resolved_at: ago(61 * DAY), lifecycle_due_at: ago(1000) } })
  await lifecycle()
  assert.deepEqual([(await read(held.id)).resolved_at, (await read(held.id)).lifecycle_due_at], [null, null])
  // Held past its window, it fails without any attempt row (as deliverJob or the repair phase does).
  await db.prepare("UPDATE deliveries SET state='failed',last_error='retry_window_expired' WHERE event_id=? AND state IN('pending','retry_wait')").bind(held.events[2]).run()
  assert.deepEqual({ ...await db.prepare('SELECT state,last_error FROM deliveries WHERE event_id=?').bind(held.events[2]).first() }, { state: 'failed', last_error: 'retry_window_expired' })
  assert.equal((await db.prepare('SELECT count(*) n FROM delivery_attempts WHERE event_id=?').bind(held.events[2]).first()).n, 0)
  // Even with its old resolution restored and armed, the later failure keeps it.
  await db.prepare('UPDATE messages SET resolved_at=?,lifecycle_due_at=? WHERE id=?').bind(ago(61 * DAY), ago(1000), held.id).run()
  for (let pass = 0; pass < 2; pass++) await lifecycle()
  assert.equal((await read(held.id)).content_deleted_at, null); assert.equal(await objects(held), 5)
  // An owner retry of the older failed event is a handling: the clock restarts.
  const retried = await seed({ events: [{ state: 'failed', last_error: 'http_500', finished: ago(20 * DAY), created: ago(21 * DAY) }, { state: 'delivered', finished: ago(19 * DAY) }],
    message: { resolved_at: ago(61 * DAY), lifecycle_due_at: iso(Date.now() + DAY) } })
  assert.equal((await api(`/deliveries/${retried.events[0]}:retry`, 'POST', { request_id: crypto.randomUUID() })).status, 200)
  assert.equal((await read(retried.id)).resolved_at, null)
})

test('workerd: disabling or lengthening the period after candidate selection stops the delete', { timeout: 60000 }, async t => {
  const { db, post, seed, read, objects } = await runtime(t)
  for (const days of [null, 90]) {
    const message = await seed({ events: replayed(ago(81 * DAY), ago(80 * DAY)), message: { resolved_at: ago(61 * DAY), lifecycle_due_at: ago(1000) } })
    const before = Date.now(), result = await post('/__test/race-setting', { days })
    assert.equal(result.processed, 0, String(days))
    const row = await read(message.id)
    assert.equal(row.content_deleted_at, null, String(days)); assert.equal(await objects(message), 4)
    assert.ok(Date.parse(row.lifecycle_due_at) >= before + HOUR - 60000, 'retried later under the committed period')
    await db.batch([db.prepare('UPDATE app_settings SET resolved_retention_days=60 WHERE id=1'), db.prepare('UPDATE messages SET lifecycle_due_at=NULL WHERE id=?').bind(message.id)])
  }
})

test('workerd: the resolved period is never shorter than the content period, stored or snapshotted', { timeout: 60000 }, async t => {
  const { db, api, seed, read, objects, lifecycle, getSettings, patchSettings, previewRetention, ruleOf } = await runtime(t)
  // A snapshot that keeps content forever, and one with a longer content period.
  const forever = await seed({ events: replayed(ago(400 * DAY), ago(399 * DAY)), message: { content_retention_days: null, raw_retention_days: null, resolved_at: ago(398 * DAY), lifecycle_due_at: ago(1000) } })
  const longer = await seed({ events: replayed(ago(81 * DAY), ago(80 * DAY)), message: { content_retention_days: 90, resolved_at: ago(80 * DAY), lifecycle_due_at: ago(1000) } })
  // A stored setting below the current content period (e.g. content changed during the deploy gap).
  await db.prepare('UPDATE app_settings SET content_retention_days=120 WHERE id=1').run()
  const stored = await seed({ events: replayed(ago(101 * DAY), ago(100 * DAY)), message: { content_retention_days: 30, resolved_at: ago(100 * DAY), lifecycle_due_at: ago(1000) } })
  await lifecycle()
  assert.equal((await read(forever.id)).content_deleted_at, null); assert.equal((await read(forever.id)).lifecycle_due_at, null, 'never due')
  let row = await read(longer.id)
  assert.equal(row.content_deleted_at, null); assert.equal(row.lifecycle_due_at, iso(Date.parse(row.resolved_at) + 120 * DAY), 'the longest period applies')
  row = await read(stored.id)
  assert.equal(row.content_deleted_at, null); assert.equal(row.lifecycle_due_at, iso(Date.parse(row.resolved_at) + 120 * DAY))
  // That stored combination blocks no unrelated change, only a retention change that keeps it.
  let settings = (await getSettings())
  assert.deepEqual([settings.content_retention_days, settings.resolved_retention_days], [120, 60])
  let result = await patchSettings({ version: settings.version, send_paused: true })
  assert.equal(result.status, 200, JSON.stringify(result.data)); settings = result.data
  result = await patchSettings({ version: settings.version, content_retention_days: 120 })
  assert.equal(result.status, 400); assert.equal(ruleOf(result.data), 'resolved_before_content')
  // Content kept forever allows only a resolved period kept forever.
  await db.prepare('UPDATE app_settings SET content_retention_days=30 WHERE id=1').run()
  settings = (await getSettings())
  result = await patchSettings({ version: settings.version, content_retention_days: null })
  assert.equal(result.status, 400); assert.equal(ruleOf(result.data), 'resolved_before_content')
  assert.equal((await previewRetention({ content_retention_days: null })).status, 400)
  result = await patchSettings({ version: settings.version, content_retention_days: null, resolved_retention_days: null })
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.deepEqual([result.data.content_retention_days, result.data.resolved_retention_days], [null, null])
  assert.equal(await objects(forever) + await objects(longer) + await objects(stored), 12)
})

test('workerd: a resolved row whose due time was cleared (a rollback or a raced change) is re-armed by the sweep', { timeout: 60000 }, async t => {
  const { seed, read, lifecycle } = await runtime(t)
  const resolvedAt = ago(100 * DAY), message = await seed({ events: replayed(ago(101 * DAY), ago(100 * DAY)), message: { resolved_at: resolvedAt, lifecycle_due_at: null } })
  await lifecycle()
  let row = await read(message.id)
  assert.equal(row.resolved_at, resolvedAt, 'the recorded resolution is kept')
  assert.equal(row.lifecycle_due_at, iso(Date.parse(resolvedAt) + 60 * DAY), 'its lower bound under the enabled period')
  await lifecycle()
  row = await read(message.id)
  assert.ok(row.content_deleted_at, 'deleted on its next due pass')
})

test('workerd: a replay published between the resolved recheck and the tombstone keeps the message', { timeout: 60000 }, async t => {
  const { db, post, seed, read, objects, revision } = await runtime(t)
  const message = await seed({ events: replayed(ago(65 * DAY), ago(64 * DAY)), message: { resolved_at: ago(63 * DAY), lifecycle_due_at: ago(1000) } })
  const eventID = crypto.randomUUID()
  const result = await post('/__test/race', { revision, event_id: eventID })
  assert.equal(result.processed, 0)
  const row = await read(message.id)
  assert.equal(row.content_deleted_at, null); assert.equal(row.content_bytes, 100); assert.equal(await objects(message), 4)
  // The sweep of the same pass sees the replay in flight: the clock restarts once it settles.
  assert.deepEqual([row.resolved_at, row.lifecycle_due_at], [null, null], 'kept, and re-timed from its next resolution')
  const replay = await db.prepare('SELECT state,payload_sha256 FROM deliveries WHERE event_id=?').bind(eventID).first()
  assert.deepEqual({ ...replay }, { state: 'pending', payload_sha256: 'synthetic-hash' }, 'the replay itself is untouched')
})

test('workerd: resolved retention settings validate, need a preview to enable or shorten, and re-arm on change', { timeout: 60000 }, async t => {
  const { api, seed, read, lifecycle, getSettings, patchSettings, previewRetention, ruleOf } = await runtime(t)
  let settings = (await getSettings())
  assert.equal(settings.resolved_retention_days, 60, 'the migration default applies to the existing row')
  const due = await seed({ events: replayed(ago(65 * DAY), ago(64 * DAY)), message: { resolved_at: ago(61 * DAY), lifecycle_due_at: iso(Date.now() + 5 * DAY) } })
  const fresh = await seed({ events: replayed(ago(65 * DAY), ago(64 * DAY)) })
  // Disabling needs no preview and deletes nothing; it clears every armed due time.
  let result = await patchSettings({ version: settings.version, resolved_retention_days: null })
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.resolved_retention_days, null)
  assert.equal(result.data.lifecycle_policy_version, settings.lifecycle_policy_version, 'the global period is not a per-message snapshot')
  settings = result.data
  assert.equal((await read(due.id)).lifecycle_due_at, null)
  await lifecycle()
  assert.equal((await read(due.id)).content_deleted_at, null)
  const recorded = await read(fresh.id)
  assert.ok(recorded.resolved_at, 'still recorded while disabled'); assert.equal(recorded.lifecycle_due_at, null)
  // Shorter than the content period is invalid, in the preview and the update.
  result = await patchSettings({ version: settings.version, resolved_retention_days: 20 })
  assert.equal(result.status, 400); assert.equal(ruleOf(result.data), 'resolved_before_content')
  assert.equal((await previewRetention({ resolved_retention_days: 10 })).status, 400)
  assert.equal((await patchSettings({ version: settings.version, content_retention_days: 90, resolved_retention_days: 60 })).status, 400)
  // Enabling from disabled requires a preview bound to the exact value.
  result = await patchSettings({ version: settings.version, resolved_retention_days: 60 })
  assert.equal(result.status, 400); assert.equal(reasonOf(result.data), 'RETENTION_CONFIRMATION_REQUIRED')
  const preview = (await previewRetention({ resolved_retention_days: 60 })).data
  assert.equal(preview.resolved_retention_days, 60); assert.equal(preview.resolved_messages, 2)
  assert.equal((await patchSettings({ version: settings.version, resolved_retention_days: 61, retention_confirmation: preview.preview_token })).status, 400)
  const armed = Date.now()
  result = await patchSettings({ version: settings.version, resolved_retention_days: 60, retention_confirmation: preview.preview_token })
  assert.equal(result.status, 200, JSON.stringify(result.data)); settings = result.data
  // Each is re-armed at the lower bound of its due time: now for one that may be
  // due, resolved_at plus the period otherwise, so a change never floods the due index.
  const value = Date.parse((await read(due.id)).lifecycle_due_at)
  assert.ok(value >= armed - 1000 && value <= Date.now(), 're-armed for a precise pass')
  const recordedAgain = await read(fresh.id)
  assert.equal(recordedAgain.lifecycle_due_at, iso(Date.parse(recordedAgain.resolved_at) + 60 * DAY))
  await lifecycle()
  assert.ok((await read(due.id)).content_deleted_at, 'the re-enabled period applies at once')
  const kept = await read(fresh.id)
  assert.equal(kept.content_deleted_at, null); assert.equal(kept.lifecycle_due_at, iso(Date.parse(kept.resolved_at) + 60 * DAY))
  // Shortening needs a preview; lengthening does not. 'none' previews disabling.
  assert.equal((await patchSettings({ version: settings.version, resolved_retention_days: 45 })).status, 400)
  const shorter = (await previewRetention({ resolved_retention_days: 45 })).data
  assert.equal(shorter.resolved_messages, 1)
  result = await patchSettings({ version: settings.version, resolved_retention_days: 45, retention_confirmation: shorter.preview_token })
  assert.equal(result.status, 200); assert.equal(result.data.resolved_retention_days, 45)
  result = await patchSettings({ version: result.data.version, resolved_retention_days: 90 })
  assert.equal(result.status, 200); assert.equal(result.data.resolved_retention_days, 90)
  assert.equal((await previewRetention({ resolved_retention_days: null })).data.resolved_retention_days, null)
})
