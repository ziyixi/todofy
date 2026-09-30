// contracts/ops-v1 in workerd with real D1, R2 and the SQLite Durable Object. A second Worker plays the
// future dashboard: it reaches Mail Hero only through a service binding with `entrypoint = "Ops"`, exactly
// as README.md prescribes, so every result below crossed real RPC. Every result is validated against
// ops-v1.schema.json. All mail, addresses and credentials are synthetic.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { migrationStatements } from './migrations.mjs'
import { validate } from '../../../contracts/ops-v1/validate.mjs'
import { buildPayload, syntheticCanaryMail } from '../src/native/pipeline.ts'
import { STATUS_MAX_D1_STATEMENTS } from '../src/native/ops-core.ts'
import { DEFERRABLE_JOBS } from '../src/native/ops-guard.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const schema = JSON.parse(await readFile(new URL('../../../contracts/ops-v1/ops-v1.schema.json', import.meta.url), 'utf8'))
const INBOX = 'inbox@mail.example.org'
const BACKUP_TOKEN = 'synthetic-backup-machine-token-32-characters'
// Distinctive synthetic mail content that must never appear in an ops output.
const SECRETS = ['Alice', 'alice', 'Secretive', 'merger', '机密', 'zebra', 'consumer.example.org', 'synthetic-token', '@']
const secretMail = ['From: Alice Secretive <alice.secretive@example.org>', `To: ${INBOX}`, 'Cc: bob.hidden@example.org',
  'Subject: Quarterly merger plan 机密', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '',
  'The vault code is 4242-zebra.', ''].join('\r\n')
// Distinctive statements of the four deferrable jobs (IMPLEMENTATION.md 2.5).
const JOB_SQL = {
  raw_reconcile: "VALUES('raw_reconcile_cursor'",
  lifecycle_retention: 'messages_due_missing_idx',
  canary_cleanup: 'messages_canary_idx',
  alert_history_purge: 'DELETE FROM alert_notifications',
}
// Statements of work that shed must never stop.
const KEPT_SQL = {
  repair_parse: 'messages_live_lifecycle_idx', repair_due_deliveries: 'deliveries_due_idx', alerts_evaluate: 'SELECT * FROM alerts',
  purge_resume: 'content_purge_pending=1',
}

