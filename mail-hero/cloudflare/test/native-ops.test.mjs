// contracts/ops-v1, Mail Hero side, without workerd: guard rules and storage, status derivation, canary
// delivery mapping and input validation. Every produced output is read back strictly with the contract's rules
// (proto/ops/v1/ops.proto, the wire codec): the producer's view of the generated JSON Schema.
// native-ops-runtime.test.mjs covers the real bindings, ops-golden.test.mjs the exact bytes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import * as ops from '@ziyixi/proto/ops/v1/ops_pb'
import { fieldRules, fromWire } from '@ziyixi/proto/wire-json'
import { DEFER_BOUND_MS, DEFERRABLE_JOBS, OpsGuardStore, guardState, parseGuardInput, parseTimestamp } from '../src/native/ops-guard.ts'
import { evaluateAlerts } from '../src/native/alerts.ts'
import { buildStatus, canaryDelivery, canaryDeliveryState, opsCall, opsSetGuard, startCanary, uiURL } from '../src/native/ops-core.ts'

/** `value` after a strict read with the contract's rules (it throws on anything the contract refuses). */
function valid(def, value) {
  fromWire(ops[`${def}Schema`], value, { strict: true })
  return value
}
const NOW = Date.parse('2026-09-29T12:00:00.000Z')
const iso = offset => new Date(NOW + offset).toISOString()
const HOUR = 3600_000

/** The Durable Object SqlStorage surface OpsGuardStore uses, on real SQLite. */
function sqlStorage() {
  const db = new DatabaseSync(':memory:')
  return { exec(sql, ...args) { const rows = db.prepare(sql).all(...args).map(row => ({ ...row })); return { toArray: () => rows, one: () => rows[0] } } }
}
async function rejects(promise, code) {
  await assert.rejects(promise, error => error instanceof Error && error.message === code)
}

test('setGuard input: shed needs a future until at most 36 h ahead, normal needs null, codes only', () => {
  assert.deepEqual(parseGuardInput({ level: 'shed', reason: 'd1_reads_high', until: iso(HOUR) }, NOW), { level: 'shed', reason: 'd1_reads_high', until: NOW + HOUR })
  assert.deepEqual(parseGuardInput({ level: 'shed', reason: 'r', until: iso(36 * HOUR) }, NOW).until, NOW + 36 * HOUR)
  assert.deepEqual(parseGuardInput({ level: 'normal', reason: 'quota_recovered', until: null }, NOW), { level: 'normal', reason: 'quota_recovered', until: null })
  for (const input of [
    null, [], 'shed', {}, { level: 'shed', reason: 'x' },
    { level: 'shed', reason: 'x', until: iso(36 * HOUR + 1000) }, { level: 'shed', reason: 'x', until: iso(0) }, { level: 'shed', reason: 'x', until: iso(-HOUR) },
    { level: 'shed', reason: 'x', until: null }, { level: 'normal', reason: 'x', until: iso(HOUR) },
    { level: 'shed', reason: 'X', until: iso(HOUR) }, { level: 'shed', reason: 'Mail from bob', until: iso(HOUR) }, { level: 'shed', reason: 'x\n', until: iso(HOUR) },
    { level: 'shed', reason: 'x', until: iso(HOUR) + '\n' }, { level: 'shed', reason: 'x', until: '2026-09-29T13:00:00+01:00' },
    { level: 'shed', reason: 'x', until: NOW + HOUR }, { level: 'paused', reason: 'x', until: null },
    { level: 'shed', reason: 'x', until: iso(HOUR), extra: 1 },
  ]) assert.throws(() => parseGuardInput(input, NOW), /^Error: invalid_input$/, JSON.stringify(input))
  assert.equal(parseTimestamp('2026-02-30T00:00:00Z'), null, 'no calendar rollover')
  assert.equal(parseTimestamp('2026-09-29T12:00:00.5Z'), NOW + 500)
})

