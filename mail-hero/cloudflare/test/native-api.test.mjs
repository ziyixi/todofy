import test from 'node:test'
import assert from 'node:assert/strict'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createAccessVerifier } from '@ziyixi/edge-auth'
import { handleAPI } from '../src/native/api.ts'
import { idOf, query, quote, reasonOf, sendMessage } from './owner-api.mjs'
import { endpoint, environment, message, session, withRevision } from './native-env.mjs'
import { MAX_ZONE_SEGMENTS, zoneSegments } from '../src/native/api-delivery-stats.ts'
import { ROUTE_BLOCK_COOLDOWN_MS, ROUTE_BLOCK_GRACE_MS, ROUTE_BLOCK_MAX_RECHECKS, buildPayload, runJob, runMaintenance, syntheticTestMail } from '../src/native/pipeline.ts'
import { alertSignals, alertSnapshot } from '../src/native/alerts.ts'
import { authenticate, csrfResponse, decryptCredential, encryptCredential, HttpError, privateResponse, requireCSRF } from '../src/native/security.ts'

/** SummarizeDeliveryAttempts' query for a range, a granularity (`hour`, `day`) and a zone. */
function summarize(from, to, granularity, timeZone) {
  return `/deliveries/-/attempts:summarize${query({ start_time: from, end_time: to, granularity, time_zone: timeZone })}`
}
/** ListDeliveries' query for the dashboard's drill-down: an AttemptResult and an attempt range. */
function drilldown(result, from, to, extra = '') {
  return `/deliveries${query({ filter: `attempt_result = ${result} AND attempt_finish_time >= ${quote(from)} AND attempt_finish_time < ${quote(to)}${extra}` })}`
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
  const [from, to] = ['2026-09-25T00:00:00.000Z', '2026-09-27T00:00:00.000Z']
  const chart = await api('GET', summarize(from, to, 'day'))
  assert.equal(chart.status, 200, JSON.stringify(chart.data))
  assert.deepEqual(chart.data.totals, { succeeded_count: 1, retried_count: 2, failed_count: 2, unknown_count: 1 })
  assert.deepEqual(chart.data.buckets.map(({ start_time, counts }) => ({ start_time, ...counts })), [
    { start_time: '2026-09-25T00:00:00Z', succeeded_count: 1, retried_count: 2, failed_count: 1, unknown_count: 1 },
    { start_time: '2026-09-26T00:00:00Z', failed_count: 1 },
  ])
  const ids = result => (result.data.deliveries ?? []).map(item => idOf(item.name))
  const retryList = await api('GET', drilldown('RETRIED', from, to))
  assert.equal(retryList.status, 200, JSON.stringify(retryList.data))
  assert.deepEqual(ids(retryList), [retriedThenDelivered], 'each event once, however many of its attempts matched')
  assert.deepEqual(ids(await api('GET', drilldown('FAILED', from, to))).sort(), [rejected, exhausted].sort())
  const beforeFailed = await api('GET', drilldown('FAILED', from, '2026-09-26T00:00:00.000Z'))
  assert.deepEqual(ids(beforeFailed), [rejected], 'the end is exclusive for drill-down too')
  assert.equal(ids(await api('GET', drilldown('RETRIED', from, to, ' AND state = RETRY_WAIT'))).length, 0)
  const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT DISTINCT a.event_id FROM delivery_attempts a
    WHERE a.finished_at>=? AND a.finished_at<? AND a.outcome='retryable'`)
    .bind('2026-09-25T00:00:00.000Z', '2026-09-27T00:00:00.000Z').all()
  assert.ok(plan.results.some(row => row.detail.includes('delivery_attempts_finished_idx')), JSON.stringify(plan.results))
  const beforeBoundary = await api('GET', summarize('2026-09-25T12:00:00.000Z', '2026-09-26T00:00:00.000Z', 'hour'))
  assert.equal(beforeBoundary.data.buckets.length, 12)
  assert.deepEqual(beforeBoundary.data.totals, { succeeded_count: 1, failed_count: 1, unknown_count: 1 })
  const empty = await api('GET', summarize('2026-09-24T00:00:00.000Z', '2026-09-25T00:00:00.000Z'))
  assert.deepEqual(empty.data.totals, {})
  assert.equal(empty.data.buckets.length, 1)
  for (const invalid of [
    summarize('2026-09-25T00:00:00', '2026-09-26T00:00:00Z'),
    summarize('2026-09-26T00:00:00Z', '2026-09-25T00:00:00Z'),
    summarize('2026-01-01T00:00:00Z', '2026-09-25T00:00:00Z'),
    summarize('2026-09-01T00:00:00Z', '2026-09-25T00:00:00Z', 'hour'),
    summarize('2026-02-30T00:00:00Z', '2026-03-02T00:00:00Z'),
    summarize('2026-09-25T00:00:00Z', '2026-09-26T00:00:00Z', 'week'),
    drilldown('INVALID', from, to),
    drilldown('CONSTRUCTOR', from, to),
    drilldown('failed', from, to),
    `/deliveries${query({ filter: 'attempt_result = FAILED' })}`,
    // DeliveryAttempt.Outcome names, the old field name and UNSPECIFIED are not results.
    drilldown('DELIVERED', from, to),
    drilldown('REJECTED', from, to),
    drilldown('UNSPECIFIED', from, to),
    `/deliveries${query({ filter: `attempt_outcome = FAILED AND attempt_finish_time >= ${quote(from)} AND attempt_finish_time < ${quote(to)}` })}`,
    `/deliveries${query({ filter: `attempt_finish_time >= ${quote(from)} AND attempt_finish_time < ${quote(to)}` })}`,
    `/deliveries${query({ filter: 'state = PAUSED' })}`,
    `/deliveries${query({ filter: 'state = FAILED OR state = PENDING' })}`,
    `/deliveries${query({ filter: '"text"' })}`,
  ]) assert.equal((await api('GET', invalid)).status, 400, invalid)
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
/**
 * SummarizeDeliveryAttempts through handleAPI. A 200's `text` is its answer in the shape these tests compare (ISO
 * instants with milliseconds, the four counts by outcome with zeros), `raw` the wire answer itself.
 */
async function statsText(env, { from, to, bucket, tz }) {
  const response = await handleAPI(new Request(`http://127.0.0.1:8787/api/v2${summarize(from, to, bucket, tz)}`), env)
  const text = await response.text()
  if (response.status !== 200) return { status: response.status, text }
  const raw = JSON.parse(text), iso = value => new Date(value).toISOString()
  const counts = value => ({ succeeded: value?.succeeded_count ?? 0, retried: value?.retried_count ?? 0, failed: value?.failed_count ?? 0, unknown: value?.unknown_count ?? 0 })
  return { status: 200, raw, text: JSON.stringify({ from: iso(raw.start_time), to: iso(raw.end_time), bucket: raw.granularity, time_zone: raw.time_zone,
    totals: counts(raw.totals), buckets: raw.buckets.map(item => ({ start: iso(item.start_time), end: iso(item.end_time), ...counts(item.counts) })) }) }
}
const statsQuery = (from, to, extra = {}) => ({ from, to, ...extra })
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

