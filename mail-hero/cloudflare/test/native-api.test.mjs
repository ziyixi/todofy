import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { generateKeyPair, SignJWT } from 'jose'
import { handleAPI } from '../src/native/api.ts'
import { MAX_ZONE_SEGMENTS, zoneSegments } from '../src/native/api-delivery-stats.ts'
import { ROUTE_BLOCK_COOLDOWN_MS, ROUTE_BLOCK_GRACE_MS, ROUTE_BLOCK_MAX_RECHECKS, runJob, runMaintenance } from '../src/native/pipeline.ts'
import { alertSignals, alertSnapshot } from '../src/native/alerts.ts'
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
  const jobs = [], wakes = []
  return {
    DB: new TestD1(), MAIL_STORE: new TestR2(), RECEIVE_ADDRESS: 'hero@in.example.org',
    CREDENTIAL_KEY: '12'.repeat(32), DEV_AUTH_BYPASS: 'true', WEBHOOK_ALLOWED_HOSTS: 'consumer.example.org,second.example.org',
    ACCESS_ISSUER: 'https://test.cloudflareaccess.com', ACCESS_AUDIENCE: 'test-audience', ACCESS_OWNER: 'owner@example.org',
    jobs, wakes, COORDINATOR: { idFromName(name) { assert.equal(name, 'inbox-v1'); return name }, get() { return { async fetch(url, init) {
      if (new URL(url).pathname === '/mutation/begin') return Response.json({id: crypto.randomUUID()})
      if (new URL(url).pathname === '/wake') wakes.push(Date.now())
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

test('delivery dashboard uses immutable attempt outcomes, default UTC windows and distinct-event drill-down', async () => {
  const env = environment(), api = await session(env), target = await endpoint(api)
  const real = await message(env), synthetic = await message(env)
  await env.DB.prepare("UPDATE messages SET origin='synthetic_test' WHERE id=?").bind(synthetic).run()
  async function delivery(messageID, generation, state = 'delivered') {
    const id = crypto.randomUUID()
    await env.DB.prepare(`INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,payload_sha256,state,next_attempt_at,created_at)
      VALUES(?,?,?,?,'synthetic-hash',?,'2026-09-25T00:00:00.000Z','2026-09-25T00:00:00.000Z')`)
      .bind(id, messageID, target.current_revision_id, generation, state).run()
    return id
  }
  async function attempt(eventID, no, outcome, finished) {
    await env.DB.prepare(`INSERT INTO delivery_attempts(id,event_id,attempt_no,started_at,finished_at,outcome)
      VALUES(?,?,?,?,?,?)`).bind(crypto.randomUUID(), eventID, no, finished, finished, outcome).run()
  }
  const retriedThenDelivered = await delivery(real, 1)
  await attempt(retriedThenDelivered, 1, 'retryable', '2026-09-25T10:00:00.000Z')
  await attempt(retriedThenDelivered, 2, 'retryable', '2026-09-25T11:00:00.000Z')
  await attempt(retriedThenDelivered, 3, 'delivered', '2026-09-25T12:00:00.000Z')
  const rejected = await delivery(real, 2, 'failed')
  await attempt(rejected, 1, 'rejected', '2026-09-25T13:00:00.000Z')
  const exhausted = await delivery(real, 3, 'failed')
  await attempt(exhausted, 1, 'failed', '2026-09-26T00:00:00.000Z')
  const unknown = await delivery(real, 4, 'retry_wait')
  await attempt(unknown, 1, 'interrupted', '2026-09-25T14:00:00.000Z')
  const notSent = await delivery(real, 5, 'retry_wait')
  await attempt(notSent, 1, 'not_sent', '2026-09-25T15:00:00.000Z')
  const testEvent = await delivery(synthetic, 1)
  await attempt(testEvent, 1, 'delivered', '2026-09-25T16:00:00.000Z')
  const period = 'from=2026-09-25T00%3A00%3A00.000Z&to=2026-09-27T00%3A00%3A00.000Z'
  const chart = await api(`/delivery-stats?${period}&bucket=day`)
  assert.equal(chart.status, 200)
  assert.deepEqual(chart.data.totals, { succeeded: 1, retried: 2, failed: 2, unknown: 1 })
  assert.deepEqual(chart.data.buckets.map(({ start, succeeded, retried, failed, unknown }) => ({ start, succeeded, retried, failed, unknown })), [
    { start: '2026-09-25T00:00:00.000Z', succeeded: 1, retried: 2, failed: 1, unknown: 1 },
    { start: '2026-09-26T00:00:00.000Z', succeeded: 0, retried: 0, failed: 1, unknown: 0 },
  ])
  const retryList = await api(`/deliveries?${period}&attempt_outcome=retried`)
  assert.equal(retryList.status, 200)
  assert.equal(retryList.data.count_semantics, 'distinct_delivery_events')
  assert.deepEqual(retryList.data.items.map(item => item.event_id), [retriedThenDelivered])
  assert.deepEqual((await api(`/deliveries?${period}&attempt_outcome=failed`)).data.items.map(item => item.event_id).sort(), [rejected, exhausted].sort())
  const beforeFailed = await api('/deliveries?attempt_outcome=failed&from=2026-09-25T00%3A00%3A00.000Z&to=2026-09-26T00%3A00%3A00.000Z')
  assert.deepEqual(beforeFailed.data.items.map(item => item.event_id), [rejected], 'to is exclusive for drill-down too')
  assert.equal((await api(`/deliveries?${period}&attempt_outcome=retried&status=retry_wait`)).data.items.length, 0)
  const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT DISTINCT a.event_id FROM delivery_attempts a
    WHERE a.finished_at>=? AND a.finished_at<? AND a.outcome='retryable'`)
    .bind('2026-09-25T00:00:00.000Z', '2026-09-27T00:00:00.000Z').all()
  assert.ok(plan.results.some(row => row.detail.includes('delivery_attempts_finished_idx')), JSON.stringify(plan.results))
  const beforeBoundary = await api(`/delivery-stats?from=2026-09-25T12%3A00%3A00.000Z&to=2026-09-26T00%3A00%3A00.000Z&bucket=hour`)
  assert.equal(beforeBoundary.data.buckets.length, 12)
  assert.deepEqual(beforeBoundary.data.totals, { succeeded: 1, retried: 0, failed: 1, unknown: 1 })
  const empty = await api('/delivery-stats?from=2026-09-24T00%3A00%3A00.000Z&to=2026-09-25T00%3A00%3A00.000Z')
  assert.deepEqual(empty.data.totals, { succeeded: 0, retried: 0, failed: 0, unknown: 0 })
  assert.equal(empty.data.buckets.length, 1)
  for (const invalid of [
    '/delivery-stats?from=2026-09-25T00:00:00&to=2026-09-26T00:00:00Z',
    '/delivery-stats?from=2026-09-26T00:00:00Z&to=2026-09-25T00:00:00Z',
    '/delivery-stats?from=2026-01-01T00:00:00Z&to=2026-09-25T00:00:00Z',
    '/delivery-stats?from=2026-09-01T00:00:00Z&to=2026-09-25T00:00:00Z&bucket=hour',
    '/delivery-stats?from=2026-02-30T00:00:00Z&to=2026-03-02T00:00:00Z',
    `/deliveries?${period}&attempt_outcome=invalid`,
    `/deliveries?${period}&attempt_outcome=constructor`,
    '/deliveries?attempt_outcome=failed',
  ]) assert.equal((await api(invalid)).status, 400, invalid)
})

// One real-mail event per attempt, so each finished_at is counted exactly once.
async function attemptsAt(env, api, list) {
  const target = await endpoint(api), messageID = await message(env)
  for (const [index, [finished, outcome = 'delivered']] of list.entries()) {
    const eventID = crypto.randomUUID()
    await env.DB.prepare(`INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,payload_sha256,state,next_attempt_at,created_at)
      VALUES(?,?,?,?,'synthetic-hash','delivered',?,?)`).bind(eventID, messageID, target.current_revision_id, index + 1, finished, finished).run()
    await env.DB.prepare('INSERT INTO delivery_attempts(id,event_id,attempt_no,started_at,finished_at,outcome) VALUES(?,?,1,?,?,?)')
      .bind(crypto.randomUUID(), eventID, finished, finished, outcome).run()
  }
  return messageID
}
async function statsText(env, query) {
  const response = await handleAPI(new Request(`http://127.0.0.1:8787/api/v1/delivery-stats?${query}`), env)
  return { status: response.status, text: await response.text() }
}
const statsQuery = (from, to, extra = {}) => new URLSearchParams({ from, to, ...extra }).toString()
const counted = ({ start, end, succeeded, retried, failed, unknown }) => ({ start, end, succeeded, retried, failed, unknown })
// Frozen copy of the UTC-only implementation that predates tz support.
async function legacyStatsText(env, from, to, bucket) {
  const step = bucket === 'hour' ? 3_600_000 : 86_400_000, prefixLength = bucket === 'hour' ? 13 : 10
  const grouped = (await env.DB.prepare(`SELECT substr(a.finished_at,1,${prefixLength}) bucket,
    sum(a.outcome='delivered') succeeded, sum(a.outcome='retryable') retried,
    sum(a.outcome IN('rejected','failed')) failed, sum(a.outcome='interrupted') unknown
    FROM delivery_attempts a JOIN deliveries d ON d.event_id=a.event_id JOIN messages m ON m.id=d.message_id
    WHERE a.finished_at>=? AND a.finished_at<? AND m.origin='cloudflare'
      AND a.outcome IN('delivered','retryable','rejected','failed','interrupted')
    GROUP BY bucket ORDER BY bucket`).bind(from, to).all()).results
  const byBucket = new Map(grouped.map(row => [row.bucket, { succeeded: Number(row.succeeded), retried: Number(row.retried), failed: Number(row.failed), unknown: Number(row.unknown) }]))
  const totals = { succeeded: 0, retried: 0, failed: 0, unknown: 0 }, buckets = []
  for (let start = Math.floor(Date.parse(from) / step) * step; start < Date.parse(to); start += step) {
    const iso = new Date(start).toISOString(), counts = byBucket.get(iso.slice(0, prefixLength)) ?? { succeeded: 0, retried: 0, failed: 0, unknown: 0 }
    buckets.push({ start: iso, ...counts })
    for (const field of ['succeeded', 'retried', 'failed', 'unknown']) totals[field] += counts[field]
  }
  return JSON.stringify({ from, to, bucket, totals, buckets })
}

test('delivery stats without tz stay byte-identical to the former UTC response; tz=UTC only adds end and time_zone', async () => {
  const env = environment(), api = await session(env)
  await attemptsAt(env, api, [
    ['2026-10-30T13:45:10.499Z', 'retryable'], ['2026-10-30T23:59:59.999Z'], ['2026-10-31T00:00:00.000Z', 'rejected'],
    ['2026-10-31T22:30:00.000Z', 'interrupted'], ['2026-11-01T08:30:00.000Z'], ['2026-11-01T09:30:00.000Z', 'failed'],
    ['2026-11-01T10:59:59.999Z', 'retryable'], ['2026-11-02T04:59:59.999Z'], ['2026-11-02T05:00:00.000Z'], ['2026-11-01T12:00:00.000Z', 'not_sent'],
  ])
  const synthetic = await message(env)
  await env.DB.prepare("UPDATE messages SET origin='synthetic_test' WHERE id=?").bind(synthetic).run()
  const cases = [
    ['2026-10-30T00:00:00.000Z', '2026-11-03T00:00:00.000Z', 'day'],
    ['2026-10-30T13:45:10.500Z', '2026-11-02T05:00:00.000Z', 'day'],
    ['2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'hour'],
    ['2026-10-31T22:30:00.000Z', '2026-11-01T11:15:00.000Z', 'hour'],
    ['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', 'day'],
  ]
  for (const [from, to, bucket] of cases) {
    const current = await statsText(env, statsQuery(from, to, { bucket }))
    assert.equal(current.status, 200)
    assert.equal(current.text, await legacyStatsText(env, from, to, bucket), `${from} ${bucket}`)
    const utc = JSON.parse((await statsText(env, statsQuery(from, to, { bucket, tz: 'UTC' }))).text), legacy = JSON.parse(current.text)
    assert.equal(utc.time_zone, 'UTC')
    assert.deepEqual(utc.totals, legacy.totals)
    assert.deepEqual(utc.buckets.map(({ end, ...rest }) => rest), legacy.buckets)
    assert.deepEqual(utc.buckets.map(item => item.end), [...legacy.buckets.slice(1).map(item => item.start), to])
  }
  assert.equal((await statsText(env, statsQuery(cases[0][0], cases[0][1]))).text, await legacyStatsText(env, cases[0][0], cases[0][1], 'day'), 'bucket defaults to day')
  // Without tz the former limits stay exact: no DST slack.
  for (const [from, to, bucket, status] of [
    ['2026-09-01T00:00:00.000Z', '2026-11-30T00:00:00.000Z', 'day', 200], ['2026-09-01T00:00:00.000Z', '2026-11-30T00:00:00.001Z', 'day', 400],
    ['2026-01-05T00:00:00.000Z', '2026-01-12T00:00:00.000Z', 'hour', 200], ['2026-01-05T00:00:00.000Z', '2026-01-12T00:00:00.001Z', 'hour', 400],
  ]) assert.equal((await statsText(env, statsQuery(from, to, { bucket }))).status, status, `${from} ${to} ${bucket}`)
})

test('America/Los_Angeles day buckets follow the 25-hour and 23-hour local days', async () => {
  const env = environment(), api = await session(env)
  await attemptsAt(env, api, [
    ['2026-11-01T06:59:59.999Z'], ['2026-11-01T07:00:00.000Z'], ['2026-11-01T08:30:00.000Z'], ['2026-11-01T09:30:00.000Z', 'failed'],
    ['2026-11-02T07:30:00.000Z', 'retryable'], ['2026-11-02T08:00:00.000Z'],
    ['2026-03-08T07:59:59.999Z'], ['2026-03-08T08:00:00.000Z'], ['2026-03-08T10:00:00.000Z', 'interrupted'],
    ['2026-03-09T06:59:59.999Z'], ['2026-03-09T07:00:00.000Z'],
  ])
  const zone = { bucket: 'day', tz: 'America/Los_Angeles' }
  const fall = JSON.parse((await statsText(env, statsQuery('2026-10-31T07:00:00.000Z', '2026-11-03T08:00:00.000Z', zone))).text)
  assert.equal(fall.time_zone, 'America/Los_Angeles')
  assert.deepEqual(fall.totals, { succeeded: 4, retried: 1, failed: 1, unknown: 0 })
  assert.deepEqual(fall.buckets.map(counted), [
    { start: '2026-10-31T07:00:00.000Z', end: '2026-11-01T07:00:00.000Z', succeeded: 1, retried: 0, failed: 0, unknown: 0 },
    { start: '2026-11-01T07:00:00.000Z', end: '2026-11-02T08:00:00.000Z', succeeded: 2, retried: 1, failed: 1, unknown: 0 },
    { start: '2026-11-02T08:00:00.000Z', end: '2026-11-03T08:00:00.000Z', succeeded: 1, retried: 0, failed: 0, unknown: 0 },
  ])
  const spring = JSON.parse((await statsText(env, statsQuery('2026-03-07T08:00:00.000Z', '2026-03-10T07:00:00.000Z', zone))).text)
  assert.deepEqual(spring.buckets.map(counted), [
    { start: '2026-03-07T08:00:00.000Z', end: '2026-03-08T08:00:00.000Z', succeeded: 1, retried: 0, failed: 0, unknown: 0 },
    { start: '2026-03-08T08:00:00.000Z', end: '2026-03-09T07:00:00.000Z', succeeded: 2, retried: 0, failed: 0, unknown: 1 },
    { start: '2026-03-09T07:00:00.000Z', end: '2026-03-10T07:00:00.000Z', succeeded: 1, retried: 0, failed: 0, unknown: 0 },
  ])
  // A range starting mid-day still begins at that local midnight; the last bucket ends at `to`.
  const partial = JSON.parse((await statsText(env, statsQuery('2026-11-01T12:00:00.000Z', '2026-11-02T12:00:00.000Z', zone))).text)
  assert.deepEqual(partial.buckets.map(item => [item.start, item.end, item.succeeded + item.retried + item.failed]), [
    ['2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z', 1], ['2026-11-02T08:00:00.000Z', '2026-11-02T12:00:00.000Z', 1],
  ])
})

test('hour buckets keep the repeated fall-back hour as two local 01:00 buckets and skip the spring-forward hour', async () => {
  const env = environment(), api = await session(env)
  await attemptsAt(env, api, [['2026-11-01T08:30:00.000Z'], ['2026-11-01T08:59:59.999Z'], ['2026-11-01T09:00:00.000Z', 'retryable'], ['2026-11-01T09:30:00.000Z'], ['2026-03-08T10:00:00.000Z']])
  const localHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23' })
  const fall = JSON.parse((await statsText(env, statsQuery('2026-11-01T06:00:00.000Z', '2026-11-01T12:00:00.000Z', { bucket: 'hour', tz: 'America/Los_Angeles' }))).text)
  assert.deepEqual(fall.buckets.map(item => item.start), ['06', '07', '08', '09', '10', '11'].map(hour => `2026-11-01T${hour}:00:00.000Z`))
  assert.deepEqual(fall.buckets.map(item => localHour.format(new Date(item.start))), ['23', '00', '01', '01', '02', '03'])
  assert.deepEqual(fall.buckets.map(item => item.succeeded + item.retried), [0, 0, 2, 2, 0, 0])
  assert.equal(fall.buckets.at(-1).end, '2026-11-01T12:00:00.000Z')
  const spring = JSON.parse((await statsText(env, statsQuery('2026-03-08T08:00:00.000Z', '2026-03-08T12:00:00.000Z', { bucket: 'hour', tz: 'America/Los_Angeles' }))).text)
  assert.deepEqual(spring.buckets.map(item => localHour.format(new Date(item.start))), ['00', '01', '03', '04'])
  assert.deepEqual(spring.buckets.map(item => item.succeeded), [0, 0, 1, 0])
})

test('half- and quarter-hour zones align hour buckets at :30 and :15 UTC; a 30-minute DST change realigns local hours', async () => {
  const env = environment(), api = await session(env)
  await attemptsAt(env, api, [['2026-09-25T00:14:59.999Z'], ['2026-09-25T00:15:00.000Z'], ['2026-09-25T00:29:59.999Z'], ['2026-09-25T00:30:00.000Z']])
  const hours = tz => statsText(env, statsQuery('2026-09-25T00:00:00.000Z', '2026-09-25T03:00:00.000Z', { bucket: 'hour', tz })).then(result => JSON.parse(result.text))
  const kolkata = await hours('Asia/Kolkata')
  assert.deepEqual(kolkata.buckets.map(item => [item.start, item.end, item.succeeded]), [
    ['2026-09-24T23:30:00.000Z', '2026-09-25T00:30:00.000Z', 3], ['2026-09-25T00:30:00.000Z', '2026-09-25T01:30:00.000Z', 1],
    ['2026-09-25T01:30:00.000Z', '2026-09-25T02:30:00.000Z', 0], ['2026-09-25T02:30:00.000Z', '2026-09-25T03:00:00.000Z', 0],
  ])
  const kathmandu = await hours('Asia/Kathmandu')
  assert.deepEqual(kathmandu.buckets.map(item => [item.start, item.end, item.succeeded]), [
    ['2026-09-24T23:15:00.000Z', '2026-09-25T00:15:00.000Z', 1], ['2026-09-25T00:15:00.000Z', '2026-09-25T01:15:00.000Z', 3],
    ['2026-09-25T01:15:00.000Z', '2026-09-25T02:15:00.000Z', 0], ['2026-09-25T02:15:00.000Z', '2026-09-25T03:00:00.000Z', 0],
  ])
  const day = JSON.parse((await statsText(env, statsQuery('2026-09-24T18:30:00.000Z', '2026-09-25T18:30:00.000Z', { tz: 'Asia/Kolkata' }))).text)
  assert.deepEqual(day.buckets.map(counted), [{ start: '2026-09-24T18:30:00.000Z', end: '2026-09-25T18:30:00.000Z', succeeded: 4, retried: 0, failed: 0, unknown: 0 }])
  // Lord Howe falls back 30 minutes (02:00 +11 -> 01:30 +10:30): the half hour
  // after the change is its own bucket and later buckets realign to local :00.
  await attemptsAt(env, api, [['2026-04-04T14:59:59.999Z'], ['2026-04-04T15:00:00.000Z'], ['2026-04-04T15:29:59.999Z'], ['2026-04-04T15:30:00.000Z']])
  const lordHowe = JSON.parse((await statsText(env, statsQuery('2026-04-04T13:00:00.000Z', '2026-04-04T17:00:00.000Z', { bucket: 'hour', tz: 'Australia/Lord_Howe' }))).text)
  assert.deepEqual(lordHowe.buckets.map(item => [item.start.slice(11, 16), item.end.slice(11, 16), item.succeeded]), [
    ['13:00', '14:00', 0], ['14:00', '15:00', 1], ['15:00', '15:30', 2], ['15:30', '16:30', 1], ['16:30', '17:00', 0],
  ])
})

test('an invalid time zone is refused before any query', async () => {
  const env = environment()
  let prepared = 0
  const prepare = env.DB.prepare.bind(env.DB)
  env.DB.prepare = sql => { prepared++; return prepare(sql) }
  for (const tz of ['', 'Mars/Olympus_Mons', 'Not/AZone', 'America/Los Angeles', 'America/Los_Angeles;DROP', '../../etc/localtime', 'A'.repeat(65), 'America/Los_Angeles\u0000', '+03:00', 'Etc/Unknown']) {
    const result = await statsText(env, statsQuery('2026-09-25T00:00:00.000Z', '2026-09-26T00:00:00.000Z', { tz }))
    assert.equal(result.status, 400, JSON.stringify(tz))
    assert.deepEqual([JSON.parse(result.text).error.code, JSON.parse(result.text).error.message], ['invalid_time_zone', '时区无效'])
  }
  assert.equal(prepared, 0)
})

test('90 local days across the 2-hour Antarctica/Troll change are accepted, and drill down', async () => {
  const env = environment(), api = await session(env)
  await attemptsAt(env, api, [['2026-08-14T21:59:59.999Z'], ['2026-08-14T22:00:00.000Z'], ['2026-10-25T23:59:59.999Z'], ['2026-11-12T23:59:59.999Z'], ['2026-11-13T00:00:00.000Z']])
  // 2026-08-15 00:00 +02 to 2026-11-13 00:00 +00: 90 local days, 90 days and 2 hours of real time.
  const [from, to] = ['2026-08-14T22:00:00.000Z', '2026-11-13T00:00:00.000Z']
  const result = await statsText(env, statsQuery(from, to, { tz: 'Antarctica/Troll' }))
  assert.equal(result.status, 200, result.text)
  const stats = JSON.parse(result.text)
  assert.equal(stats.buckets.length, 90)
  assert.deepEqual([stats.buckets[0].start, stats.buckets.at(-1).end, stats.totals.succeeded], [from, to, 3])
  const change = stats.buckets.find(item => item.start === '2026-10-24T22:00:00.000Z')
  assert.deepEqual([change.end, change.succeeded], ['2026-10-26T00:00:00.000Z', 1])
  const drill = await api(`/deliveries?${new URLSearchParams({ attempt_outcome: 'succeeded', from, to })}`)
  assert.deepEqual([drill.status, drill.data.items.length], [200, 3])
  const over = new Date(Date.parse(to) + 1).toISOString()
  assert.equal((await statsText(env, statsQuery(from, over, { tz: 'Antarctica/Troll' }))).status, 400)
  assert.equal((await api(`/deliveries?${new URLSearchParams({ attempt_outcome: 'succeeded', from, to: over })}`)).status, 400)
})

test('local-time stats keep bound params, Intl calls and the range index bounded', async () => {
  const env = environment(), api = await session(env)
  const seeded = []
  for (let day = 0; day < 90; day += 3) seeded.push([new Date(Date.parse('2026-09-01T12:00:00.000Z') + day * 86_400_000).toISOString(), day % 2 ? 'retryable' : 'delivered'])
  await attemptsAt(env, api, seeded)
  const captured = []
  const prepare = env.DB.prepare.bind(env.DB)
  env.DB.prepare = sql => {
    const statement = prepare(sql), bind = statement.bind.bind(statement)
    statement.bind = (...args) => { if (sql.includes('strftime(')) captured.push({ sql, args }); return bind(...args) }
    return statement
  }
  // 90 local days across the fall-back are 90 days and one hour of real time.
  const ninety = statsQuery('2026-09-01T07:00:00.000Z', '2026-11-30T08:00:00.000Z', { tz: 'America/Los_Angeles' })
  const original = Intl.DateTimeFormat.prototype.formatToParts
  let intlCalls = 0
  Intl.DateTimeFormat.prototype.formatToParts = function (...args) { intlCalls++; return original.apply(this, args) }
  let result, fewerRowsCalls
  const elapsed = []
  try {
    result = await statsText(env, ninety)
    fewerRowsCalls = intlCalls
    await attemptsAt(env, api, Array.from({ length: 200 }, (_, index) => [new Date(Date.parse('2026-10-01T00:00:00.000Z') + index * 997_000).toISOString()]))
    intlCalls = 0
    await statsText(env, ninety)
    assert.equal(intlCalls, fewerRowsCalls, 'Intl work does not grow with rows')
    // Wall time per warm request, including node:sqlite, against the 10 ms Free CPU budget.
    for (let run = 0; run < 30; run++) {
      const started = performance.now()
      assert.equal((await statsText(env, ninety)).status, 200)
      elapsed.push(performance.now() - started)
    }
  } finally { Intl.DateTimeFormat.prototype.formatToParts = original }
  assert.equal(result.status, 200, result.text)
  const stats = JSON.parse(result.text)
  assert.equal(stats.buckets.length, 90)
  const fallBack = stats.buckets.find(item => item.start === '2026-11-01T07:00:00.000Z')
  assert.equal(Date.parse(fallBack.end) - Date.parse(fallBack.start), 25 * 3_600_000)
  assert.deepEqual(stats.totals, { succeeded: 15, retried: 15, failed: 0, unknown: 0 })
  assert.ok(fewerRowsCalls < 500, `Intl calls ${fewerRowsCalls}`)
  const median = elapsed.toSorted((a, b) => a - b)[15], sum = elapsed.reduce((a, b) => a + b, 0)
  assert.ok(median < 10 && sum < 300, `ninety-day requests: median ${median.toFixed(2)} ms, 30 runs ${sum.toFixed(1)} ms`)
  assert.ok(captured.length >= 32 && captured.every(item => item.args.length < 100), JSON.stringify(captured.map(item => item.args.length)))
  assert.deepEqual(captured[0].args, ['2026-09-01T07:00:00.000Z', '2026-11-30T08:00:00.000Z', '2026-11-01T09:00:00.000Z', '-420 minutes', '-480 minutes'])
  const plan = env.DB.sqlite.prepare(`EXPLAIN QUERY PLAN ${captured[0].sql}`).all(...captured[0].args)
  assert.ok(plan.some(row => row.detail.includes('delivery_attempts_finished_idx')), JSON.stringify(plan))
  // Seven local days of hour buckets that include the fall-back also use the slack.
  const worst = statsQuery('2026-10-28T07:00:00.000Z', '2026-11-04T08:00:00.000Z', { bucket: 'hour', tz: 'America/Los_Angeles' })
  assert.equal(JSON.parse((await statsText(env, worst)).text).buckets.length, 7 * 24 + 1)
  for (const [from, to, bucket] of [['2026-09-01T07:00:00.000Z', '2026-11-30T09:00:00.001Z', 'day'], ['2026-10-28T07:00:00.000Z', '2026-11-04T09:00:00.001Z', 'hour']]) {
    assert.equal((await statsText(env, statsQuery(from, to, { bucket, tz: 'America/Los_Angeles' }))).status, 400, `${from} ${to}`)
  }
  const flipping = { formatToParts: ms => [{ type: 'timeZoneName', value: Math.floor(ms / 86_400_000) % 2 ? 'GMT+01:00' : 'GMT' }] }
  assert.throws(() => zoneSegments(flipping, Date.parse('2026-09-01T00:00:00.000Z'), Date.parse('2026-09-30T00:00:00.000Z')), error => error instanceof HttpError && error.status === 400)
  const real = zoneSegments(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'longOffset' }), Date.parse('2026-03-01T00:00:00.000Z'), Date.parse('2026-11-30T00:00:00.000Z'))
  assert.deepEqual(real.starts.slice(1).map(ms => new Date(ms).toISOString()), ['2026-03-08T10:00:00.000Z', '2026-11-01T09:00:00.000Z'])
  assert.deepEqual(real.offsets, [-28800, -25200, -28800])
  assert.ok(real.starts.length <= MAX_ZONE_SEGMENTS)
  const fixed = value => zoneSegments({ formatToParts: () => [{ type: 'timeZoneName', value }] }, 0, 86_400_000).offsets
  assert.deepEqual(['GMT', 'GMT+00:00', 'GMT+05:45', 'GMT-07:52:58', 'GMT−07:00'].map(fixed), [[0], [0], [20700], [-28378], [-25200]])
})

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
    assert.equal(row.blocked_until, null)
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

// Problem 3: route-class rejections must not silently and permanently halt forwarding.
async function queued(env, api) {
  const target = await endpoint(api), id = await message(env)
  const sent = await api(`/messages/${id}/send`, 'POST', { endpoint_id: target.id, action_request_id: crypto.randomUUID() })
  assert.equal(sent.status, 201, JSON.stringify(sent.data))
  return { target, eventID: sent.data.event_id }
}
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
  assert.equal((await api(`/endpoints/${target.id}`)).data.blocked_until, blocked.revision.blocked_until)
  // New mail frozen onto the blocked revision waits for the same recheck.
  const later = await api(`/messages/${await message(env)}/send`, 'POST', { endpoint_id: target.id, action_request_id: crypto.randomUUID() })
  const waiting = await attempt(t, env, later.data.event_id, 204)
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
  assert.equal((await api(`/deliveries/${eventID}/retry`, 'POST', { action_request_id: crypto.randomUUID() })).status, 202)
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
  const changed = (await api(`/endpoints/${target.id}`, 'PATCH', { version: target.version, url: 'https://consumer.example.org/hooks/v2' })).data
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
  const listed = (await api('/endpoints')).data.items[0]
  assert.equal(listed.blocked_reason, 'http_401'); assert.equal(listed.blocked_until, null)
  assert.equal((await api(`/endpoints/${target.id}/unblock`, 'POST', { version: target.version })).status, 409)
  assert.equal((await api(`/endpoints/${crypto.randomUUID()}/unblock`, 'POST', { version: 1 })).status, 404)
  const before = env.wakes.length, actionID = crypto.randomUUID()
  const result = await api(`/endpoints/${target.id}/unblock`, 'POST', { version: changed.version, action_request_id: actionID })
  assert.equal(result.status, 200, JSON.stringify(result.data))
  assert.deepEqual(result.data, { affected_revisions: 2, version: changed.version + 1 })
  assert.equal(env.wakes.length, before + 1)
  const revisions = (await env.DB.prepare('SELECT blocked_reason,blocked_until FROM endpoint_revisions WHERE endpoint_id=?').bind(target.id).all()).results
  assert.deepEqual(revisions.map(row => ({ ...row })), [{ blocked_reason: null, blocked_until: null }, { blocked_reason: null, blocked_until: null }])
  for (const eventID of events) {
    const row = await deliveryRow(env, eventID)
    assert.equal(row.blocking_since, null); assert.ok(Date.parse(row.next_attempt_at) <= Date.now()); assert.equal(row.state, 'retry_wait')
  }
  const replay = await api(`/endpoints/${target.id}/unblock`, 'POST', { version: changed.version, action_request_id: actionID })
  assert.deepEqual(replay.data, result.data, 'a lost response replays the original result')
  assert.equal((await api(`/endpoints/${target.id}`)).data.version, changed.version + 1)
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
  const overview = await api('/overview')
  assert.equal(overview.status, 200)
  assert.deepEqual(overview.data.counts, { ...expected })
  assert.deepEqual(overview.data.counts, { messages: 2, pending: 0, failed: 2, delivered: 3, parse_failed: 1 })
})

test('owner unblock keeps the persistent backoff of events that no block was holding', async () => {
  const env = environment(), api = await session(env), { target, eventID } = await queued(env, api)
  const future = new Date(Date.now() + 5 * 3600_000).toISOString()
  await env.DB.prepare("UPDATE deliveries SET state='retry_wait',last_error='http_503',next_attempt_at=?,blocking_since=? WHERE event_id=?").bind(future, new Date().toISOString(), eventID).run()
  const current = (await api(`/endpoints/${target.id}`)).data
  const result = await api(`/endpoints/${target.id}/unblock`, 'POST', { version: current.version })
  assert.deepEqual(result.data, { affected_revisions: 0, version: current.version + 1 })
  const row = await deliveryRow(env, eventID)
  assert.equal(row.next_attempt_at, future); assert.equal(row.blocking_since, null)
})

test('an expired cooldown is sendable, so it is neither a paused delivery nor an active block', async () => {
  const env = environment(), api = await session(env), { target, eventID } = await queued(env, api)
  await env.DB.batch([env.DB.prepare("UPDATE app_settings SET mode='forward',current_endpoint_id=?").bind(target.id),
    env.DB.prepare("UPDATE deliveries SET state='retry_wait' WHERE event_id=?").bind(eventID)])
  for (const [until, blocked] of [[new Date(Date.now() + 3600_000).toISOString(), 1], ['2000-01-01T00:00:00.000Z', 0], [null, 1]]) {
    await env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_404',blocked_until=?").bind(until).run()
    assert.equal((await api(`/deliveries/${eventID}`)).data.delivery.effective_state, blocked ? 'paused' : 'retry_wait', String(until))
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
    const sent = await api(`/messages/${await message(env)}/send`, 'POST', { endpoint_id: auth.id, action_request_id: crypto.randomUUID() })
    held[name] = sent.data.event_id
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
  assert.equal((await api(`/endpoints/${target.id}`)).data.blocked_rechecks, 1)
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
  const listed = (await api(`/endpoints/${target.id}`)).data
  assert.equal(listed.blocked_rechecks, 8); assert.equal(listed.blocked_until, null); assert.equal(listed.blocked_reason, 'http_404')
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
  assert.equal((await api(`/endpoints/${target.id}`)).data.blocked_rechecks, 0)
  // Success never lifts a permanent block or its count: those need the owner.
  await env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_401',blocked_rechecks=2 WHERE id=?").bind(delivered.revision.id).run()
  const later = await api(`/messages/${await message(env)}/send`, 'POST', { endpoint_id: target.id, action_request_id: crypto.randomUUID() })
  const gated = await attempt(t, env, later.data.event_id, 204)
  assert.equal(gated.calls, 0); assert.equal(gated.revision.blocked_reason, 'http_401'); assert.equal(gated.revision.blocked_rechecks, 2)
})

test('owner unblock and credential rotation reset the recheck count of the blocks they clear', async t => {
  const env = environment(), api = await session(env), { target, eventID } = await queued(env, api)
  const revision = target.current_revision_id
  await env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_404',blocked_until=NULL,blocked_rechecks=8 WHERE id=?").bind(revision).run()
  const result = await api(`/endpoints/${target.id}/unblock`, 'POST', { version: target.version })
  assert.deepEqual(result.data, { affected_revisions: 1, version: target.version + 1 })
  assert.deepEqual({ ...await env.DB.prepare('SELECT blocked_reason,blocked_until,blocked_rechecks FROM endpoint_revisions WHERE id=?').bind(revision).first() },
    { blocked_reason: null, blocked_until: null, blocked_rechecks: 0 })
  // A still-missing route gets its grace again, then a fresh set of rechecks.
  const retried = await attempt(t, env, eventID, 404)
  assert.equal(retried.revision.blocked_reason, null); assert.equal(retried.outcome, 'retryable')
  await pastGrace(env, eventID)
  assert.equal((await attempt(t, env, eventID, 404)).revision.blocked_rechecks, 1)
  // Rotation clears auth-class blocks only, and with them their count; a URL change starts at zero.
  const changed = (await api(`/endpoints/${target.id}`, 'PATCH', { version: target.version + 1, url: 'https://consumer.example.org/hooks/v2' })).data
  assert.equal(changed.blocked_rechecks, 0)
  await env.DB.batch([
    env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_404',blocked_until=NULL,blocked_rechecks=8 WHERE id=?").bind(revision),
    env.DB.prepare("UPDATE endpoint_revisions SET blocked_reason='http_401',blocked_until=NULL,blocked_rechecks=3 WHERE id=?").bind(changed.current_revision_id),
  ])
  assert.equal((await api(`/endpoints/${target.id}/rotate-credential`, 'POST', { version: changed.version, credential: 'rotated-secret' })).status, 200)
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
    assert.equal((await api(`/deliveries/${eventID}/retry`, 'POST', { action_request_id: crypto.randomUUID() })).status, 202)
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
  assert.equal((await api(`/endpoints/${target.id}`)).data.blocked_rechecks, 0, 'an unblocked revision has used no rechecks')
  await pastGrace(env, eventID)
  const result = await attempt(t, env, eventID, 404)
  assert.equal(result.revision.blocked_rechecks, 1, 'a fresh episode'); assert.ok(result.revision.blocked_until)
  assert.equal(result.next, Date.parse(result.revision.blocked_until)); assert.equal(result.delivery.state, 'retry_wait')
  assert.equal((await api(`/endpoints/${target.id}`)).data.blocked_rechecks, 1)
})