test('guard store: idempotent set, last writer wins, normal clears, expiry reads normal without an alarm', () => {
  const store = new OpsGuardStore(sqlStorage())
  const normal = valid('GuardState', store.read(NOW))
  assert.deepEqual(normal, { level: 'normal', reason: null, until: null, set_at: null, deferred: [] })
  const input = { level: 'shed', reason: 'd1_reads_high', until: iso(6 * HOUR) }
  const first = valid('GuardState', store.set(input, NOW))
  assert.deepEqual(first, { level: 'shed', reason: 'd1_reads_high', until: iso(6 * HOUR), set_at: iso(0), deferred: [...DEFERRABLE_JOBS] })
  assert.deepEqual(store.set(input, NOW + 60_000), first, 'the same request keeps set_at')
  assert.deepEqual(store.set({ ...input, until: '2026-09-29T18:00:00Z' }, NOW + 60_000), first, 'the same instant written without milliseconds')
  const renewed = valid('GuardState', store.set({ ...input, until: iso(8 * HOUR) }, NOW + 60_000))
  assert.equal(renewed.set_at, iso(60_000)); assert.equal(renewed.until, iso(8 * HOUR))
  assert.equal(store.set({ ...input, reason: 'r2_ops_high', until: iso(8 * HOUR) }, NOW + 120_000).reason, 'r2_ops_high')
  assert.deepEqual(store.read(NOW + 8 * HOUR - 1).level, 'shed')
  assert.deepEqual(store.read(NOW + 8 * HOUR), normal, 'expired at until')
  assert.throws(() => store.set({ ...input, until: iso(-1000) }, NOW), /invalid_input/)
  assert.equal(store.read(NOW).level, 'shed', 'a refused request changes nothing')
  assert.deepEqual(valid('GuardState', store.set({ level: 'normal', reason: 'quota_recovered', until: null }, NOW)), normal)
  assert.deepEqual(store.read(NOW), normal)
  assert.deepEqual(guardState({ level: 'shed', reason: 'bad reason', until: NOW + HOUR, set_at: NOW }, NOW), normal, 'a damaged row reads normal')
})

test('deferral: only while shed and only within 48 h of the job\'s last run', () => {
  // ran() records the real clock, so this test's guard follows the real clock too (a fixed NOW made it
  // fail once the wall clock passed NOW + 30 h).
  const t = Date.now()
  const at = offset => new Date(t + offset).toISOString()
  const store = new OpsGuardStore(sqlStorage())
  const all = deferral => DEFERRABLE_JOBS.filter(job => deferral.defers(job))
  assert.deepEqual(all(store.deferral(t)), [], 'normal defers nothing')
  store.set({ level: 'shed', reason: 'd1_reads_high', until: at(30 * HOUR) }, t)
  assert.deepEqual(all(store.deferral(t)), [], 'a job that never ran runs once even while shed')
  const deferral = store.deferral(t)
  for (const job of DEFERRABLE_JOBS) deferral.ran(job)
  assert.deepEqual(all(store.deferral(Date.now())), [...DEFERRABLE_JOBS])
  const late = t + DEFER_BOUND_MS + 1000
  store.set({ level: 'shed', reason: 'd1_reads_high', until: at(DEFER_BOUND_MS + 2 * HOUR) }, late - HOUR)
  assert.equal(store.read(late).level, 'shed')
  assert.deepEqual(all(store.deferral(late)), [], 'the bound is reached even under a renewed guard')
  store.set({ level: 'normal', reason: 'quota_recovered', until: null }, t)
  assert.deepEqual(all(store.deferral(Date.now())), [], 'normal again')
})

const env = { MAINTENANCE_MODE: 'false', FORCE_SEND_PAUSED: 'false', INGEST_DAILY_MESSAGE_LIMIT: '300', INGEST_DAILY_BYTE_LIMIT: '268435456', PUBLIC_HOST: 'mail.example.org' }
const normalGuard = { level: 'normal', reason: null, until: null, set_at: null, deferred: [] }
const coordinator = { jobs_pending: 2, jobs_failed: 0, backup_active: false, capacity: { used_bytes: 1000, limit_bytes: 5 * 1024 ** 3 },
  ingest_today: { messages: 4, bytes: 4096 }, guard: normalGuard }