test('UTC buckets (the default zone) count exactly what the former UTC-only implementation counted, with their ends', async () => {
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
    const legacy = JSON.parse(await legacyStatsText(env, from, to, bucket))
    for (const tz of [undefined, 'UTC']) {
      const current = await statsText(env, statsQuery(from, to, { bucket, tz }))
      assert.equal(current.status, 200, current.text)
      const utc = JSON.parse(current.text)
      assert.equal(utc.time_zone, 'UTC', 'an empty time_zone is UTC')
      assert.equal(utc.bucket, bucket)
      assert.deepEqual(utc.totals, legacy.totals)
      assert.deepEqual(utc.buckets.map(({ end, ...rest }) => rest), legacy.buckets, `${from} ${bucket}`)
      assert.deepEqual(utc.buckets.map(item => item.end), [...legacy.buckets.slice(1).map(item => item.start), to])
    }
  }
  const unspecified = JSON.parse((await statsText(env, statsQuery(cases[0][0], cases[0][1]))).text)
  assert.equal(unspecified.bucket, 'day', 'the granularity defaults to day')
  assert.deepEqual(unspecified.buckets.map(({ end, ...rest }) => rest), JSON.parse(await legacyStatsText(env, cases[0][0], cases[0][1], 'day')).buckets)
  // The limits: 90 days (7 for hours) and the two hours of the largest DST change.
  for (const [from, to, bucket, status] of [
    ['2026-09-01T00:00:00.000Z', '2026-11-30T02:00:00.000Z', 'day', 200], ['2026-09-01T00:00:00.000Z', '2026-11-30T02:00:00.001Z', 'day', 400],
    ['2026-01-05T00:00:00.000Z', '2026-01-12T02:00:00.000Z', 'hour', 200], ['2026-01-05T00:00:00.000Z', '2026-01-12T02:00:00.001Z', 'hour', 400],
  ]) {
    const result = await statsText(env, statsQuery(from, to, { bucket }))
    assert.equal(result.status, status, `${from} ${to} ${bucket}`)
    if (status === 400) assert.equal(reasonOf(JSON.parse(result.text)), 'INVALID_TIME_RANGE')
  }
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
  for (const tz of ['Mars/Olympus_Mons', 'Not/AZone', 'America/Los Angeles', 'America/Los_Angeles;DROP', '../../etc/localtime', 'A'.repeat(65), 'America/Los_Angeles\u0000', '+03:00', 'Etc/Unknown']) {
    const result = await statsText(env, statsQuery('2026-09-25T00:00:00.000Z', '2026-09-26T00:00:00.000Z', { tz }))
    assert.equal(result.status, 400, JSON.stringify(tz))
    const error = JSON.parse(result.text)
    assert.equal(reasonOf(error), 'INVALID_TIME_ZONE')
    assert.equal(error.error.details.find(detail => detail['@type'].endsWith('LocalizedMessage')).message, '时区无效')
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
  const drill = await api('GET', drilldown('SUCCEEDED', from, to))
  assert.deepEqual([drill.status, drill.data.deliveries.length], [200, 3])
  const over = new Date(Date.parse(to) + 1).toISOString()
  assert.equal((await statsText(env, statsQuery(from, over, { tz: 'Antarctica/Troll' }))).status, 400)
  const long = await api('GET', drilldown('SUCCEEDED', from, over))
  assert.deepEqual([long.status, reasonOf(long.data)], [400, 'INVALID_TIME_RANGE'])
  for (const [start, end] of [['yesterday', to], [from, '2026-09-26T00:00:00'], [from, '2026-02-30T00:00:00Z']]) {
    const malformed = await api('GET', drilldown('SUCCEEDED', start, end))
    assert.deepEqual([malformed.status, reasonOf(malformed.data)], [400, 'BAD_REQUEST'], `${start} ${end}`)
  }
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
  try {
    result = await statsText(env, ninety)
    fewerRowsCalls = intlCalls
    await attemptsAt(env, api, Array.from({ length: 200 }, (_, index) => [new Date(Date.parse('2026-10-01T00:00:00.000Z') + index * 997_000).toISOString()]))
    intlCalls = 0
    await statsText(env, ninety)
    assert.equal(intlCalls, fewerRowsCalls, 'Intl work does not grow with rows')
    // No wall-clock bound here: host time depends on the machine's load. The coordinator answers this read (30 s of
    // CPU); its CPU is measured in workerd by test/cpu/owner-api-cpu.test.mjs. This test holds the work to counts.
  } finally { Intl.DateTimeFormat.prototype.formatToParts = original }
  assert.equal(result.status, 200, result.text)
  const stats = JSON.parse(result.text)
  assert.equal(stats.buckets.length, 90)
  const fallBack = stats.buckets.find(item => item.start === '2026-11-01T07:00:00.000Z')
  assert.equal(Date.parse(fallBack.end) - Date.parse(fallBack.start), 25 * 3_600_000)
  assert.deepEqual(stats.totals, { succeeded: 15, retried: 15, failed: 0, unknown: 0 })
  assert.ok(fewerRowsCalls < 500, `Intl calls ${fewerRowsCalls}`)
  // One statement per request, its bound parameters fixed by the zone's segments, not by the rows or the days.
  assert.deepEqual(captured.map(item => item.args.length), [5, 5])
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

test('native API defaults are archive with the storage-v1 retention, maintenance blocks mutations only', async () => {
  const env = environment(), api = await session(env)
  const initial = await api('GET', '/settings')
  assert.equal(initial.status, 200)
  assert.deepEqual(initial.data, { name: 'settings', receive_address: 'hero@in.example.org', mode: 'archive', raw_retention_days: 7,
    content_retention_days: 30, ledger_retention_days: 180, resolved_retention_days: 60, lifecycle_policy_version: 1,
    logical_limit_bytes: 5368709120, etag: '1' })
  assert.equal(initial.response.headers.get('Cache-Control'), 'no-store')
  env.MAINTENANCE_MODE = 'true'
  const refused = await api('PATCH', '/settings?update_mask=mode', { etag: '1', mode: 'archive' })
  assert.equal(refused.status, 503)
  assert.equal(reasonOf(refused.data), 'MAINTENANCE')
  assert.equal((await api('GET', '/settings')).status, 200)
  const overview = await api('GET', '/overview')
  assert.ok(overview.data.warnings.some(item => item.includes('维护模式')))
})

// Test tokens are signed with jose (an independent implementation) and verified by
// packages/edge-auth through an injected certs fetch, as Access publishes them.
const ACCESS_KID = 'synthetic-kid'
async function accessKeys(options = {}) {
  const keys = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: ACCESS_KID, alg: 'RS256', use: 'sig' }
  const certs = []
  const fetch = options.fetch ?? (async (url, init) => { certs.push({ url, init }); return Response.json({ keys: [jwk] }) })
  return { privateKey: keys.privateKey, jwk, certs, verifier: createAccessVerifier({ fetch }) }
}
function accessToken(env, privateKey, claims = {}, header = { alg: 'RS256', kid: ACCESS_KID }) {
  let jwt = new SignJWT({ email: env.ACCESS_OWNER, ...claims }).setProtectedHeader(header).setIssuer(env.ACCESS_ISSUER)
    .setAudience(env.ACCESS_AUDIENCE).setExpirationTime('10m')
  if (!('iat' in claims)) jwt = jwt.setIssuedAt()
  if (!('sub' in claims)) jwt = jwt.setSubject('synthetic-user')
  return jwt.sign(privateKey)
}
const unauthorized = message => error => error instanceof HttpError && error.status === 401 && error.code === 'unauthorized' && error.message === message

test('Access validates signature, audience and owner; fake header and remote dev bypass fail closed', async () => {
  const env = environment(); delete env.DEV_AUTH_BYPASS
  const keys = await accessKeys()
  const request = async claims => new Request('https://mail.example.org/api/v2/settings', { headers: { 'Cf-Access-Jwt-Assertion': await accessToken(env, keys.privateKey, claims) } })
  assert.equal(await authenticate(await request(), env, keys.verifier), env.ACCESS_OWNER)
  // The certs come from the pinned issuer as a string URL, with redirects refused.
  assert.equal(keys.certs[0].url, 'https://test.cloudflareaccess.com/cdn-cgi/access/certs')
  assert.equal(keys.certs[0].init.redirect, 'manual')
  await assert.rejects(authenticate(await request(), { ...env, ACCESS_AUDIENCE: 'different-audience' }, keys.verifier), error => error instanceof HttpError && error.status === 401)
  await assert.rejects(authenticate(await request({ email: 'other@example.org' }), env, keys.verifier), error => error instanceof HttpError && error.status === 401)
  await assert.rejects(authenticate(new Request('https://mail.example.org', { headers: { 'Cf-Access-Jwt-Assertion': 'present-but-not-a-token' } }), env, keys.verifier), /Access/)
  env.DEV_AUTH_BYPASS = 'true'
  const refused = await handleAPI(new Request('https://mail.example.org/api/v2/settings'), env)
  assert.equal(refused.status, 503)
  assert.equal(reasonOf(await refused.json()), 'ACCESS_NOT_CONFIGURED')
})

test('Access keeps every jose check and the stricter shared ones: RS256 only, kid, iat, nbf, sub, key size', async () => {
  const env = environment(); delete env.DEV_AUTH_BYPASS
  const keys = await accessKeys(), now = Math.floor(Date.now() / 1000)
  const check = token => authenticate(new Request('https://mail.example.org/api/v2/settings', { headers: { 'Cf-Access-Jwt-Assertion': token } }), env, keys.verifier)
  const invalid = unauthorized('Access 登录无效或无权限')
  assert.equal(await check(await accessToken(env, keys.privateKey, { nbf: now })), 'owner@example.org')
  const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
  const claims = { iss: env.ACCESS_ISSUER, aud: env.ACCESS_AUDIENCE, sub: 'synthetic-user', email: env.ACCESS_OWNER, iat: now, exp: now + 600 }
  // Algorithm confusion: an HMAC token keyed with the public JWK, and alg "none".
  const hmacSecret = new TextEncoder().encode(JSON.stringify(keys.jwk))
  const small = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const smallKid = 'small-kid', smallJwk = { ...(await crypto.subtle.exportKey('jwk', small.publicKey)), kid: smallKid, alg: 'RS256', use: 'sig' }
  const smallVerifier = createAccessVerifier({ fetch: async () => Response.json({ keys: [smallJwk] }) })
  const raw = async (header, privateKey) => {
    const head = b64(header) + '.' + b64(claims)
    return head + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(head))).toString('base64url')
  }
  assert.equal(await check(await raw({ alg: 'RS256', kid: ACCESS_KID }, keys.privateKey)), 'owner@example.org')
  const smallToken = await raw({ alg: 'RS256', kid: smallKid }, small.privateKey)
  for (const token of [
    await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: ACCESS_KID }).sign(hmacSecret),
    `${b64({ alg: 'none', kid: ACCESS_KID })}.${b64(claims)}.`,
    await accessToken(env, keys.privateKey, {}, { alg: 'RS256' }),                         // no kid
    await accessToken(env, keys.privateKey, {}, { alg: 'RS256', kid: 'unknown-kid' }),
    await raw({ alg: 'RS256', kid: ACCESS_KID, crit: ['exp'], exp: 1 }, keys.privateKey),   // jose also refused unknown crit
    await accessToken(env, keys.privateKey, { iat: now + 3600 }),                           // jose accepted a future iat
    await accessToken(env, keys.privateKey, { nbf: now + 5 }),                              // 0 s nbf leeway, as before
    await accessToken(env, keys.privateKey, { sub: '' }),                                   // jose accepted an empty sub
    await accessToken(env, keys.privateKey, { sub: undefined }),
    await new SignJWT({ email: env.ACCESS_OWNER }).setProtectedHeader({ alg: 'RS256', kid: ACCESS_KID }).setIssuer(env.ACCESS_ISSUER)
      .setAudience(env.ACCESS_AUDIENCE).setSubject('synthetic-user').setExpirationTime('10m').sign(keys.privateKey),  // no iat
  ]) await assert.rejects(check(token), invalid)
  await assert.rejects(authenticate(new Request('https://mail.example.org/', { headers: { 'Cf-Access-Jwt-Assertion': smallToken } }), env, smallVerifier), invalid)
})

