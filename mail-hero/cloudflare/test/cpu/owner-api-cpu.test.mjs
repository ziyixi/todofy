// mailhero.ui.v2: CPU of the owner API's heaviest requests inside workerd, against Workers Free's 10 ms per request,
// measured and calibrated by the shared meter (tools/workerd-cpu/workerd-cpu.mts). Every request goes through the real
// Worker: Access (a real RS256 JWT, verified by packages/edge-auth against certs the outbound service serves), the shared
// transcoder (proto/ts/http-transcoder.ts) and the handlers of src/native/api-v2.ts, with D1, R2 and the coordinator
// bound as in production; the coordinator runs as a second Worker (a copy of the bundle) so that its invocations are
// metered apart, as Cloudflare meters a Durable Object.
//
// The data is the worst a request reads: 60 messages with search text, one whose parsed record is the largest the
// content policy writes (a 1 MiB text, a 2 MiB HTML body, 105 attachments and 2,048 headers: about 4 MiB of JSON), a 1
// MiB raw message, a 2 MiB attachment, a delivery per message with the first one's frozen request at 1 MiB and 48
// attempts, and 2,000 attempts over seven days for the dashboard. Synthetic values only.
//
// The whole session runs in COLD_ISOLATES fresh isolate pairs (measureInIsolates): each request's first run is the
// median of three isolates' first runs of its path, each number divided by its isolate's speed (never below 1); the
// coordinator's numbers are divided by its Worker isolate's speed too. Milliseconds of the reference machine (an Apple
// M1 Max).
//
// Measured on the reference machine on 2026-10-02 (load average about 6 from other suites), medians of three isolates,
// first run / warm median, before (the same requests and data on the hand-written /api/v1 they replace, the same meter
// and machine) and after:
//
//   the isolate's first API request (the overview)        5.7        ->  7.6        (running the transcoder's paths once)
//   the overview                                           1.1 / 1.4  ->  2.5 / 1.8
//   50 messages with a search                              1.7 / 0.8  ->  5.1 / 1.8
//   a message, the largest record (was one request)        9.8 / 8.4  ->  GetMessage 1.1 / 0.8, GetMessageContent 0.5 / 0.5
//   50 deliveries                                          0.9 / 0.8  ->  2.8 / 1.4
//   a delivery with 48 attempts and a 1 MiB request        2.7 / 2.1  ->  GetDelivery 0.6 / 0.8, its attempts 2.3 / 1.3,
//     (was one request)                                                   GetDeliveryPayload 2.3 / 1.9
//   the dashboard, 7 days of hours in a zone              13.2 / 1.4  ->  0.8 / 0.5
//   settings, setup checks, targets, the raw download    at most 0.8  ->  at most 1.4
//   a settings update (under the write lease)              3.4 / 1.4  ->  4.9 / 1.7
//
// Since src/native/warmup.ts runs the codec path of the heaviest methods at startup (2026-10-02, four serial runs of
// `npm run test:cpu` before and after, plus eight runs of this file after): the isolate's first API request 7.1-8.2 ->
// 5.7-6.5, 50 messages with a search 4.7-5.1 -> 2.8-3.3 first, 50 deliveries 2.6-2.9 -> 2.0-2.2, a settings update
// 4.1-4.8 -> 3.1-4.0, the coordinator's slowest delegated read 17.8-19.4 -> 15.1-15.4; warm medians unchanged.
//
// The attachment download of the largest record found the attachment's key by reading the whole record in the Worker:
// 5.8 / 5.3 (first run / warm median, 2026-10-05, load average about 17). The coordinator answers it now, as the
// delegated reads: 0.5 / 0.4 in the Worker.
//
// The two reads that were over Free's 10 ms before (the largest parsed record: JSON.parse of 4 MiB and writing it
// again; an isolate's first time zone: ICU's zone data) are answered by the coordinator now (src/native/api.ts
// DELEGATED): its slowest answer took 15 ms of its 30 s (median 10; 18 without the warm-up). COLD_BOUND_MS is 9 ms: the
// first API request leaves about 3.5 ms of Free's 10 ms on the reference machine (about 2.4 without the warm-up, 4.3 on
// the hand-written API); FIRST_BOUND_MS and WARM_BOUND_MS hold every other request at about twice its measure.
import test from 'node:test'
import assert from 'node:assert/strict'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { COLD_ISOLATES, CPU_TEST_TIMEOUT_MS, FREE_CPU_MS, measureInIsolates, median } from '../../../../tools/workerd-cpu/workerd-cpu.mts'
import { bundle, ENV, migrate, startIsolate } from './isolate.mjs'
import { collectCoordinatorCpu } from './coordinator-samples.mjs'

const RUNS = 6
const MIB = 1024 * 1024
const ORIGIN = `https://${ENV.PUBLIC_HOST}`
const KID = 'synthetic-kid'
const MESSAGES = 60