const snapshot = { logical_bytes: 900, logical_limit_bytes: 5 * 1024 ** 3, last_backup_at: iso(-HOUR), created_at: iso(-100 * HOUR),
  oldest_pending_at: null, parse_failed: 0, delivery_failed: 0, policy_error: 0, current_blocked: 0, current_auto_recheck: 0, current_paused: 0,
  blocked_waiting: 0, blocked_permanent_waiting: 0, paused_waiting: 0, send_paused: 0, forwarding: 1 }
const status = (overrides = {}) => valid('OpsStatus', buildStatus({ time: NOW, env, coordinator, snapshot, active: [], ...overrides }))

test('status: ok with every counter and the modes when nothing is wrong', () => {
  const value = status()
  assert.equal(value.app, 'mail-hero'); assert.equal(value.health, 'ok'); assert.deepEqual(value.signals, [])
  assert.deepEqual(value.modes, { maintenance: false, force_send_paused: false, send_paused: false, forwarding: true, backup_active: false })
  assert.deepEqual(Object.keys(value.counters).sort(), ['blocked_waiting', 'capacity_limit_bytes', 'capacity_used_bytes', 'delivery_failed', 'ingest_limit_bytes',
    'ingest_limit_messages', 'ingest_today_bytes', 'ingest_today_messages', 'jobs_failed', 'jobs_pending', 'logical_bytes', 'oldest_pending_age_seconds',
    'parse_failed', 'paused_waiting', 'policy_error'])
  assert.equal(value.last_backup_at, iso(-HOUR)); assert.equal(value.ui_url, 'https://mail.example.org/')
  assert.deepEqual(value.capabilities, ['canary_producer', 'guard'])
})

test('status: alert signals with since, ops signals, severity order and health', () => {
  const value = status({
    env: { ...env, FORCE_SEND_PAUSED: 'true' },
    coordinator: { ...coordinator, backup_active: true, ingest_today: { messages: 250, bytes: 1 }, guard: { level: 'shed', reason: 'd1_reads_high', until: iso(HOUR), set_at: iso(0), deferred: [...DEFERRABLE_JOBS] } },
    snapshot: { ...snapshot, parse_failed: 2, current_blocked: 1, current_auto_recheck: 1, blocked_waiting: 3, send_paused: 1, forwarding: 0, oldest_pending_at: iso(-2 * HOUR), last_backup_at: iso(-40 * HOUR) },
    active: [{ code: 'endpoint_blocked', active_since: '2026-09-29T10:02:11.000Z' }, { code: 'parse_failed', active_since: null }],
  })
  assert.equal(value.health, 'degraded')
  assert.deepEqual(value.signals.map(signal => [signal.severity, signal.code]), [
    ['critical', 'backup_stale'], ['critical', 'endpoint_blocked'],
    ['warning', 'force_send_paused'], ['warning', 'ingest_quota_80'], ['warning', 'parse_failed'], ['warning', 'pending_stale'], ['warning', 'send_paused'],
    ['info', 'backup_active'], ['info', 'forwarding_off'], ['info', 'guard_shed']])
  const byCode = Object.fromEntries(value.signals.map(signal => [signal.code, signal]))
  assert.equal(byCode.endpoint_blocked.since, '2026-09-29T10:02:11.000Z')
  assert.equal('since' in byCode.parse_failed, false, 'an alert active before 0010 has no since')
  assert.deepEqual(byCode.endpoint_blocked.metrics, { waiting_deliveries: 3, current_blocked: 1, auto_recheck: 1 })
  assert.deepEqual(byCode.ingest_quota_80.metrics, { messages: 250, bytes: 1, message_limit: 300, byte_limit: 268435456, percent: 83.3 })
  assert.deepEqual(byCode.guard_shed.metrics, { seconds_left: 3600 })
  assert.equal(value.counters.oldest_pending_age_seconds, 7200)
  assert.deepEqual(value.modes, { maintenance: false, force_send_paused: true, send_paused: true, forwarding: false, backup_active: true })
  assert.equal(value.guard.level, 'shed')
})