test('Access token source, certs failures and dev bypass keep their former statuses and messages', async () => {
  const env = environment(); delete env.DEV_AUTH_BYPASS
  const keys = await accessKeys(), token = await accessToken(env, keys.privateKey)
  const at = (headers, url = 'https://mail.example.org/api/v2/settings') => authenticate(new Request(url, { headers }), env, keys.verifier)
  const missing = unauthorized('需要通过 Cloudflare Access 登录')
  await assert.rejects(at({}), missing)
  await assert.rejects(at({ 'Cf-Access-Jwt-Assertion': '', Cookie: `CF_Authorization=${token}` }), missing)  // an empty header is missing
  await assert.rejects(at({ 'Cf-Access-Jwt-Assertion': 'x'.repeat(16001) }), missing)
  assert.equal(await at({ Cookie: `other=1; CF_Authorization=${token}; CF_Authorization=stale` }), 'owner@example.org')  // first cookie
  await assert.rejects(at({ Cookie: `CF_Authorization=stale; CF_Authorization=${token}` }), unauthorized('Access 登录无效或无权限'))
  for (const fetch of [async () => new Response('down', { status: 500 }), async () => { throw new Error('offline') },
    async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.org/certs' } }), async () => new Response('not json')]) {
    const failing = createAccessVerifier({ fetch })
    await assert.rejects(authenticate(new Request('https://mail.example.org/', { headers: { 'Cf-Access-Jwt-Assertion': token } }), env, failing), unauthorized('Access 登录无效或无权限'))
  }
  const local = { ...env, DEV_AUTH_BYPASS: 'true' }
  for (const url of ['http://127.0.0.1:8787/api/v2/settings', 'http://localhost/', 'http://[::1]:8787/'])
    assert.equal(await authenticate(new Request(url), local, keys.verifier), 'local-development')
  for (const [url, headers] of [['https://localhost/', {}], ['http://mail.example.org/', {}], ['http://127.0.0.1:8787/', { 'CF-Ray': 'abc' }], ['http://app.localhost/', {}]]) {
    await assert.rejects(authenticate(new Request(url, { headers }), local, keys.verifier),
      error => error instanceof HttpError && error.status === 503 && error.code === 'invalid_auth_configuration' && error.message === '开发认证模式仅限本机')
  }
  for (const bad of [{ ACCESS_ISSUER: 'https://evil.example.org' }, { ACCESS_AUDIENCE: '' }, { ACCESS_OWNER_ALIASES: 'a'.repeat(2049) }]) {
    await assert.rejects(authenticate(new Request('https://mail.example.org/', { headers: { 'Cf-Access-Jwt-Assertion': token } }), { ...env, ...bad }, keys.verifier),
      error => error instanceof HttpError && error.status === 503 && error.code === 'access_not_configured' && error.message === '请先配置 Cloudflare Access')
  }
})

test('Access aliases preserve one canonical owner and still require every JWT check', async () => {
  const env = environment(); delete env.DEV_AUTH_BYPASS
  env.ACCESS_OWNER = '  owner@example.org  '
  env.ACCESS_OWNER_ALIASES = ' github-owner@example.org, , second-login@example.org '
  const keys = await accessKeys(), unrelatedKeys = await generateKeyPair('RS256')
  const sign = (email, overrides = {}, privateKey = keys.privateKey) => new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: ACCESS_KID }).setIssuer(overrides.issuer ?? env.ACCESS_ISSUER)
    .setAudience(overrides.audience ?? env.ACCESS_AUDIENCE).setSubject('synthetic-user')
    .setIssuedAt().setExpirationTime(overrides.expires ?? '10m').sign(privateKey)
  const request = token => new Request('https://mail.example.org/api/v2/settings', { headers: { 'Cf-Access-Jwt-Assertion': token } })
  const authenticateToken = token => authenticate(request(token), env, keys.verifier)
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
  const keys = await accessKeys()
  const token = await accessToken(env, keys.privateKey, { email: 'github-owner@example.org' })
  const request = new Request('https://mail.example.org/api/v2/settings', { headers: { 'Cf-Access-Jwt-Assertion': token } })
  for (const owner of [undefined, '', '   ']) {
    await assert.rejects(authenticate(request, { ...env, ACCESS_OWNER: owner }, keys.verifier), error => error instanceof HttpError && error.status === 503)
  }
  const aliases = Array.from({ length: 9 }, (_, i) => `login-${i}@example.org`).join(',')
  await assert.rejects(authenticate(request, { ...env, ACCESS_OWNER_ALIASES: aliases }, keys.verifier), error => error instanceof HttpError && error.status === 503)
})