const FIRST = "GetOverview, the isolate's first API request"
const CONTENT = 'GetMessageContent (the largest record)'
const ATTACHMENT = 'the attachment download (the largest record, its last attachment, 2 MiB)'
const STATS = 'SummarizeDeliveryAttempts (7 days of hours, America/Los_Angeles)'
/** The isolate's first API request (the median of COLD_ISOLATES isolates), in reference ms. */
const COLD_BOUND_MS = 0.9 * FREE_CPU_MS
/** Any other request's first run (the median of COLD_ISOLATES isolates), in reference ms. */
const FIRST_BOUND_MS = 0.7 * FREE_CPU_MS
/** A warm median (the median of COLD_ISOLATES isolates), in reference ms. */
const WARM_BOUND_MS = 0.35 * FREE_CPU_MS
/** The coordinator's slowest answer to a delegated read in any isolate, in reference ms (Free's limit: 30 s). */
const COORDINATOR_BOUND_MS = 1000

const ATTACHMENTS = 105
const LAST_ATTACHMENT_KEY = `parsed/synthetic/${ATTACHMENTS - 1}`

/** The largest parsed record (message.json) the content policy writes; synthetic. */
function largestParsed() {
  return JSON.stringify({
    subject: 'Synthetic quarterly report', text: '\u0001'.repeat(155_000) + 'y'.repeat(MIB - 155_000), html: '<p>' + 'z'.repeat(2 * MIB - 7) + '</p>',
    from: [{ address: 'sender@example.org', name: 'Synthetic sender' }], to: [{ address: 'inbox@mail.example.org', name: '' }], cc: [], reply_to: [],
    sent_at: null, rfc_message_id: '<synthetic@example.org>',
    headers: Array.from({ length: 2048 }, (_, i) => ({ key: `x-synthetic-${i}`, value: 'v'.repeat(100) })),
    // The last one is binary: Miniflare compresses a text/* answer on its way out, which is not the lookup measured.
    attachments: Array.from({ length: ATTACHMENTS }, (_, i) => ({ part_id: String(i + 1), filename: `f${i}.txt`,
      content_type: i === ATTACHMENTS - 1 ? 'application/octet-stream' : 'text/plain', size: 8, storage_status: 'stored', r2_key: `parsed/synthetic/${i}` })),
    needs_review: false, warnings: ['text_truncated'], text_truncated: true, original_text_bytes: 5_000_000, html_omitted: false,
    attachments_omitted_count: 0, content_policy_version: 'storage-v1',
  })
}