test('status: maintenance is down; an unreadable source is down with only status_unavailable', () => {
  const maintenance = status({ env: { ...env, MAINTENANCE_MODE: 'true' } })
  assert.equal(maintenance.health, 'down')
  assert.deepEqual(maintenance.signals.map(signal => signal.code), ['maintenance_mode'])
  for (const missing of [{ coordinator: null }, { snapshot: null }, { active: null }]) {
    const value = status(missing)
    assert.equal(value.health, 'down')
    assert.deepEqual(value.signals, [{ code: 'status_unavailable', severity: 'critical', metrics: {} }])
    assert.deepEqual(value.counters, {}); assert.equal(value.last_backup_at, null)
    assert.deepEqual(value.modes, { maintenance: false, force_send_paused: false }, 'only the deployment variables')
  }
  assert.equal(status({ snapshot: null, coordinator: { ...coordinator, guard: { level: 'shed', reason: 'x', until: iso(HOUR), set_at: iso(0), deferred: [] } } }).guard.level, 'shed')
  assert.equal(status({ env: { ...env, PUBLIC_HOST: 'Mail.Example.org' } }).ui_url, null)
  assert.equal(status({ env: { ...env, PUBLIC_HOST: undefined } }).ui_url, null)
  assert.equal(uiURL('mail.example.org/../x'), null)
  const noCapacity = status({ coordinator: { ...coordinator, capacity: null } })
  assert.equal('capacity_used_bytes' in noCapacity.counters, false, 'a counter that was not read is left out')
})

/** The modes each app writes even on a `status_unavailable` status (its deployment variables, contracts/ops-v1
 * README "modes"); a key read from storage is left out then, never guessed. */
const DEPLOYMENT_MODES = { 'mail-hero': ['maintenance', 'force_send_paused'], todofy: ['maintenance', 'processing_paused', 'force_pause_todoist', 'reminder_enabled'], lab: ['maintenance'], watch: ['maintenance', 'notifications'] }

test('status: every deployment-variable mode is a boolean, also on status_unavailable', () => {
  for (const value of [status(), status({ env: { ...env, MAINTENANCE_MODE: 'true' } }), status({ coordinator: null }), status({ snapshot: null })]) {
    for (const key of DEPLOYMENT_MODES['mail-hero']) assert.equal(typeof value.modes[key], 'boolean', `${key} in ${JSON.stringify(value.modes)}`)
  }
  for (const file of readdirSync(new URL('../../../contracts/ops-v1/fixtures/OpsStatus/', import.meta.url))) {
    const fixture = JSON.parse(readFileSync(new URL(`../../../contracts/ops-v1/fixtures/OpsStatus/${file}`, import.meta.url), 'utf8'))
    for (const key of DEPLOYMENT_MODES[fixture.app]) assert.equal(typeof fixture.modes[key], 'boolean', `${file}: ${key}`)
  }
})

test('status: signals, metrics and counters stay within the contract bounds', () => {
  const value = status({ snapshot: { ...snapshot, logical_bytes: 5 * 1024 ** 3, parse_failed: 1, delivery_failed: 1, policy_error: 1, current_paused: 1, paused_waiting: 1,
    current_blocked: 1, oldest_pending_at: iso(-3 * HOUR), last_backup_at: null, send_paused: 1, forwarding: 0 },
    env: { ...env, MAINTENANCE_MODE: 'true', FORCE_SEND_PAUSED: '1' },
    coordinator: { ...coordinator, backup_active: true, ingest_today: { messages: 300, bytes: 268435456 }, guard: { level: 'shed', reason: 'x', until: iso(HOUR), set_at: iso(0), deferred: [] } } })
  assert.ok(value.signals.length <= fieldRules(ops.OpsStatusSchema.field.signals).maxItems)
  assert.equal(value.signals.length, 15, 'every Mail Hero signal at once still fits')
})