// Minted by the pre-package security.ts (CREDENTIAL_KEY "12"×32, fixed nonce, exp 2100-01-01):
// a CSRF cookie already in a browser must keep working across the deploy.
const GOLDEN_CSRF = 'eyJraW5kIjoiY3NyZiIsIm93bmVyIjoib3duZXJAZXhhbXBsZS5vcmciLCJub25jZSI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCIsImV4cCI6NDEwMjQ0NDgwMH0.PsGfEZ9TSpWDV8E-z6nAAyrq-o4zpAHqNtPXxFlC1ac'

test('an existing mail_hero_csrf token and a real Access login pass handleAPI through the default verifier', async t => {
  const env = environment(); delete env.DEV_AUTH_BYPASS
  env.ACCESS_ISSUER = 'https://golden.cloudflareaccess.com'  // own issuer: the module verifier caches per issuer
  const keys = await accessKeys(), certs = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { certs.push({ url, init }); return Response.json({ keys: [keys.jwk] }) })
  const jwt = await accessToken(env, keys.privateKey)
  const write = (csrf, origin = 'https://mail.example.org') => handleAPI(new Request('https://mail.example.org/api/v2/settings?update_mask=send_paused', {
    method: 'PATCH', body: JSON.stringify({ etag: '1', send_paused: true }),
    headers: { 'Cf-Access-Jwt-Assertion': jwt, Origin: origin, Cookie: `mail_hero_csrf=${csrf}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } }), env)
  const accepted = await write(GOLDEN_CSRF)
  assert.equal(accepted.status, 200, await accepted.clone().text())
  assert.deepEqual(certs.map(call => [call.url, call.init.redirect]), [['https://golden.cloudflareaccess.com/cdn-cgi/access/certs', 'manual']])
  // A browser serialises Origin in lowercase; the shared check compares case-insensitively (SPEC §4 #27).
  assert.equal((await write(GOLDEN_CSRF, 'https://attacker.example')).status, 403)
  const tampered = GOLDEN_CSRF.slice(0, -1) + (GOLDEN_CSRF.endsWith('c') ? 'd' : 'c')
  const rejected = await write(tampered)
  assert.equal(rejected.status, 403)
  const status = (await rejected.json()).error
  assert.deepEqual([status.code, status.status, reasonOf({ error: status })], [403, 'PERMISSION_DENIED', 'CSRF_FAILED'])
  assert.equal(status.details.find(detail => detail['@type'].endsWith('LocalizedMessage')).message, '请刷新页面后再试')
  // A token minted for the local-development principal is not the Access owner's.
  const local = await csrfResponse(new Request('http://127.0.0.1:8787/api/csrf'), env, 'local-development')
  assert.equal((await write((await local.json()).token)).status, 403)
})

test('CSRF issue keeps the cookie, token claims and key failures of the former code', async () => {
  const env = environment()
  const issued = await csrfResponse(new Request('https://mail.example.org/api/csrf'), env, 'owner@example.org')
  const { token } = await issued.json()
  assert.equal(issued.headers.get('Set-Cookie'), `mail_hero_csrf=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure`)
  assert.equal(issued.headers.get('Cache-Control'), 'no-store')
  assert.equal(issued.headers.get('X-Content-Type-Options'), 'nosniff')
  const claims = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())
  assert.deepEqual(Object.keys(claims), ['kind', 'owner', 'nonce', 'exp'])
  assert.equal(claims.kind, 'csrf'); assert.equal(claims.owner, 'owner@example.org')
  assert.match(claims.nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.ok(Math.abs(claims.exp - (Math.floor(Date.now() / 1000) + 43200)) <= 1)
  const plain = await csrfResponse(new Request('http://127.0.0.1:8787/api/csrf'), env, 'owner@example.org')
  assert.equal(plain.headers.get('Set-Cookie').endsWith('Max-Age=43200'), true)
  const request = value => new Request('https://mail.example.org/api/v2/settings', { method: 'PATCH',
    headers: { Origin: 'https://mail.example.org', Cookie: `mail_hero_csrf=${value}; mail_hero_csrf=other`, 'X-CSRF-Token': value } })
  await requireCSRF(request(token), env, 'owner@example.org')
  await requireCSRF(request(GOLDEN_CSRF), env, 'owner@example.org')
  // A missing CREDENTIAL_KEY: issuing fails as an internal error (503 service_unavailable), verifying as csrf_failed.
  const noKey = { ...env, CREDENTIAL_KEY: '' }
  await assert.rejects(csrfResponse(new Request('https://mail.example.org/api/csrf'), noKey, 'owner@example.org'), error => !(error instanceof HttpError))
  const csrfFailed = error => error instanceof HttpError && error.status === 403 && error.code === 'csrf_failed'
  await assert.rejects(requireCSRF(request(GOLDEN_CSRF), noKey, 'owner@example.org'), csrfFailed)
  const unavailable = await handleAPI(new Request('http://127.0.0.1:8787/api/csrf'), noKey)
  assert.equal(unavailable.status, 503)
  assert.equal(reasonOf(await unavailable.json()), 'NOT_CONFIGURED')
})

test('private responses carry the exact Mail Hero headers, including the sandboxed-HTML frame-src', async () => {
  const response = privateResponse(new Response('x', { status: 201, headers: { 'Cache-Control': 'public, max-age=60', 'X-Other': 'kept' } }))
  assert.equal(response.status, 201)
  assert.equal(await response.text(), 'x')
  assert.deepEqual(Object.fromEntries(response.headers), {
    'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'content-type': 'text/plain;charset=UTF-8', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'x-other': 'kept',
  })
})

test('mutations require matching signed owner CSRF cookie and same-origin request', async () => {
  const env = environment(), api = await session(env)
  const write = headers => api('PATCH', '/settings?update_mask=send_paused', { etag: '1', send_paused: true }, headers)
  assert.equal((await write({ Origin: 'https://attacker.example' })).status, 403)
  assert.equal((await write({ 'X-CSRF-Token': 'forged' })).status, 403)
  // The CSRF check runs before the body is read: a refused request never reaches the settings.
  assert.equal((await api('GET', '/settings')).data.etag, '1')
  assert.equal((await write()).status, 200)
})

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

test('retention shortening requires an owner/etag/policy-bound preview and never deletes content in the settings request', async () => {
  const env = environment(), api = await session(env)
  const id = await message(env, { received_at: new Date(Date.now() - 60 * 86400000).toISOString() })
  await env.DB.prepare('UPDATE messages SET retention_policy_version=NULL WHERE id=?').bind(id).run()
  const policy = 'raw_retention_days=3&content_retention_days=20&ledger_retention_days=180&resolved_retention_days=60'
  const update = (body, extra = '') => api('PATCH', `/settings?update_mask=raw_retention_days,content_retention_days${extra}`, { etag: '1', raw_retention_days: 3, content_retention_days: 20, ...body })
  const unconfirmed = await update({})
  assert.deepEqual([unconfirmed.status, reasonOf(unconfirmed.data)], [400, 'RETENTION_CONFIRMATION_REQUIRED'])
  const preview = await api('GET', `/settings:previewRetentionPolicy?${policy}&apply_existing=true`)
  assert.equal(preview.status, 200, JSON.stringify(preview.data))
  assert.deepEqual([preview.data.etag, preview.data.historical_message_count, preview.data.candidate_count, preview.data.apply_existing], ['1', 1, 1, true])
  const token = encodeURIComponent(preview.data.confirmation_token)
  // The token binds the exact policy: another period, or a save without the history it previewed, is refused.
  assert.equal(reasonOf((await update({ content_retention_days: 25 }, `&retention_confirmation=${token}&apply_existing=true`)).data), 'RETENTION_CONFIRMATION_REQUIRED')
  assert.equal(reasonOf((await update({}, `&retention_confirmation=${token}`)).data), 'RETENTION_CONFIRMATION_REQUIRED')
  const saved = await update({}, `&retention_confirmation=${token}&apply_existing=true`)
  assert.equal(saved.status, 200, JSON.stringify(saved.data))
  assert.deepEqual([saved.data.raw_retention_days, saved.data.content_retention_days, saved.data.etag, saved.data.lifecycle_policy_version], [3, 20, '2', 2])
  assert.equal((await env.DB.prepare('SELECT content_deleted_at FROM messages WHERE id=?').bind(id).first()).content_deleted_at, null)
  assert.equal((await api('PATCH', '/settings?update_mask=send_paused', { etag: '1', send_paused: true })).status, 409)
  // Lengthening and switching a period off need no preview; a mask naming a field without a value clears it.
  const forever = await api('PATCH', '/settings?update_mask=raw_retention_days,content_retention_days,resolved_retention_days', { etag: '2' })
  assert.equal(forever.status, 200, JSON.stringify(forever.data))
  assert.deepEqual([forever.data.raw_retention_days, forever.data.content_retention_days, forever.data.resolved_retention_days], [undefined, undefined, undefined])
  const rule = await api('PATCH', '/settings?update_mask=raw_retention_days,content_retention_days', { etag: '3', raw_retention_days: 40, content_retention_days: 30 })
  assert.deepEqual([rule.status, reasonOf(rule.data), rule.data.error.details[0].metadata], [400, 'INVALID_RETENTION_POLICY', { rule: 'raw_after_content' }])
  for (const mask of ['', '*']) assert.equal((await api('PATCH', `/settings?update_mask=${mask}`, { etag: '3', send_paused: true })).status, 400, mask)
  // The ledger period is never cleared (Settings.ledger_retention_days): no value, or 0, breaks its days rule.
  for (const body of [{ etag: '3' }, { etag: '3', ledger_retention_days: 0 }]) {
    const ledger = await api('PATCH', '/settings?update_mask=ledger_retention_days', body)
    assert.deepEqual([ledger.status, reasonOf(ledger.data), ledger.data.error.details[0].metadata], [400, 'INVALID_RETENTION_POLICY', { rule: 'days_range' }])
  }
  assert.equal((await api('GET', '/settings')).data.ledger_retention_days, 180)
  assert.equal((await api('GET', '/settings:previewRetentionPolicy?ledger_retention_days=30')).status, 400)
})

test('message API searches Chinese body, exposes safe details and optimistic read state', async () => {
  const env = environment(), api = await session(env), id = await message(env)
  const other = await message(env, { subject: 'Other', text: 'unrelated body' })
  const list = await api('GET', `/messages${query({ filter: quote('独立服务') })}`)
  assert.equal(list.status, 200, JSON.stringify(list.data))
  assert.deepEqual(list.data.messages.map(item => item.name), [`messages/${id}`])
  assert.equal(list.data.messages[0].snippet, '独立服务测试正文')
  assert.equal(list.data.messages[0].delivery_state, 'unarranged')
  const filtered = await api('GET', `/messages${query({ filter: `parse_state = READY AND delivery_state = UNARRANGED AND has_attachments = false` })}`)
  assert.deepEqual(filtered.data.messages.map(item => idOf(item.name)).sort(), [id, other].sort())
  for (const filter of ['"a" "b"', 'parse_state = ready', 'parse_state = READY parse_state = FAILED', 'has_attachments = yes', 'receive_time >= 2026', 'subject = x', 'a OR b', '-x',
    'receive_time >= "yesterday"', 'receive_time <= "2026-09-25T00:00:00"', 'receive_time >= "2026-02-30T00:00:00Z"']) {
    const refused = await api('GET', `/messages${query({ filter })}`)
    // Outside the filter's grammar, a malformed time included (the IDL): BAD_REQUEST, not INVALID_TIME_RANGE.
    assert.deepEqual([refused.status, reasonOf(refused.data)], [400, 'BAD_REQUEST'], filter)
  }
  const window = await api('GET', `/messages${query({ filter: 'receive_time >= "2000-01-01T00:00:00+08:00" receive_time <= "2999-01-01T00:00:00Z"' })}`)
  assert.equal(window.status, 200, JSON.stringify(window.data))
  assert.equal((await api('GET', `/messages${query({ filter: quote('x'.repeat(201)) })}`)).status, 400, 'a search over 200 characters')
  const detail = await api('GET', `/messages/${id}`)
  assert.equal(detail.data.subject, '中文合成邮件')
  assert.equal(detail.data.raw_download_uri, `/api/v2/messages/${id}/raw`)
  const content = await api('GET', `/messages/${id}/content`)
  assert.equal(content.data.text, '独立服务测试正文')
  assert.equal(JSON.stringify([detail.data, content.data]).includes('parsed/'), false)
  const read = await api('PATCH', `/messages/${id}?update_mask=read`, { read: true, etag: detail.data.etag })
  assert.equal(read.status, 200, JSON.stringify(read.data))
  assert.equal(read.data.read, true)
  assert.ok(read.data.read_time)
  const stale = await api('PATCH', `/messages/${id}?update_mask=read`, { read: false, etag: detail.data.etag })
  assert.deepEqual([stale.status, reasonOf(stale.data)], [409, 'ETAG_MISMATCH'])
  assert.equal((await api('PATCH', `/messages/${crypto.randomUUID()}?update_mask=read`, { read: false, etag: '1' })).status, 404)
  const raw = await api('GET', `/messages/${id}/raw`)
  assert.equal(raw.status, 200)
  assert.match(raw.response.headers.get('Content-Disposition'), /^attachment/)
  assert.equal(raw.response.headers.get('Cache-Control'), 'no-store')
  assert.equal(raw.response.headers.get('X-Content-Type-Options'), 'nosniff')
  // Pages: a page token belongs to its filter.
  const first = await api('GET', `/messages?page_size=1`)
  assert.equal(first.data.messages.length, 1)
  assert.ok(first.data.next_page_token)
  const second = await api('GET', `/messages?page_size=1&page_token=${first.data.next_page_token}`)
  assert.equal(second.data.messages.length, 1)
  assert.notEqual(second.data.messages[0].name, first.data.messages[0].name)
  assert.equal(second.data.next_page_token, undefined)
  assert.equal((await api('GET', `/messages${query({ page_size: 1, page_token: first.data.next_page_token, filter: quote('x') })}`)).status, 400)
  assert.equal((await api('GET', '/messages?page_size=-1')).status, 400)
})

test('send/retry/cancel/resend use durable IDs and deleted content cannot be sent or downloaded', async () => {
  const env = environment(), api = await session(env), target = await endpoint(api), id = await message(env)
  const action = crypto.randomUUID()
  const first = await sendMessage(api, id, target.id, action)
  assert.equal(first.status, 200, JSON.stringify(first.data))
  const duplicate = await sendMessage(api, id, target.id, action)
  assert.equal(duplicate.data.delivery.name, first.data.delivery.name)
  const eventID = idOf(first.data.delivery.name)
  assert.equal(first.data.delivery.message, `messages/${id}`)
  assert.equal(first.data.delivery.endpoint, `endpoints/${target.id}`)
  const frozen = await api('GET', `/deliveries/${eventID}/payload`)
  const payload = JSON.parse(frozen.data.body)
  assert.equal(payload.event_id, eventID)
  assert.equal(payload.type, 'mail.received.v1')
  assert.equal(frozen.data.body, await (await env.MAIL_STORE.get(`payload/${eventID}.json`)).text(), 'the exact frozen bytes')
  assert.match(frozen.data.body_sha256, /^[0-9a-f]{64}$/)
  const second = await sendMessage(api, id, target.id)
  assert.deepEqual([second.status, reasonOf(second.data)], [409, 'DELIVERY_EXISTS'])
  const cancel = await api('POST', `/deliveries/${eventID}:cancel`, { request_id: crypto.randomUUID() })
  assert.equal(cancel.status, 200)
  assert.equal(cancel.data.state, 'cancelled')
  const again = await api('POST', `/deliveries/${eventID}:cancel`, { request_id: crypto.randomUUID() })
  assert.deepEqual([again.status, reasonOf(again.data)], [400, 'NOT_CANCELLABLE'])
  const retry = await api('POST', `/deliveries/${eventID}:retry`, { request_id: crypto.randomUUID() })
  assert.equal(retry.status, 200)
  assert.equal(retry.data.name, `deliveries/${eventID}`)
  assert.deepEqual([retry.data.state, retry.data.retry_mode], ['pending', 'once'])
  assert.equal(JSON.parse((await api('GET', `/deliveries/${eventID}/payload`)).data.body).event_id, eventID)
  const currentMessage = (await api('GET', `/messages/${id}`)).data
  const stale = await api('POST', `/deliveries/${eventID}:resend`, { request_id: crypto.randomUUID(), endpoint: `endpoints/${target.id}`, message_etag: String(Number(currentMessage.etag) + 1) })
  assert.deepEqual([stale.status, reasonOf(stale.data)], [409, 'ETAG_MISMATCH'])
  const resend = await api('POST', `/deliveries/${eventID}:resend`, { request_id: crypto.randomUUID(), endpoint: `endpoints/${target.id}`, message_etag: currentMessage.etag })
  assert.equal(resend.status, 200, JSON.stringify(resend.data))
  assert.notEqual(resend.data.name, `deliveries/${eventID}`)
  assert.equal(resend.data.generation, 2)
  assert.equal(resend.data.source_delivery, `deliveries/${eventID}`)
  const latest = (await api('GET', `/messages/${id}`)).data
  const deletion = await api('POST', `/messages/${id}:clearContent`, { request_id: crypto.randomUUID(), etag: latest.etag })
  assert.equal(deletion.status, 200, JSON.stringify(deletion.data))
  assert.ok(deletion.data.content_delete_time)
  assert.equal(deletion.data.raw_download_uri, undefined)
  const raw = await api('GET', `/messages/${id}/raw`)
  assert.deepEqual([raw.status, reasonOf(raw.data)], [410, 'CONTENT_DELETED'])
  const deletedSend = await sendMessage(api, id, target.id)
  assert.deepEqual([deletedSend.status, reasonOf(deletedSend.data)], [400, 'CONTENT_DELETED'])
  assert.equal((await api('GET', `/deliveries/${eventID}/payload`)).data.body, undefined)
  assert.deepEqual((await api('GET', `/messages/${id}/content`)).data, { name: `messages/${id}/content` })
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
  assert.equal(first.data.delivery, second.data.delivery)
  const eventID = idOf(first.data.delivery)
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

test('a lost action acknowledgement still resolves the original event after endpoint changes', async () => {
  const env = environment(), api = await session(env), target = await endpoint(api), id = await message(env), actionID = crypto.randomUUID()
  const first = await sendMessage(api, id, target.id, actionID)
  assert.equal(first.status, 200)
  // Model the commit/response boundary: the delivery exists, but the API's
  // separate action completion did not become visible to the caller.
  await env.DB.prepare('UPDATE ui_actions SET result_ref=NULL,http_status=NULL WHERE action_request_id=?').bind(actionID).run()
  assert.equal((await api('PATCH', `/endpoints/${target.id}?update_mask=uri`, { etag: target.etag, uri: 'https://consumer.example.org/hooks/v2' })).status, 200)
  const retry = await sendMessage(api, id, target.id, actionID)
  assert.equal(retry.status, 200)
  assert.equal(retry.data.delivery.name, first.data.delivery.name)
  assert.equal((await api('GET', '/deliveries')).data.deliveries.length, 1)
})

test('internal database failure does not echo errors or credentials to a browser', async () => {
  const env = environment(), api = await session(env)
  env.DB.prepare = () => { throw new Error('postgres://secret-user:secret-password@private-host') }
  const response = await api('GET', '/settings')
  assert.equal(response.status, 503)
  assert.equal(reasonOf(response.data), 'UNAVAILABLE')
  assert.equal(JSON.stringify(response.data).includes('secret'), false)
  // A bug is INTERNAL: never answered as a dependency the client may retry.
  // An answer the wire profile refuses to write (an int32 out of range) stands for a bug in the mapping.
  env.DB.prepare = () => ({ all: async () => ({ results: [{ version: 1, mode: 'archive', lifecycle_policy_version: 2 ** 40, ledger_retention_days: 180 }], meta: {} }) })
  const bug = await api('GET', '/settings')
  assert.deepEqual([bug.status, reasonOf(bug.data)], [500, 'INTERNAL'])
  assert.equal(JSON.stringify(bug.data).includes('secret'), false)
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

test('maintenance rejects every browser mutation route and reports effective pause truthfully', async () => {
  const env = environment(), api = await session(env)
  env.MAINTENANCE_MODE = 'true'
  for (const [method, path] of [['POST', '/endpoints'], ['PATCH', '/settings'], ['POST', `/messages/${crypto.randomUUID()}:clearContent`],
    ['POST', `/deliveries/${crypto.randomUUID()}:retry`], ['POST', `/endpoints/${crypto.randomUUID()}:test`], ['PATCH', `/messages/${crypto.randomUUID()}`]]) {
    const refused = await api(method, path, {})
    assert.deepEqual([refused.status, reasonOf(refused.data)], [503, 'MAINTENANCE'], path)
  }
  const settings = await api('GET', '/settings')
  assert.equal(settings.data.send_paused, undefined)
  assert.equal(settings.data.effective_send_paused, true)
  assert.equal(settings.data.maintenance_mode, true)
  const overview = await api('GET', '/overview')
  assert.ok(overview.data.warnings.some(item => item.includes('维护模式')))
  assert.equal(overview.data.warnings.some(item => item.includes('收信继续')), false)
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
  assert.equal((await api('POST', `/endpoints/${target.id}:unblock`, { etag: target.etag })).status, 409)
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