/** A fresh isolate pair with the data above, and `get`/`mutate` through the Worker with a real Access JWT. */
function start(script, outbound, keys) {
  const common = { modules: true, script, compatibilityDate: '2026-09-07', d1Databases: { DB: 'owner-cpu' }, r2Buckets: ['MAIL_STORE'],
    bindings: ENV, serviceBindings: { ASSETS: () => new Response('synthetic') }, outboundService: outbound }
  const workers = [
    { name: 'mail-hero', ...common, durableObjects: { COORDINATOR: { className: 'MailCoordinator', scriptName: 'mail-hero-coordinator', useSQLite: true } } },
    { name: 'mail-hero-coordinator', ...common, durableObjects: { COORDINATOR: { className: 'MailCoordinator', useSQLite: true } } },
  ]
  return startIsolate({ workers, prefix: 'mail-hero-owner-cpu-' }, ['mail-hero', 'mail-hero-coordinator'], async mf => {
    const db = await migrate(mf)
    const bucket = await mf.getR2Bucket('MAIL_STORE', 'mail-hero')
    const jwt = await new SignJWT({ email: ENV.ACCESS_OWNER }).setProtectedHeader({ alg: 'RS256', kid: KID }).setIssuer(ENV.ACCESS_ISSUER)
      .setAudience(ENV.ACCESS_AUDIENCE).setSubject('synthetic-user').setIssuedAt().setExpirationTime('30m').sign(keys.privateKey)
    // The data goes straight into D1 and R2: the Worker's first request is the measured one.
    const time = Date.now(), stamp = new Date(time).toISOString()
    const endpointID = crypto.randomUUID(), revisionID = crypto.randomUUID()
    await db.prepare(`INSERT INTO webhook_endpoints(id,label,current_revision_id,paused,rate_per_minute,created_at,updated_at) VALUES(?,?,?,0,60,?,?)`)
      .bind(endpointID, 'Synthetic consumer', revisionID, stamp, stamp).run()
    await db.prepare(`INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type,credential_ciphertext,credential_key_version,credential_key_id,timeout_ms,created_at)
      VALUES(?,?,1,'https://consumer.example.org/hooks/mail','bearer','v1.000000000000000000000000.00',1,?,2000,?)`).bind(revisionID, endpointID, crypto.randomUUID(), stamp).run()
    const ids = [], events = []
    for (let n = 0; n < MESSAGES; n++) {
      const id = crypto.randomUUID(), received = new Date(time - n * 60_000).toISOString(), large = n === 0
      const key = `parsed/${id}/synthetic/message.json`
      const content = large ? largestParsed() : JSON.stringify({ subject: `Synthetic ${n}`, text: 'synthetic body '.repeat(50), html: '', headers: [], attachments: [], to: [], from: [], sent_at: null, rfc_message_id: null, needs_review: false, warnings: [] })
      await bucket.put(key, content)
      await bucket.put(`raw/${id}.eml`, large ? 'x'.repeat(MIB) : 'Subject: synthetic\r\n\r\nbody')
      // The largest record's last attachment (the lookup reads past every other one), stored at the per-attachment cap.
      if (large) await bucket.put(LAST_ATTACHMENT_KEY, 'a'.repeat(2 * MIB))
      await db.prepare(`INSERT INTO messages(id,origin,received_at,last_received_at,envelope_from,envelope_recipient,raw_key,size_bytes,receive_mode,parse_state,parsed_key,parsed_size_bytes,content_bytes,subject,from_text,search_text,has_attachment)
        VALUES(?,'cloudflare',?,?,'sender@example.org','inbox@mail.example.org',?,1000,'archive','ready',?,?,?,?,'Synthetic sender',?,?)`)
        .bind(id, received, received, `raw/${id}.eml`, key, content.length, content.length, `Synthetic subject ${n}`, 'synthetic body '.repeat(50), large ? 1 : 0).run()
      await db.prepare('INSERT INTO message_search(message_id,chunk_no,body) VALUES(?,0,?)').bind(id, 'synthetic body '.repeat(1000)).run()
      const eventID = crypto.randomUUID(), payloadKey = `payload/${eventID}.json`
      await bucket.put(payloadKey, JSON.stringify({ type: 'mail.received.v1', text: large ? 'y'.repeat(MIB - 1000) : 'short' }))
      await db.prepare(`INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,payload_key,payload_sha256,state,next_attempt_at,created_at,attempt_count)
        VALUES(?,?,?,1,?,'synthetic','retry_wait',?,?,?)`).bind(eventID, id, revisionID, payloadKey, stamp, received, large ? 48 : 1).run()
      ids.push(id); events.push(eventID)
    }
    const outcomes = ['delivered', 'retryable', 'rejected', 'failed', 'interrupted']
    const statements = []
    for (let i = 0; i < 2000; i++) {
      const finished = new Date(time - (i % 168) * 3_600_000 - i * 1000).toISOString()
      statements.push(db.prepare('INSERT INTO delivery_attempts(id,event_id,attempt_no,started_at,finished_at,outcome,http_status,duration_ms) VALUES(?,?,?,?,?,?,500,10)')
        .bind(crypto.randomUUID(), events[i % MESSAGES], Math.floor(i / MESSAGES) + 1, finished, finished, outcomes[i % 5]))
    }
    for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100))
    const headers = { 'Cf-Access-Jwt-Assertion': jwt }
    const get = async path => {
      const response = await mf.dispatchFetch(`${ORIGIN}${path}`, { headers })
      const body = await response.arrayBuffer()
      assert.ok(response.ok, `GET ${path}: ${response.status} ${new TextDecoder().decode(body).slice(0, 300)}`)
      return body
    }
    // The CSRF token comes after the measured first request: the session fetches it lazily.
    let csrf
    const mutate = async (path, method, body) => {
      if (!csrf) {
        const response = await mf.dispatchFetch(`${ORIGIN}/api/csrf`, { headers })
        csrf = { token: (await response.json()).token, cookie: response.headers.get('set-cookie').split(';')[0] }
      }
      const response = await mf.dispatchFetch(`${ORIGIN}${path}`, { method, body: JSON.stringify(body),
        headers: { ...headers, Origin: ORIGIN, Cookie: csrf.cookie, 'X-CSRF-Token': csrf.token, 'Content-Type': 'application/json' } })
      const text = await response.text()
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${text.slice(0, 300)}`)
      return JSON.parse(text)
    }
    return { db, ids, events, get, mutate }
  })
}

/**
 * One isolate pair's session: the isolate's first API request, then every request's first run and warm runs, measured in
 * the Worker's isolate and, for the reads the coordinator answers (the two delegated reads and the attachment download), in
 * the coordinator's too (each number pushed to coordinatorCpu).
 */
async function session({ meters, db, ids, events, get, mutate }, coordinatorCpu) {
  const worker = meters.get('mail-hero'), coordinator = meters.get('mail-hero-coordinator')
  const both = run => async () => { coordinatorCpu.push(await coordinator.cpu(run)) }
  const to = new Date(), from = new Date(to.getTime() - 7 * 86_400_000)
  const summarize = `/api/v2/deliveries/-/attempts:summarize?${new URLSearchParams({ start_time: from.toISOString(), end_time: to.toISOString(), granularity: 'hour', time_zone: 'America/Los_Angeles' })}`
  let paused = false
  return [
    await worker.measure(FIRST, () => get('/api/v2/overview'), 1),
    await worker.measure('GetOverview', () => get('/api/v2/overview'), RUNS),
    await worker.measure('ListMessages (50, a search)', () => get(`/api/v2/messages?${new URLSearchParams({ page_size: '50', filter: '"body"' })}`), RUNS),
    await worker.measure('GetMessage', () => get(`/api/v2/messages/${ids[0]}`), RUNS),
    await worker.measure(CONTENT, both(() => get(`/api/v2/messages/${ids[0]}/content`)), RUNS),
    await worker.measure('GetMessageContent (a small record)', () => get(`/api/v2/messages/${ids[1]}/content`), RUNS),
    await worker.measure('ListDeliveries (50)', () => get('/api/v2/deliveries?page_size=50'), RUNS),
    await worker.measure('GetDelivery', () => get(`/api/v2/deliveries/${events[0]}`), RUNS),
    await worker.measure('ListDeliveryAttempts (48)', () => get(`/api/v2/deliveries/${events[0]}/attempts?page_size=100`), RUNS),
    await worker.measure('GetDeliveryPayload (1 MiB)', () => get(`/api/v2/deliveries/${events[0]}/payload`), RUNS),
    await worker.measure(STATS, both(() => get(summarize)), RUNS),
    await worker.measure('GetSettings', () => get('/api/v2/settings'), RUNS),
    await worker.measure('GetSetupStatus', () => get('/api/v2/setupStatus'), RUNS),
    await worker.measure('ListEndpoints', () => get('/api/v2/endpoints'), RUNS),
    await worker.measure('the raw download (1 MiB)', () => get(`/api/v2/messages/${ids[0]}/raw`), RUNS),
    await worker.measure(ATTACHMENT, both(() => get(`/api/v2/messages/${ids[0]}/attachments/${ATTACHMENTS}`)), RUNS),
    await worker.measure('UpdateSettings (send_paused, under the write lease)', async () => {
      const { version } = await db.prepare('SELECT version FROM app_settings WHERE id=1').first()
      paused = !paused
      await mutate('/api/v2/settings?update_mask=send_paused,etag', 'PATCH', { etag: String(version), send_paused: paused })
    }, RUNS),
  ]
}

test('workerd: the owner API answers its heaviest requests within the Free CPU limit, its old heavy reads no slower', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
  const script = await bundle()
  const keys = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }
  const outbound = async request => {
    const url = new URL(request.url)
    assert.equal(url.href, `${ENV.ACCESS_ISSUER}/cdn-cgi/access/certs`, 'no outbound fetch but the Access certs')
    return Response.json({ keys: [jwk] })
  }
  const coordinatorCpu = collectCoordinatorCpu(session, 3 * RUNS)
  const { runs, reference } = await measureInIsolates(COLD_ISOLATES, () => start(script, outbound, keys), coordinatorCpu.measure)
  console.log(`cpu bounds (reference ms, medians of ${COLD_ISOLATES} isolates): the isolate's first API request < ${COLD_BOUND_MS}, ` +
    `other first runs < ${FIRST_BOUND_MS}, warm medians < ${WARM_BOUND_MS}; the coordinator's slowest delegated read < ${COORDINATOR_BOUND_MS}`)
  assert.equal(reference.size, 17)
  for (const { label, first, median: warm } of reference.values()) {
    assert.ok(first < (label === FIRST ? COLD_BOUND_MS : FIRST_BOUND_MS), `${label}: first run, the median of ${COLD_ISOLATES} isolates: ${first.toFixed(2)} reference ms`)
    if (label !== FIRST) assert.ok(warm < WARM_BOUND_MS, `${label}: warm median, the median of ${COLD_ISOLATES} isolates: ${warm.toFixed(2)} reference ms`)
  }
  // The coordinator runs on the same machine at the same moment: its numbers are divided by the Worker isolate's speed.
  const delegated = runs.flatMap(run => coordinatorCpu.referenceFor(run))
  console.log(`cpu coordinator per delegated read, reference ms, ${runs.length} isolate(s): median ${median(delegated).toFixed(2)}, max ${Math.max(...delegated).toFixed(2)}`)
  assert.ok(Math.max(...delegated) < COORDINATOR_BOUND_MS, `coordinator: the slowest delegated read ${Math.max(...delegated).toFixed(2)} reference ms`)
})