test('canaryDelivery mapping for every delivery state', () => {
  const row = { state: 'pending', attempt_count: 0, created_at: iso(-HOUR), delivered_at: null, last_error: null, endpoint_paused: 0, archived_at: null, send_paused: 0, last_http_status: null }
  const map = (overrides, variables = env) => valid('CanaryDelivery', canaryDeliveryState({ ...row, ...overrides }, variables))
  assert.deepEqual(valid('CanaryDelivery', canaryDeliveryState(null, env)), { state: 'unknown', attempts: 0 })
  assert.deepEqual(map({}), { state: 'pending', attempts: 0 })
  assert.deepEqual(map({ state: 'retry_wait', attempt_count: 1, last_error: 'http_503', last_http_status: 503 }), { state: 'pending', attempts: 1, last_http_status: 503, error_code: 'http_503' })
  assert.deepEqual(map({ state: 'sending', attempt_count: 2 }), { state: 'pending', attempts: 2 })
  assert.deepEqual(map({ state: 'delivered', attempt_count: 2, delivered_at: iso(0), last_http_status: 204 }), { state: 'delivered', attempts: 2, last_http_status: 204, delivered_at: iso(0) })
  assert.deepEqual(map({ state: 'failed', attempt_count: 48, last_error: 'retry_window_expired', last_http_status: 503 }), { state: 'failed', attempts: 48, last_http_status: 503, error_code: 'retry_window_expired' })
  assert.deepEqual(map({ state: 'cancelled', attempt_count: 1 }), { state: 'failed', attempts: 1, error_code: 'canary_cancelled' })
  assert.deepEqual(map({ state: 'failed', last_error: 'not a code' }), { state: 'failed', attempts: 0, error_code: 'delivery_failed' })
  for (const hold of [{ endpoint_paused: 1 }, { archived_at: iso(0) }, { send_paused: 1 }]) assert.equal(map({ state: 'retry_wait', ...hold }).state, 'paused')
  assert.equal(map({}, { ...env, FORCE_SEND_PAUSED: 'true' }).state, 'paused')
  assert.equal(map({}, { ...env, MAINTENANCE_MODE: 'true' }).state, 'paused')
  assert.equal(map({ state: 'delivered', attempt_count: 1, delivered_at: iso(0) }, { ...env, FORCE_SEND_PAUSED: 'true' }).state, 'delivered', 'a pause does not hide a result')
  // contract-4: a blocked revision holds the canary as startCanary and the owner UI say (paused, block code).
  const blockedAt = (overrides) => valid('CanaryDelivery', canaryDeliveryState({ ...row, state: 'retry_wait', attempt_count: 1, last_error: 'http_401', last_http_status: 401, ...overrides }, env, NOW))
  assert.deepEqual(blockedAt({ blocked_reason: 'http_401' }), { state: 'paused', attempts: 1, last_http_status: 401, error_code: 'http_401' })
  assert.deepEqual(blockedAt({ blocked_reason: 'http_404', blocked_until: iso(HOUR) }), { state: 'paused', attempts: 1, last_http_status: 401, error_code: 'http_404' })
  assert.equal(blockedAt({ blocked_reason: 'http_404', blocked_until: iso(-HOUR) }).state, 'pending', 'a block due for its recheck is sendable')
  assert.equal(blockedAt({ blocked_reason: 'http_401', state: 'delivered', delivered_at: iso(0) }).state, 'delivered')
  assert.deepEqual(blockedAt({ blocked_reason: 'Not A Code' }), { state: 'paused', attempts: 1, last_http_status: 401, error_code: 'http_401' })
})

