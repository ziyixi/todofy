// contracts/ops-v1: the exact bytes Mail Hero's Ops code answers for fixed synthetic state. The dashboard and
// older dashboards read these answers, so a refactor of the Ops code (its move onto the generated proto types,
// for one) must not change one byte: every case is compared as compact JSON (JSON.stringify, the key order and
// number spelling included) with test/golden/ops-v1.json, which was written by the code before that move.
// `UPDATE_GOLDEN=1 node --test test/ops-golden.test.mjs` rewrites the file; only do that for an intended change
// of the contract, never to make a refactor pass.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { validate } from '../../../contracts/ops-v1/validate.mjs'
import { OpsGuardStore } from '../src/native/ops-guard.ts'
import { buildStatus, canaryDeliveryState, startCanary } from '../src/native/ops-core.ts'

const GOLDEN = new URL('golden/ops-v1.json', import.meta.url)
/** The hand-written schema the dashboards deployed before ops-v1 moved onto proto/ validate every answer with. */
const LEGACY = JSON.parse(readFileSync(new URL('../../../contracts/ops-v1/legacy/ops-v1.schema.json', import.meta.url), 'utf8'))
/** The contract message of each kind of case. */
const DEFS = { status: 'OpsStatus', guard: 'GuardState', delivery: 'CanaryDelivery', start: 'StartCanaryResult' }
const NOW = Date.parse('2026-09-29T12:00:00.000Z')
const HOUR = 3600_000
const iso = offset => new Date(NOW + offset).toISOString()

function sqlStorage() {
  const db = new DatabaseSync(':memory:')
  return { exec(sql, ...args) { const rows = db.prepare(sql).all(...args).map(row => ({ ...row })); return { toArray: () => rows, one: () => rows[0] } } }
}

const env = { MAINTENANCE_MODE: 'false', FORCE_SEND_PAUSED: 'false', INGEST_DAILY_MESSAGE_LIMIT: '300', INGEST_DAILY_BYTE_LIMIT: '268435456', PUBLIC_HOST: 'mail.example.org' }
const normalGuard = { level: 'normal', reason: null, until: null, set_at: null, deferred: [] }
const shedGuard = { level: 'shed', reason: 'd1_reads_high', until: iso(HOUR), set_at: iso(0), deferred: ['raw_reconcile', 'lifecycle_retention', 'canary_cleanup', 'alert_history_purge'] }
const coordinator = { jobs_pending: 2, jobs_failed: 0, backup_active: false, capacity: { used_bytes: 1000, limit_bytes: 5 * 1024 ** 3 },
  ingest_today: { messages: 4, bytes: 4096 }, guard: normalGuard }
const snapshot = { logical_bytes: 900, logical_limit_bytes: 5 * 1024 ** 3, last_backup_at: iso(-HOUR), created_at: iso(-100 * HOUR),
  oldest_pending_at: null, parse_failed: 0, delivery_failed: 0, policy_error: 0, current_blocked: 0, current_auto_recheck: 0, current_paused: 0,
  blocked_waiting: 0, blocked_permanent_waiting: 0, paused_waiting: 0, send_paused: 0, forwarding: 1 }
const status = (overrides = {}) => buildStatus({ time: NOW, env, coordinator, snapshot, active: [], ...overrides })

const row = { state: 'pending', attempt_count: 0, created_at: iso(-HOUR), delivered_at: null, last_error: null, endpoint_paused: 0, archived_at: null, send_paused: 0, last_http_status: null }
const delivery = (overrides, variables = env) => canaryDeliveryState({ ...row, ...overrides }, variables, NOW)

const target = { mode: 'forward', send_paused: 0, endpoint_id: 'e', paused: 0, archived_at: null, current_revision_id: 'r', revision_id: 'r', blocked_reason: null, blocked_until: null }
/** startCanary against a D1 that answers `queued` for the run's own event and `row` for the target. */
function start(row, variables = {}, queued = null) {
  const DB = { prepare(sql) { const statement = { bind: () => statement, async first() { return /action_request_id/.test(sql) ? queued : row } }; return statement } }
  return startCanary({ ...env, ...variables, DB }, { run_id: 'canary-2026-09-29' }, NOW)
}

