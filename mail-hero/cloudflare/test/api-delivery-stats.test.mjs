import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAPI } from '../src/native/api.ts'
import { idOf, query, quote, reasonOf } from './owner-api.mjs'
import { endpoint, environment, message, session } from './native-env.mjs'
import { MAX_ZONE_SEGMENTS, zoneSegments } from '../src/native/api-delivery-stats.ts'
import { HttpError } from '../src/native/security.ts'

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