test('input validation rejects with invalid_input before any binding is touched', async () => {
  const untouchable = new Proxy({}, { get(_, property) { if (property === 'then') return undefined; throw new Error(`touched ${String(property)}`) } })
  for (const input of [null, {}, { run_id: '' }, { run_id: '-leading' }, { run_id: 'a'.repeat(65) }, { run_id: 'canary 1' }, { run_id: 'canary\n' },
    { run_id: 'canary-2026-09-29', extra: true }, ['canary-2026-09-29'], 'canary-2026-09-29']) {
    await rejects(opsCall(() => startCanary(untouchable, input)), 'invalid_input')
  }
  for (const id of [null, '', 'not-a-uuid', '0E0E0E0E-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000\n']) {
    await rejects(opsCall(() => canaryDelivery(untouchable, id)), 'invalid_input')
  }
  await rejects(opsCall(() => opsSetGuard(untouchable, { level: 'shed', reason: 'x', until: iso(-HOUR) })), 'invalid_input')
  // Anything else, including provider text, leaves only as `unavailable`.
  await rejects(opsCall(async () => { throw new Error('D1_ERROR: no such table: secret_sql') }), 'unavailable')
  await rejects(opsCall(async () => { throw 'string' }), 'unavailable')
  await rejects(opsCall(async () => { throw new Error('busy') }), 'busy')
})

test('startCanary reports holds as values in order and creates nothing', async () => {
  const target = { mode: 'forward', send_paused: 0, endpoint_id: 'e', paused: 0, archived_at: null, current_revision_id: 'r', revision_id: 'r', blocked_reason: null, blocked_until: null }
  const fake = (row, variables = {}, queued = null) => {
    const statements = [], touched = []
    return { statements, touched, env: { ...env, ...variables, COORDINATOR: { idFromName() { touched.push('coordinator'); throw new Error('coordinator_down') } },
      DB: { prepare(sql) { statements.push(sql); const statement = { bind: () => statement,
        async first() { if (queued instanceof Error) throw queued; return /action_request_id/.test(sql) ? queued : row } }; return statement } } } }
  }
  const run = async (row, variables, queued) => { const value = fake(row, variables, queued); return { result: valid('StartCanaryResult', await startCanary(value.env, { run_id: 'canary-2026-09-29' }, NOW)), statements: value.statements } }
  assert.deepEqual((await run(target, { MAINTENANCE_MODE: 'true' })).result, { event_id: null, state: 'unavailable', reason: 'maintenance' })
  assert.equal((await run(target, { MAINTENANCE_MODE: 'true' })).statements.length, 1, 'maintenance reads only the run\'s own event')
  assert.deepEqual((await run(target, { MAINTENANCE_MODE: 'true' }, new Error('d1_down'))).result.reason, 'maintenance')
  // contract-3: a run already queued keeps its event_id whatever holds sending now, maintenance included.
  const queued = { event_id: '6f1f4c1e-3b9a-4f55-9d0e-0a1b2c3d4e5f' }
  for (const variables of [{ MAINTENANCE_MODE: 'true' }, { FORCE_SEND_PAUSED: 'true' }, {}]) {
    assert.deepEqual((await run({ ...target, send_paused: 1 }, variables, queued)).result, { event_id: queued.event_id, state: 'queued' }, JSON.stringify(variables))
  }
  assert.deepEqual((await run({ ...target, send_paused: 1 }, { FORCE_SEND_PAUSED: 'true' })).result.reason, 'send_paused')
  assert.deepEqual((await run({ ...target, send_paused: 1, mode: 'archive' })).result.reason, 'settings_paused')
  assert.deepEqual((await run({ ...target, mode: 'archive', paused: 1 })).result, { event_id: null, state: 'unavailable', reason: 'no_endpoint' })
  assert.deepEqual((await run({ ...target, endpoint_id: null, revision_id: null })).result.reason, 'no_endpoint')
  assert.deepEqual((await run({ ...target, paused: 1, blocked_reason: 'http_401' })).result, { event_id: null, state: 'paused', reason: 'endpoint_paused' })
  assert.deepEqual((await run({ ...target, archived_at: iso(0) })).result.reason, 'endpoint_paused')
  assert.deepEqual((await run({ ...target, blocked_reason: 'http_401' })).result.reason, 'endpoint_blocked')
  assert.deepEqual((await run({ ...target, blocked_reason: 'http_404', blocked_until: iso(HOUR) })).result.reason, 'endpoint_blocked')
  // A due recheck is sendable, so it proceeds to the write (here: a coordinator that is down).
  const due = fake({ ...target, blocked_reason: 'http_404', blocked_until: iso(-HOUR) })
  await rejects(opsCall(() => startCanary(due.env, { run_id: 'canary-2026-09-29' }, NOW)), 'unavailable')
  assert.deepEqual(due.touched, ['coordinator'])
  assert.equal((await run({ ...target, paused: 1 })).statements.length, 2, 'two reads before any write')
})