async function cases() {
  const guard = new OpsGuardStore(sqlStorage())
  const shedInput = { level: 'shed', reason: 'd1_reads_high', until: iso(6 * HOUR) }
  return {
    'status/ok': status(),
    'status/degraded': status({
      env: { ...env, FORCE_SEND_PAUSED: 'true' },
      coordinator: { ...coordinator, backup_active: true, ingest_today: { messages: 250, bytes: 1 }, guard: shedGuard },
      snapshot: { ...snapshot, parse_failed: 2, current_blocked: 1, current_auto_recheck: 1, blocked_waiting: 3, send_paused: 1, forwarding: 0, oldest_pending_at: iso(-2 * HOUR), last_backup_at: iso(-40 * HOUR) },
      active: [{ code: 'endpoint_blocked', active_since: '2026-09-29T10:02:11.000Z' }, { code: 'parse_failed', active_since: null }],
    }),
    'status/every-signal': status({
      snapshot: { ...snapshot, logical_bytes: 5 * 1024 ** 3, parse_failed: 1, delivery_failed: 1, policy_error: 1, current_paused: 1, paused_waiting: 1,
        current_blocked: 1, oldest_pending_at: iso(-3 * HOUR), last_backup_at: null, send_paused: 1, forwarding: 0 },
      env: { ...env, MAINTENANCE_MODE: 'true', FORCE_SEND_PAUSED: '1' },
      coordinator: { ...coordinator, backup_active: true, ingest_today: { messages: 300, bytes: 268435456 }, guard: { ...shedGuard, deferred: [] } },
    }),
    'status/maintenance': status({ env: { ...env, MAINTENANCE_MODE: 'true' } }),
    'status/unavailable': status({ coordinator: null }),
    'status/unavailable-shed': status({ snapshot: null, coordinator: { ...coordinator, guard: shedGuard } }),
    'status/no-capacity-no-host': status({ coordinator: { ...coordinator, capacity: null }, env: { ...env, PUBLIC_HOST: undefined, INGEST_DAILY_BYTE_LIMIT: 'x' } }),
    'guard/normal': guard.read(NOW),
    'guard/shed': guard.set(shedInput, NOW),
    'guard/shed-again': guard.set({ ...shedInput, until: '2026-09-29T18:00:00Z' }, NOW + 60_000),
    'guard/renewed': guard.set({ ...shedInput, until: iso(8 * HOUR) }, NOW + 60_000),
    'guard/cleared': guard.set({ level: 'normal', reason: 'quota_recovered', until: null }, NOW + 120_000),
    'delivery/unknown': canaryDeliveryState(null, env, NOW),
    'delivery/pending-first': delivery({}),
    'delivery/pending-retrying': delivery({ state: 'retry_wait', attempt_count: 1, last_error: 'http_503', last_http_status: 503 }),
    'delivery/delivered': delivery({ state: 'delivered', attempt_count: 2, delivered_at: '2026-09-29T22:30:04.512Z', last_http_status: 204 }),
    'delivery/delivered-no-time': delivery({ state: 'delivered', attempt_count: 0 }),
    'delivery/failed-window': delivery({ state: 'failed', attempt_count: 48, last_error: 'retry_window_expired', last_http_status: 503 }),
    'delivery/cancelled': delivery({ state: 'cancelled', attempt_count: 1 }),
    'delivery/failed-free-text': delivery({ state: 'failed', last_error: 'not a code' }),
    'delivery/paused-send': delivery({ state: 'retry_wait', send_paused: 1 }),
    'delivery/paused-forced': delivery({}, { ...env, FORCE_SEND_PAUSED: 'true' }),
    'delivery/paused-blocked': delivery({ state: 'retry_wait', attempt_count: 1, last_error: 'http_401', last_http_status: 401, blocked_reason: 'http_404', blocked_until: iso(HOUR) }),
    'delivery/recheck-due': delivery({ state: 'retry_wait', attempt_count: 1, last_error: 'http_401', last_http_status: 401, blocked_reason: 'http_404', blocked_until: iso(-HOUR) }),
    'start/queued-again': await start({ ...target, send_paused: 1 }, { MAINTENANCE_MODE: 'true' }, { event_id: '6f1f4c1e-3b9a-4f55-9d0e-0a1b2c3d4e5f' }),
    'start/maintenance': await start(target, { MAINTENANCE_MODE: 'true' }),
    'start/send-paused': await start(target, { FORCE_SEND_PAUSED: 'true' }),
    'start/settings-paused': await start({ ...target, send_paused: 1 }),
    'start/no-endpoint': await start({ ...target, mode: 'archive' }),
    'start/endpoint-paused': await start({ ...target, paused: 1 }),
    'start/endpoint-blocked': await start({ ...target, blocked_reason: 'http_401' }),
  }
}

test('every Ops answer for the synthetic states is byte for byte the golden one', async () => {
  const actual = await cases()
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`)
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
  assert.deepEqual(Object.keys(actual), Object.keys(golden))
  for (const [name, value] of Object.entries(actual)) assert.equal(JSON.stringify(value), JSON.stringify(golden[name]), name)
})

// Rollout (the apps and the dashboard deploy separately): the dashboards deployed before the move validate every
// answer against the hand-written schema with validate.mjs. Every answer above passes it, so this Mail Hero and such a
// dashboard work together; and the answers are the earlier Mail Hero's bytes, so that Mail Hero and a new dashboard do
// too (the dashboard's tests read every fixture and each app's real answers back).
test('every golden answer passes the checks of the dashboards deployed before the move', async () => {
  for (const [name, value] of Object.entries(await cases())) {
    assert.deepEqual(validate(LEGACY, DEFS[name.split('/')[0]], value), [], name)
  }
})