let bundled
async function script() {
  bundled ??= (await build({ stdin: { contents: `
    import app from './src/native/index';
    import { emailHandler } from './src/native/ingest';
    import { enqueue } from './src/native/pipeline';
    import { MailCoordinator } from './src/native/coordinator';
    import { Ops as RealOps } from './src/native/ops';
    // Counts and records every D1 statement (first() through all(), as the bounded test does).
    function meter(db, sink) {
      const wrap = (statement, sql) => ({ statement, sql,
        bind: (...values) => wrap(statement.bind(...values), sql),
        async all() { sink(sql); return statement.all() },
        async run() { sink(sql); return statement.run() },
        async first(column) { const row = (await this.all()).results[0] ?? null; return column ? row?.[column] ?? null : row },
        raw() { throw new Error('unmetered_raw') } })
      return { prepare: sql => wrap(db.prepare(sql), sql), exec() { throw new Error('unmetered_exec') },
        async batch(statements) { for (const item of statements) sink(item.sql); return db.batch(statements.map(item => item.statement)) } }
    }
    const opsLog = []
    // The real entrypoint; only its D1 binding is metered.
    export class Ops extends RealOps { constructor(ctx, env) { super(ctx, { ...env, DB: meter(env.DB, sql => opsLog.push(sql)) }) } }
    // The real coordinator; D1 statements are grouped per alarm invocation.
    export class ProbeCoordinator extends MailCoordinator {
      constructor(state, env) {
        const groups = [[]]
        super(state, { ...env, DB: meter(env.DB, sql => groups[groups.length - 1].push(sql)) })
        this.groups = groups; this.probeSQL = state.storage.sql
      }
      async alarm() { this.groups.push([]); return super.alarm() }
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/__probe/groups') { const value = this.groups.filter(group => group.length); this.groups.splice(0, this.groups.length, []); return Response.json(value) }
        if (path === '/__probe/sql') { const input = await request.json(); return Response.json(this.probeSQL.exec(input.sql, ...(input.values ?? [])).toArray()) }
        return super.fetch(request)
      }
    }
    const coordinator = env => env.COORDINATOR.get(env.COORDINATOR.idFromName('inbox-v1'))
    export default { async fetch(request, env, ctx) {
      const url = new URL(request.url)
      if (url.pathname.startsWith('/__probe/')) return coordinator(env).fetch(new Request('https://coordinator' + url.pathname, request))
      if (url.pathname === '/__test/wake') return coordinator(env).fetch('https://coordinator/wake', { method: 'POST' })
      if (url.pathname === '/__test/ops-log') return Response.json(opsLog.splice(0))
      if (url.pathname === '/__test/enqueue') { await enqueue(env, await request.json()); return new Response(null, { status: 204 }) }
      if (url.pathname === '/__test/email') {
        let rejected = ''
        await emailHandler({ from: 'alice.secretive@example.org', to: env.RECEIVE_ADDRESS, raw: request.body, rawSize: Number(request.headers.get('x-raw-size')),
          setReject(reason) { rejected = reason } }, env, ctx)
        return new Response(rejected || null, { status: rejected ? 422 : 204 })
      }
      return app.fetch(request, env, ctx)
    }};`, resolveDir: root, sourcefile: 'native-ops-entry.ts', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false })).outputFiles[0].text
  return bundled
}

async function waitFor(read, predicate, label, timeout = 15000) {
  const until = Date.now() + timeout
  let value
  do {
    value = await read()
    if (predicate(value)) return value
    await delay(100)
  } while (Date.now() < until)
  assert.fail(`${label}: ${JSON.stringify(value)}`)
}

async function runtime(t, bindings = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'mail-hero-ops-'))
  const calls = [], responses = []
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0,
    d1Persist: join(temp, 'd1'), r2Persist: join(temp, 'r2'), durableObjectsPersist: join(temp, 'do'),
    workers: [
      { name: 'mail-hero', modules: true, script: await script(), compatibilityDate: '2026-09-07',
        d1Databases: { DB: 'ops-test' }, r2Buckets: ['MAIL_STORE'],
        durableObjects: { COORDINATOR: { className: 'ProbeCoordinator', useSQLite: true } },
        bindings: { RECEIVE_ADDRESS: INBOX, DEV_AUTH_BYPASS: 'true', ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
          ACCESS_AUDIENCE: 'synthetic', ACCESS_OWNER: 'owner@example.org', CREDENTIAL_KEY: 'a'.repeat(64), WEBHOOK_ALLOWED_HOSTS: 'consumer.example.org',
          FORCE_SEND_PAUSED: 'false', MAINTENANCE_MODE: 'false', PUBLIC_HOST: 'mail-hero.example.net', BACKUP_TOKEN, ...bindings },
        serviceBindings: { ASSETS: () => new Response('synthetic') },
        outboundService: async request => {
          assert.equal(new URL(request.url).hostname, 'consumer.example.org', 'no unexpected outbound fetch')
          calls.push({ body: await request.text(), key: request.headers.get('Idempotency-Key') })
          return new Response(null, { status: responses.shift() ?? 204 })
        } },
      // The future dashboard, reduced to a loopback for the test: it only ever calls MAIL_HERO.<method>.
      { name: 'dashboard', modules: true, compatibilityDate: '2026-09-07',
        script: `export default { async fetch(request, env) {
          const { method, args } = await request.json()
          try { return Response.json({ ok: await env.MAIL_HERO[method](...args) }) }
          catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'not_an_error' }) }
        } }`,
        serviceBindings: { MAIL_HERO: { name: 'mail-hero', entrypoint: 'Ops' } } },
    ],
  }))
  t.after(async () => { await mf.dispose(); await rm(temp, { recursive: true, force: true }) })
  await mf.ready
  const db = await mf.getD1Database('DB', 'mail-hero')
  const bucket = await mf.getR2Bucket('MAIL_STORE', 'mail-hero')
  for (const name of (await readdir(join(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort()) {
    await db.batch(migrationStatements(await readFile(join(root, 'migrations', name), 'utf8')).map(sql => db.prepare(sql)))
  }
  const dashboard = await mf.getWorker('dashboard')
  const request = async (path, init) => {
    const response = await mf.dispatchFetch('http://localhost' + path, init)
    const text = await response.text()
    assert.ok(response.ok, `${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
  /** One ops call through the service binding; returns the value (validated) or the rejection code. */
  async function ops(method, def, ...args) {
    await request('/__test/ops-log')
    const response = await dashboard.fetch('http://dashboard/', { method: 'POST', body: JSON.stringify({ method, args }) })
    const result = await response.json()
    const statements = await request('/__test/ops-log')
    if (result.error) return { error: result.error, statements }
    assert.deepEqual(validate(schema, def, result.ok), [], `${method} output: ${JSON.stringify(result.ok)}`)
    const text = JSON.stringify(result.ok)
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${method} output leaks ${secret}: ${text}`)
    return { value: result.ok, statements }
  }
  const csrf = await mf.dispatchFetch('http://localhost/api/v1/csrf')
  const token = (await csrf.json()).token, cookie = csrf.headers.get('set-cookie').split(';')[0]
  const api = (path, method = 'GET', body) => request(`/api/v1${path}`, { method,
    headers: { Origin: 'http://localhost', Cookie: cookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) })
  async function receive(raw = secretMail) {
    const response = await mf.dispatchFetch('http://localhost/__test/email', { method: 'POST', headers: { 'x-raw-size': String(Buffer.byteLength(raw)) }, body: raw })
    assert.equal(response.status, 204, await response.text())
  }
  /** A forward-mode target through the real API (the credential is encrypted by the Worker). */
  async function forwardTarget() {
    const endpoint = await api('/endpoints', 'POST', { action_request_id: crypto.randomUUID(), label: 'Synthetic consumer', url: 'https://consumer.example.org/hooks/mail',
      auth_type: 'bearer', credential: 'synthetic-token-not-a-real-secret', rate_per_minute: 60, timeout_seconds: 2 })
    await db.prepare("UPDATE app_settings SET mode='forward',current_endpoint_id=? WHERE id=1").bind(endpoint.id).run()
    return endpoint
  }
  const unthrottle = () => db.batch([db.prepare('UPDATE webhook_endpoints SET next_send_at=NULL'), db.prepare('UPDATE app_settings SET next_send_at=NULL')])
  const counts = async () => ({ ...(await db.prepare('SELECT (SELECT count(*) FROM messages) messages,(SELECT count(*) FROM deliveries) deliveries').first()),
    objects: (await bucket.list()).objects.length })
  /** Wakes the coordinator and collects the D1 statements of one full maintenance cycle (repair, lifecycle, alerts). */
  async function cycle() {
    await request('/__probe/groups')
    await request('/__test/wake', { method: 'POST' })
    const groups = []
    await waitFor(async () => { groups.push(...await request('/__probe/groups')); return groups },
      value => value.some(group => group.some(sql => sql.includes("VALUES('maintenance_phase','repair')"))), 'maintenance cycle completes', 20000)
    return groups
  }
  const ranJobs = groups => Object.keys(JOB_SQL).filter(job => groups.some(group => group.some(sql => sql.includes(JOB_SQL[job]))))
  return { mf, db, bucket, calls, responses, request, ops, api, receive, forwardTarget, unthrottle, counts, cycle, ranJobs }
}

test('workerd Ops: status and setGuard over the service binding, bounded and content-free', { timeout: 120000 }, async t => {
  const { db, ops, receive, forwardTarget, request } = await runtime(t)
  await forwardTarget()
  await receive()
  await waitFor(() => db.prepare('SELECT parse_state FROM messages LIMIT 1').first(), row => row?.parse_state === 'ready', 'mail parsed')
  await waitFor(() => db.prepare('SELECT state FROM deliveries LIMIT 1').first(), row => row?.state === 'delivered', 'mail delivered')

  const normal = await ops('status', 'OpsStatus')
  assert.equal(normal.value.app, 'mail-hero')
  assert.ok(normal.statements.length <= STATUS_MAX_D1_STATEMENTS, `status used ${normal.statements.length} D1 statements`)
  assert.ok(normal.statements.every(sql => /^\s*SELECT/i.test(sql)), 'status never writes')
  assert.equal(normal.value.ui_url, 'https://mail-hero.example.net/')
  assert.deepEqual(normal.value.modes, { maintenance: false, force_send_paused: false, send_paused: false, forwarding: true, backup_active: false })
  assert.equal(normal.value.counters.ingest_today_messages, 1)
  assert.ok(normal.value.counters.capacity_used_bytes > 0)
  // Only the never-backed-up signal of a fresh install may be active.
  assert.deepEqual(normal.value.signals.map(signal => signal.code).filter(code => code !== 'backup_stale'), [])

  // Owner pause: a warning and a mode, not a failure.
  await db.prepare('UPDATE app_settings SET send_paused=1 WHERE id=1').run()
  const paused = await ops('status', 'OpsStatus')
  assert.equal(paused.value.health, 'degraded'); assert.equal(paused.value.modes.send_paused, true)
  assert.ok(paused.value.signals.some(signal => signal.code === 'send_paused' && signal.severity === 'warning'))
  await db.prepare('UPDATE app_settings SET send_paused=0 WHERE id=1').run()

  // An active alert row carries its activation time into `since`.
  await db.prepare(`INSERT INTO alerts(code,active,severity,metrics_json,first_seen_at,last_seen_at,last_event_day,active_since)
    VALUES('parse_failed',1,'warning','{}','2026-09-01T00:00:00.000Z','2026-09-29T00:00:00.000Z','2026-09-29','2026-09-28T07:00:00.000Z')`).run()
  await db.prepare("UPDATE messages SET parse_state='failed',parse_error='synthetic_error'").run()
  const failed = await ops('status', 'OpsStatus')
  assert.deepEqual(failed.value.signals.find(signal => signal.code === 'parse_failed'), { code: 'parse_failed', severity: 'warning', metrics: { count: 1 }, since: '2026-09-28T07:00:00.000Z' })

  // setGuard: idempotent, bounded, rejects with the code only, expires by itself.
  const until = new Date(Date.now() + 6 * 3600_000).toISOString()
  const shed = await ops('setGuard', 'GuardState', { level: 'shed', reason: 'd1_reads_high', until })
  assert.equal(shed.statements.length, 0, 'the guard is Durable Object storage only')
  assert.deepEqual(shed.value.deferred, [...DEFERRABLE_JOBS])
  assert.deepEqual((await ops('setGuard', 'GuardState', { level: 'shed', reason: 'd1_reads_high', until })).value, shed.value, 'same request, same set_at')
  const status = await ops('status', 'OpsStatus')
  assert.deepEqual(status.value.guard, shed.value)
  assert.ok(status.value.signals.some(signal => signal.code === 'guard_shed' && signal.metrics.seconds_left > 21000))
  for (const input of [{ level: 'shed', reason: 'd1_reads_high', until: new Date(Date.now() + 37 * 3600_000).toISOString() },
    { level: 'shed', reason: 'Free text', until }, { level: 'normal', reason: 'x', until }, { level: 'shed', reason: 'x', until, subject: 'x' }]) {
    assert.deepEqual((await ops('setGuard', 'GuardState', input)).error, 'invalid_input', JSON.stringify(input))
  }
  assert.deepEqual((await ops('status', 'OpsStatus')).value.guard, shed.value, 'refused requests change nothing')
  const brief = await ops('setGuard', 'GuardState', { level: 'shed', reason: 'brief_test', until: new Date(Date.now() + 1500).toISOString() })
  assert.equal(brief.value.level, 'shed')
  await delay(1800)
  const expired = await ops('status', 'OpsStatus')
  assert.deepEqual(expired.value.guard, { level: 'normal', reason: null, until: null, set_at: null, deferred: [] }, 'expired without an alarm')
  assert.ok(!expired.value.signals.some(signal => signal.code === 'guard_shed'))
  await ops('setGuard', 'GuardState', { level: 'shed', reason: 'd1_reads_high', until })
  assert.deepEqual((await ops('setGuard', 'GuardState', { level: 'normal', reason: 'quota_recovered', until: null })).value.level, 'normal')
  assert.equal((await ops('status', 'OpsStatus')).value.guard.level, 'normal')
  // Unknown methods are not part of the entrypoint; internal helpers are not reachable.
  assert.match((await ops('buildStatus', 'OpsStatus')).error, /not_an_error|does not implement|not a function|RPC/i)
  // A snapshot lease shows as a mode and an info signal.
  const auth = { Authorization: 'Bearer ' + BACKUP_TOKEN, 'Content-Type': 'application/json' }
  const begun = await request('/api/internal/backup/begin', { method: 'POST', headers: auth, body: JSON.stringify({ lease_seconds: 300 }) })
  const backup = await ops('status', 'OpsStatus')
  assert.equal(backup.value.modes.backup_active, true)
  assert.ok(backup.value.signals.some(signal => signal.code === 'backup_active' && signal.severity === 'info'))
  await request('/api/internal/backup/cancel', { method: 'POST', headers: auth, body: JSON.stringify({ backup_id: begun.backup_id }) })
})

test('workerd Ops: canary queued once per run, delivered with the golden marker, held runs create nothing', { timeout: 120000 }, async t => {
  const { db, bucket, calls, responses, ops, api, request, forwardTarget, unthrottle, counts, receive, cycle } = await runtime(t)
  assert.deepEqual((await ops('startCanary', 'StartCanaryResult', { run_id: 'canary-2026-09-28' })).value, { event_id: null, state: 'unavailable', reason: 'no_endpoint' })
  const endpoint = await forwardTarget()
  responses.push(503)
  const started = await ops('startCanary', 'StartCanaryResult', { run_id: 'canary-2026-09-29' })
  assert.equal(started.value.state, 'queued')
  const eventID = started.value.event_id
  assert.ok(started.statements.slice(0, 2).every(sql => /^\s*SELECT/i.test(sql)), 'two reads before any write')
  assert.deepEqual((await ops('startCanary', 'StartCanaryResult', { run_id: 'canary-2026-09-29' })).value, started.value, 'idempotent per run_id')
  const canary = await db.prepare('SELECT m.id,m.origin,m.received_at,m.canary_run_id,d.retry_mode FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.event_id=?').bind(eventID).first()
  assert.deepEqual([canary.origin, canary.canary_run_id, canary.retry_mode], ['synthetic_test', 'canary-2026-09-29', 'auto'])

  // First attempt: 503, a durable retry of the same event.
  await waitFor(() => db.prepare('SELECT state FROM deliveries WHERE event_id=?').bind(eventID).first(), row => row?.state === 'retry_wait', '503 is a retry')
  const pending = await ops('canaryDelivery', 'CanaryDelivery', eventID)
  assert.deepEqual(pending.value, { state: 'pending', attempts: 1, last_http_status: 503, error_code: 'http_503' })
  assert.equal(pending.statements.length, 1, 'canaryDelivery is one statement')
  // The consumer received exactly the bytes Mail Hero's builder makes for this canary.
  assert.equal(calls.length, 1)
  const expected = buildPayload(eventID, canary.id, canary.received_at, JSON.parse(JSON.stringify(syntheticCanaryMail())), INBOX, INBOX, { run_id: 'canary-2026-09-29' })
  assert.equal(calls[0].body, expected)
  assert.deepEqual(JSON.parse(calls[0].body).canary, { run_id: 'canary-2026-09-29' })
  assert.equal(calls[0].key, eventID)
  // Retry now instead of after the backoff.
  await db.prepare("UPDATE deliveries SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE event_id=?").bind(eventID).run()
  await unthrottle()
  await request('/__test/enqueue', { method: 'POST', body: JSON.stringify({ type: 'deliver', eventID }) })
  await waitFor(() => db.prepare('SELECT state FROM deliveries WHERE event_id=?').bind(eventID).first(), row => row?.state === 'delivered', 'canary delivered')
  const delivered = await ops('canaryDelivery', 'CanaryDelivery', eventID)
  assert.equal(delivered.value.state, 'delivered'); assert.equal(delivered.value.attempts, 2); assert.equal(delivered.value.last_http_status, 204)
  assert.equal(calls[1].body, calls[0].body, 'a retry sends the frozen bytes')
  assert.deepEqual((await ops('startCanary', 'StartCanaryResult', { run_id: 'canary-2026-09-29' })).value, started.value, 'still the same event after delivery')

  // The owner sees it only as a labelled delivery, never in the inbox.
  const listed = (await api('/deliveries')).items.find(item => item.event_id === eventID)
  assert.equal(listed.canary, true)
  assert.equal((await api('/messages')).items.length, 0)
  // A real mail's event reads unknown, as does an unknown ID; malformed IDs are invalid_input.
  await unthrottle()
  await receive()
  const real = await waitFor(() => db.prepare("SELECT d.event_id,d.state FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.origin='cloudflare'").first(), row => row?.state === 'delivered', 'real mail delivered')
  assert.deepEqual((await ops('canaryDelivery', 'CanaryDelivery', real.event_id)).value, { state: 'unknown', attempts: 0 })
  assert.equal(JSON.parse(calls.at(-1).body).canary, undefined, 'real mail carries no canary marker')
  assert.equal((await api('/deliveries')).items.find(item => item.event_id === real.event_id).canary, false)
  assert.deepEqual((await ops('canaryDelivery', 'CanaryDelivery', crypto.randomUUID())).value, { state: 'unknown', attempts: 0 })
  assert.equal((await ops('canaryDelivery', 'CanaryDelivery', 'not-an-event')).error, 'invalid_input')
  assert.equal((await ops('startCanary', 'StartCanaryResult', { run_id: 'bad run' })).error, 'invalid_input')

  // Held runs are reported and create nothing: no rows, no R2 objects.
  const before = await counts()
  const held = async (label, change, undo, expected) => {
    await change()
    const result = await ops('startCanary', 'StartCanaryResult', { run_id: `canary-held-${label}` })
    assert.deepEqual(result.value, expected, label)
    assert.deepEqual(await counts(), before, `${label} created nothing`)
    await undo()
  }
  await held('settings', () => db.prepare('UPDATE app_settings SET send_paused=1').run(), () => db.prepare('UPDATE app_settings SET send_paused=0').run(),
    { event_id: null, state: 'paused', reason: 'settings_paused' })
  await held('endpoint', () => db.prepare('UPDATE webhook_endpoints SET paused=1').run(), () => db.prepare('UPDATE webhook_endpoints SET paused=0').run(),
    { event_id: null, state: 'paused', reason: 'endpoint_paused' })
  await held('blocked', () => db.prepare("UPDATE endpoint_revisions SET blocked_reason='http_401'").run(), () => db.prepare('UPDATE endpoint_revisions SET blocked_reason=NULL').run(),
    { event_id: null, state: 'paused', reason: 'endpoint_blocked' })
  await held('archive', () => db.prepare("UPDATE app_settings SET mode='archive'").run(), () => db.prepare("UPDATE app_settings SET mode='forward'").run(),
    { event_id: null, state: 'unavailable', reason: 'no_endpoint' })
  const auth = { Authorization: 'Bearer ' + BACKUP_TOKEN, 'Content-Type': 'application/json' }
  let lease
  await held('backup', async () => { lease = await request('/api/internal/backup/begin', { method: 'POST', headers: auth, body: JSON.stringify({ lease_seconds: 300 }) }) },
    () => request('/api/internal/backup/cancel', { method: 'POST', headers: auth, body: JSON.stringify({ backup_id: lease.backup_id }) }),
    { event_id: null, state: 'unavailable', reason: 'backup_active' })
  await held('capacity', () => db.prepare('UPDATE app_settings SET logical_limit_bytes=logical_bytes').run(),
    () => db.prepare('UPDATE app_settings SET logical_limit_bytes=5368709120').run(), { event_id: null, state: 'unavailable', reason: 'capacity' })

  // A canary held after it was queued reads paused, never failed.
  await db.prepare('UPDATE webhook_endpoints SET paused=1 WHERE id=?').bind(endpoint.id).run()
  const second = await ops('startCanary', 'StartCanaryResult', { run_id: 'canary-2026-09-30' })
  assert.equal(second.value.event_id, null, 'paused endpoint: not queued')
  await db.prepare('UPDATE webhook_endpoints SET paused=0 WHERE id=?').bind(endpoint.id).run()
  responses.push(503)
  await unthrottle()
  const third = await ops('startCanary', 'StartCanaryResult', { run_id: 'canary-2026-09-30' })
  await waitFor(() => db.prepare('SELECT state FROM deliveries WHERE event_id=?').bind(third.value.event_id).first(), row => row?.state === 'retry_wait', 'retrying')
  await db.prepare('UPDATE app_settings SET send_paused=1').run()
  assert.deepEqual((await ops('canaryDelivery', 'CanaryDelivery', third.value.event_id)).value, { state: 'paused', attempts: 1, last_http_status: 503, error_code: 'http_503' })
  assert.equal((await ops('startCanary', 'StartCanaryResult', { run_id: 'canary-2026-09-30' })).value.event_id, third.value.event_id, 'idempotent while paused')
  await db.prepare('UPDATE app_settings SET send_paused=0').run()

  // Canary content is cleaned 7 days later through the owner-delete path, within the alerts phase budget.
  await db.prepare("UPDATE messages SET received_at='2026-01-01T00:00:00.000Z' WHERE canary_run_id='canary-2026-09-29'").run()
  const groups = await cycle()
  const cleanup = groups.find(group => group.some(sql => sql.includes('messages_canary_idx')))
  assert.ok(cleanup.length <= 40, `alerts phase with a canary cleanup used ${cleanup.length} D1 statements`)
  const cleaned = await db.prepare('SELECT content_deleted_at,parsed_key,canary_run_id FROM messages WHERE id=?').bind(canary.id).first()
  assert.ok(cleaned.content_deleted_at); assert.equal(cleaned.parsed_key, null); assert.equal(cleaned.canary_run_id, 'canary-2026-09-29')
  assert.equal((await bucket.list({ prefix: `parsed/${canary.id}/` })).objects.length, 0)
  assert.equal((await bucket.head(`payload/${eventID}.json`)), null)
  assert.equal((await db.prepare('SELECT content_deleted_at FROM messages WHERE canary_run_id=?').bind('canary-2026-09-30').first()).content_deleted_at, null, 'a recent canary is kept')
  assert.deepEqual((await ops('canaryDelivery', 'CanaryDelivery', eventID)).value.state, 'delivered', 'the ledger outlives the content')
})

test('workerd Ops: maintenance mode reports down and refuses canaries without writing', { timeout: 60000 }, async t => {
  const { ops, counts, db } = await runtime(t, { MAINTENANCE_MODE: 'true' })
  const before = await counts()
  const status = await ops('status', 'OpsStatus')
  assert.equal(status.value.health, 'down'); assert.equal(status.value.modes.maintenance, true)
  assert.ok(status.value.signals.some(signal => signal.code === 'maintenance_mode' && signal.severity === 'critical'))
  const result = await ops('startCanary', 'StartCanaryResult', { run_id: 'canary-2026-09-29' })
  assert.deepEqual(result.value, { event_id: null, state: 'unavailable', reason: 'maintenance' })
  // Only the run's own idempotency lookup (a queued run keeps its event_id in maintenance).
  assert.equal(result.statements.length, 1); assert.match(result.statements[0], /^SELECT event_id FROM deliveries WHERE action_request_id=\?$/)
  assert.equal((await ops('setGuard', 'GuardState', { level: 'shed', reason: 'maintenance_window', until: new Date(Date.now() + 3600_000).toISOString() })).value.level, 'shed',
    'the guard is object storage and may be set during maintenance')
  assert.deepEqual(await counts(), before)
  assert.equal((await db.prepare('SELECT count(*) n FROM deliveries').first()).n, 0)
})

test('workerd Ops: shed defers exactly the four cleanup jobs within their bound and never ingest, parsing or delivery', { timeout: 180000 }, async t => {
  const { db, calls, ops, request, receive, forwardTarget, unthrottle, cycle, ranJobs } = await runtime(t)
  await forwardTarget()
  const kept = groups => Object.keys(KEPT_SQL).filter(name => groups.some(group => group.some(sql => sql.includes(KEPT_SQL[name]))))
  const all = Object.keys(JOB_SQL)
  // Normal: every job runs (the alert history purge and canary cleanup statements run even with nothing to do).
  let groups = await cycle()
  assert.deepEqual(ranJobs(groups), all)
  const until = new Date(Date.now() + 30 * 3600_000).toISOString()
  await ops('setGuard', 'GuardState', { level: 'shed', reason: 'd1_reads_high', until })
  // The raw inventory is due again (it normally waits a day between idle scans).
  await db.prepare("DELETE FROM maintenance WHERE id='raw_reconcile_after'").run()
  groups = await cycle()
  assert.deepEqual(ranJobs(groups), [], 'shed defers the four jobs that ran within 48 h')
  assert.deepEqual(kept(groups), Object.keys(KEPT_SQL), 'repair, purge resumption and alert evaluation keep running')

  // Ingest, parsing and delivery (with retries) of real mail and the canary are unaffected.
  await unthrottle()
  await receive()
  const real = await waitFor(() => db.prepare("SELECT m.parse_state,d.state FROM messages m LEFT JOIN deliveries d ON d.message_id=m.id WHERE m.origin='cloudflare'").first(),
    row => row?.state === 'delivered', 'real mail parsed and delivered while shed')
  assert.equal(real.parse_state, 'ready')
  await unthrottle()
  const canary = await ops('startCanary', 'StartCanaryResult', { run_id: 'canary-under-shed' })
  assert.equal(canary.value.state, 'queued')
  await waitFor(() => db.prepare('SELECT state FROM deliveries WHERE event_id=?').bind(canary.value.event_id).first(), row => row?.state === 'delivered', 'canary delivered while shed')
  assert.equal(calls.length, 2)
  const status = await ops('status', 'OpsStatus')
  assert.equal(status.value.guard.level, 'shed'); assert.deepEqual(status.value.guard.deferred, all)

  // Each job's own bound: once its last run is 48 h old it runs, even while the guard is renewed.
  await request('/__probe/sql', { method: 'POST', body: JSON.stringify({ sql: 'UPDATE ops_job_runs SET at=? WHERE job IN (?,?)', values: [Date.now() - 48 * 3600_000, 'lifecycle_retention', 'alert_history_purge'] }) })
  groups = await cycle()
  assert.deepEqual(ranJobs(groups), ['lifecycle_retention', 'alert_history_purge'])
  groups = await cycle()
  assert.deepEqual(ranJobs(groups), [], 'and is deferred again after that run')
  // Normal again: everything runs on the next cycle, nothing was rescheduled.
  await ops('setGuard', 'GuardState', { level: 'normal', reason: 'quota_recovered', until: null })
  await db.prepare("DELETE FROM maintenance WHERE id='raw_reconcile_after'").run()
  groups = await cycle()
  assert.deepEqual(ranJobs(groups), all)
})

test('workerd Ops: under a renewed shed guard a whole raw scan and the retention and history backlogs still finish once their bound is reached', { timeout: 180000 }, async t => {
  const { db, bucket, ops, request, cycle, ranJobs } = await runtime(t)
  const probe = (sql, values) => request('/__probe/sql', { method: 'POST', body: JSON.stringify({ sql, values }) })
  const lastRun = async job => (await probe('SELECT at FROM ops_job_runs WHERE job=?', [job]))[0]?.at ?? null
  const setRun = (job, at) => probe('INSERT INTO ops_job_runs(job,at) VALUES(?,?) ON CONFLICT(job) DO UPDATE SET at=excluded.at', [job, at])
  // 250 raw objects that are not message keys: three list pages, and no parse job for any of them.
  for (let i = 0; i < 250; i++) await bucket.put(`raw/!filler-${String(i).padStart(3, '0')}`, 'x')
  // 45 unsettled messages: the retention sweep reads 20 a pass, so it needs three passes to catch up.
  const received = new Date(Date.now() - 3600_000).toISOString()
  await db.batch(Array.from({ length: 45 }, (_, i) => db.prepare(`INSERT INTO messages(id,received_at,last_received_at,envelope_from,envelope_recipient,size_bytes,receive_mode,parse_state)
    VALUES(?,?,?,'a@example.org','b@example.org',1,'archive','failed')`).bind(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, received, received)))
  // 45 alert notifications past their 180 days: the history purge deletes 20 a pass.
  const expired = new Date(Date.now() - 200 * 86400_000).toISOString()
  await db.prepare(`INSERT OR IGNORE INTO alerts(code,active,severity,metrics_json,first_seen_at,last_seen_at,last_event_day)
    VALUES('parse_failed',0,'warning','{}',?,?,'2026-01-01')`).bind(expired, expired).run()
  await db.batch(Array.from({ length: 45 }, (_, i) => db.prepare(`INSERT INTO alert_notifications(id,code,transition,day,payload_json,state,next_attempt_at,created_at)
    VALUES(?,'parse_failed','active',?,'{}','sent',?,?)`).bind(`history-${i}`, new Date(Date.parse(expired) - i * 86400_000).toISOString().slice(0, 10), expired, expired)))
  const jobs = ['raw_reconcile', 'lifecycle_retention', 'alert_history_purge']
  // Each last completed 48 h ago: the bound is reached although the guard stays on.
  const old = Date.now() - 48 * 3600_000
  for (const job of jobs) await setRun(job, old)
  const ran = []
  for (let pass = 0; pass < 6; pass++) {
    // The dashboard renews the guard every time; the next raw page is due (its 10 minutes have passed).
    await ops('setGuard', 'GuardState', { level: 'shed', reason: 'd1_reads_high', until: new Date(Date.now() + 30 * 3600_000 + pass * 1000).toISOString() })
    await db.prepare("DELETE FROM maintenance WHERE id='raw_reconcile_after'").run()
    ran.push(ranJobs(await cycle()).filter(job => jobs.includes(job)))
    if (pass === 0) {
      assert.equal(await lastRun('raw_reconcile'), old, 'one page is not a run of the job')
      assert.equal(await lastRun('lifecycle_retention'), old, 'a pass that left a backlog is not a run of the job')
      // Even a recent complete pass does not hold back the rest of a pass in progress.
      await setRun('raw_reconcile', Date.now())
    }
  }
  assert.deepEqual(ran, [jobs, jobs, jobs, [], [], []], 'every page and every batch until caught up, then deferred again')
  assert.equal((await db.prepare("SELECT value FROM maintenance WHERE id='raw_reconcile_cursor'").first()).value, '', 'the scan reached the end of the bucket')
  assert.equal((await db.prepare('SELECT count(*) n FROM messages WHERE retention_started_at IS NULL AND resolved_at IS NULL').first()).n, 45)
  assert.equal((await db.prepare("SELECT value FROM maintenance WHERE id='retention_sweep_cursor'").first()).value, '', 'the sweep caught up')
  assert.equal((await db.prepare('SELECT count(*) n FROM alert_notifications WHERE created_at=?').bind(expired).first()).n, 0, 'the history purge caught up')
  for (const job of jobs) assert.ok(await lastRun(job) > Date.now() - 600_000, `${job} recorded its complete run`)
})