/** The production migrations on real SQLite, behind D1's small binding surface (as native-api.test.mjs). */
function testD1() {
  const sqlite = new DatabaseSync(':memory:')
  const directory = new URL('../migrations/', import.meta.url)
  for (const file of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, directory), 'utf8'))
  const statement = (sql, args = []) => ({ bind: (...values) => statement(sql, values),
    execute() { const results = sqlite.prepare(sql).all(...args).map(row => ({ ...row })); return { results, meta: { changes: Number(sqlite.prepare('SELECT changes() n').get().n) } } },
    async all() { return this.execute() }, async run() { return this.execute() }, async first() { return this.execute().results[0] ?? null } })
  return { sqlite, prepare: sql => statement(sql),
    async batch(items) { sqlite.exec('BEGIN'); try { const out = items.map(item => item.execute()); sqlite.exec('COMMIT'); return out } catch (error) { sqlite.exec('ROLLBACK'); throw error } } }
}

test('alerts.active_since marks the start of the current activation only', async () => {
  const DB = testD1()
  const env = { DB, WEBHOOK_ALLOWED_HOSTS: 'consumer.example.org', COORDINATOR: { idFromName() { throw new Error('capacity_unavailable') } } }
  const since = () => DB.sqlite.prepare("SELECT active,active_since FROM alerts WHERE code='parse_failed'").get()
  const failed = id => DB.sqlite.prepare(`INSERT INTO messages(id,received_at,last_received_at,envelope_from,envelope_recipient,size_bytes,receive_mode,parse_state)
    VALUES(?,'2026-09-29T00:00:00.000Z','2026-09-29T00:00:00.000Z','a@example.org','b@example.org',1,'archive','failed')`).run(id)
  failed('00000000-0000-4000-8000-000000000001')
  await evaluateAlerts(env, NOW)
  assert.deepEqual({ ...since() }, { active: 1, active_since: iso(0) })
  await evaluateAlerts(env, NOW + HOUR)
  assert.deepEqual({ ...since() }, { active: 1, active_since: iso(0) }, 'kept while active')
  // A row written active by the previous Worker (no active_since) gets one on the next evaluation.
  DB.sqlite.prepare("UPDATE alerts SET active_since=NULL WHERE code='parse_failed'").run()
  await evaluateAlerts(env, NOW + 2 * HOUR)
  assert.equal(since().active_since, iso(2 * HOUR))
  DB.sqlite.prepare("UPDATE messages SET parse_state='ready'").run()
  await evaluateAlerts(env, NOW + 3 * HOUR)
  assert.deepEqual({ ...since() }, { active: 0, active_since: null }, 'cleared on resolution')
  DB.sqlite.prepare("UPDATE messages SET parse_state='failed'").run()
  await evaluateAlerts(env, NOW + 4 * HOUR)
  assert.equal(since().active_since, iso(4 * HOUR), 'a new episode starts anew')
})
