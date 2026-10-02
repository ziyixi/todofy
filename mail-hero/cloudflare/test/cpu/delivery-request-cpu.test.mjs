// mail.received.v1: CPU of the Worker requests that ask for a new event, against Workers Free's 10 ms per request,
// measured and calibrated by the shared meter (tools/workerd-cpu/workerd-cpu.mts). Four requests create a delivery
// and so build its event: the owner's send (mailhero.ui.v2 SendMessage, POST /api/v2/messages/{id}:send), resend
// (ResendDelivery, POST /api/v2/deliveries/{id}:resend) and connection test (TestEndpoint, POST
// /api/v2/endpoints/{id}:test), and the dashboard's canary (Ops startCanary, through a real service binding). Each reaches the coordinator (requestDelivery, POST /deliveries/create), a Durable Object whose invocation
// has 30 s of CPU on Free, which reads the message's parsed record from R2, truncates its text and writes the event
// with the wire codec (createDelivery, buildPayload). Before, the Worker did that itself: with the largest parsed
// record below, a send took 12-15 ms of reference CPU first and 10-12 ms warm (the JSON parse of a 4 MiB record
// dominates), beyond the Free limit.
//
// The Worker and the coordinator run as two Workers here (the coordinator's script is a copy of the bundle), so each
// has its own isolate and meter, as Cloudflare meters a Worker's request and a Durable Object's invocation apart.
// Requests carry a real Access JWT (signed here, verified by packages/edge-auth against certs the outbound service
// serves) and the CSRF token, as from the UI. Each message's parsed record is the largest the content policy writes:
// a 1 MiB UI text (155,000 control characters JSON escapes, so the text is truncated to the webhook's 256 KiB and
// the event approaches its 1 MiB), a 2 MiB HTML body, 105 attachments (beyond the 100-record metadata cap) and 2,048
// headers: about 4 MiB of JSON.
//
// The whole session runs in COLD_ISOLATES fresh isolate pairs (measureInIsolates), so each request's first run is
// the median of three isolates' first runs of its path. The Worker's isolate calibrates after the requests, and every
// number of the pair, the coordinator's too (it runs on the same machine at the same moment), is divided by that
// isolate's speed (never below 1). The Worker's bounds hold each number's median across the isolates; the
// coordinator's holds its slowest invocation in any isolate. Milliseconds of the reference machine (an Apple M1 Max); a
// median speed above MAX_SPEED fails the test.
//
// Measured on the reference machine on 2026-10-01, medians of three isolates over eight serial runs of `npm run
// test:cpu` (other work loading the machine to a load average of about 3; single isolates in brackets), in reference
// ms: the Worker's send first 2.6-3.7 (2.1-4.2), warm 1.8-2.2; resend first 1.8-2.7 (1.1-3.3), warm 1.6-2.4; connection
// test first 1.4-2.1 (1.0-2.6), warm 1.2-1.8; startCanary first 1.8-2.7 (1.6-2.8), warm 0.6-1.2. The same test on the
// earlier request path (the Worker built the event, one isolate): send first 14.5, warm 11.6. The coordinator's
// /deliveries/create for the largest record took a median of 9.2-9.9 ms and at most 16 ms (of 30 s). With nine of the
// ten cores busy (`yes`), 3 of 3 runs passed, the numbers reading low (tools/workerd-cpu/README.md).
// WORKER_COLD_BOUND_MS is 6 ms and WORKER_WARM_BOUND_MS 3.5 ms; an injected 5 ms more in the Worker's first request
// (requestDelivery) failed 3 of 3 runs (send first 8.4-9.4). COORDINATOR_BOUND_MS is 1 s, a thirtieth of the Durable
// Object's limit.
import test from 'node:test'
import assert from 'node:assert/strict'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { COLD_ISOLATES, CPU_TEST_TIMEOUT_MS, FREE_CPU_MS, measureInIsolates, median, scaleFor } from '../../../../tools/workerd-cpu/workerd-cpu.mts'
import { bundle, DASHBOARD_WORKER, ENV, migrate, opsCaller, startIsolate } from './isolate.mjs'

/** The bound of a request's first run in the Worker's isolate (median of COLD_ISOLATES isolates), in reference ms. */
const WORKER_COLD_BOUND_MS = 0.6 * FREE_CPU_MS
/** The bound of a request's warm median in the Worker's isolate (median of COLD_ISOLATES isolates), in reference ms. */
const WORKER_WARM_BOUND_MS = 0.35 * FREE_CPU_MS
/** The bound of the coordinator's slowest /deliveries/create in any isolate, in reference ms (Free's limit: 30 s). */
const COORDINATOR_BOUND_MS = 1000
const RUNS = 6
const MIB = 1024 * 1024
const ORIGIN = `https://${ENV.PUBLIC_HOST}`
const KID = 'synthetic-kid'
const SEND = 'SendMessage (largest record)'
const RESEND = 'ResendDelivery (largest record)'
const TEST = 'TestEndpoint'
const CANARY = 'Ops startCanary (default endpoint)'

/** The largest parsed record (message.json) the content policy writes; synthetic. */
function largestParsed(n) {
  return JSON.stringify({
    subject: `Synthetic quarterly report ${n}`, text: '\u0001'.repeat(155_000) + 'y'.repeat(MIB - 155_000), html: '<p>' + 'z'.repeat(2 * MIB - 7) + '</p>',
    from: [{ address: 'sender@example.org', name: 'Synthetic sender' }], to: [{ address: 'inbox@mail.example.org', name: '' }], cc: [], reply_to: [],
    sent_at: null, rfc_message_id: '<synthetic@example.org>',
    headers: Array.from({ length: 2048 }, (_, i) => ({ key: `x-synthetic-${i}`, value: 'v'.repeat(100) })),
    attachments: Array.from({ length: 105 }, (_, i) => ({ part_id: String(i + 1), filename: `f${i}.txt`, content_type: 'text/plain', size: 8,
      storage_status: 'stored', r2_key: `parsed/synthetic/${i}` })),
    needs_review: false, warnings: ['text_truncated'], text_truncated: true, original_text_bytes: 5_000_000, html_omitted: false,
    attachments_omitted_count: 0, content_policy_version: 'storage-v1',
  })
}

/**
 * A fresh isolate pair: Mail Hero's Worker and its coordinator as two Workers (the coordinator's script is a copy of
 * the bundle), with a migrated D1, a forwarding endpoint and RUNS archived messages that each have the largest parsed
 * record, and the dashboard calling Ops. `meter` is the Worker's (it calibrates), `meters` has the coordinator's too.
 */
function start(script, outbound, keys) {
  const common = { modules: true, script, compatibilityDate: '2026-09-07', d1Databases: { DB: 'delivery-cpu' }, r2Buckets: ['MAIL_STORE'],
    bindings: ENV, serviceBindings: { ASSETS: () => new Response('synthetic') }, outboundService: outbound }
  const workers = [
    { name: 'mail-hero', ...common, durableObjects: { COORDINATOR: { className: 'MailCoordinator', scriptName: 'mail-hero-coordinator', useSQLite: true } } },
    { name: 'mail-hero-coordinator', ...common, durableObjects: { COORDINATOR: { className: 'MailCoordinator', useSQLite: true } } },
    DASHBOARD_WORKER,
  ]
  return startIsolate({ workers, prefix: 'mail-hero-delivery-cpu-' }, ['mail-hero', 'mail-hero-coordinator'], async mf => {
    const db = await migrate(mf)
    const bucket = await mf.getR2Bucket('MAIL_STORE', 'mail-hero')
    const jwt = await new SignJWT({ email: ENV.ACCESS_OWNER }).setProtectedHeader({ alg: 'RS256', kid: KID }).setIssuer(ENV.ACCESS_ISSUER)
      .setAudience(ENV.ACCESS_AUDIENCE).setSubject('synthetic-user').setIssuedAt().setExpirationTime('30m').sign(keys.privateKey)
    const csrf = await mf.dispatchFetch(`${ORIGIN}/api/csrf`, { headers: { 'Cf-Access-Jwt-Assertion': jwt } })
    assert.equal(csrf.status, 200)
    const token = (await csrf.json()).token, cookie = csrf.headers.get('set-cookie').split(';')[0]
    const api = async (path, method, body) => {
      const response = await mf.dispatchFetch(`${ORIGIN}/api/v2${path}`, { method,
        headers: { 'Cf-Access-Jwt-Assertion': jwt, Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body) })
      const result = await response.json()
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`)
      return result
    }
    const created = await api(`/endpoints?request_id=${crypto.randomUUID()}`, 'POST', { display_name: 'Synthetic consumer', uri: 'https://consumer.example.org/hooks/mail',
      auth_type: 'bearer', credential: 'synthetic-token-not-a-real-secret', rate_per_minute: 60, timeout_seconds: 2 })
    const endpoint = { ...created, id: created.name.slice('endpoints/'.length) }
    await db.prepare("UPDATE app_settings SET mode='forward',current_endpoint_id=? WHERE id=1").bind(endpoint.id).run()
    // Archived messages, each with the largest parsed record: one sent per run, then resent.
    const messages = []
    for (let n = 0; n < RUNS; n++) {
      const id = crypto.randomUUID(), key = `parsed/${id}/synthetic/message.json`, content = largestParsed(n), time = new Date().toISOString()
      await bucket.put(key, content)
      await db.prepare(`INSERT INTO messages(id,origin,received_at,last_received_at,envelope_from,envelope_recipient,size_bytes,receive_mode,parse_state,parsed_key,parsed_size_bytes,content_bytes,subject,from_text)
        VALUES(?,'cloudflare',?,?,'sender@example.org','inbox@mail.example.org',1000,'archive','ready',?,?,?,'Synthetic','Synthetic sender')`)
        .bind(id, time, time, key, content.length, content.length).run()
      messages.push(id)
    }
    return { db, api, ops: await opsCaller(mf), endpoint, messages }
  })
}

/**
 * One isolate's session: each request's first run and RUNS - 1 warm runs, measured in the Worker's isolate and, around
 * the same run, in the coordinator's (its /deliveries/create and whatever its alarm runs then), whose every number is
 * pushed to `coordinatorCpu`.
 */
async function session({ meters, db, api, ops, endpoint, messages }, coordinatorCpu) {
  const worker = meters.get('mail-hero'), coordinator = meters.get('mail-hero-coordinator')
  const both = run => async () => { coordinatorCpu.push(await coordinator.cpu(run)) }
  const sent = []
  const send = await worker.measure(SEND, both(async () => {
    const result = await api(`/messages/${messages[sent.length]}:send`, 'POST', { endpoint: endpoint.name, request_id: crypto.randomUUID() })
    assert.ok(result.delivery.name)
    sent.push(result.delivery.name.slice('deliveries/'.length))
  }), RUNS)
  assert.equal(new Set(sent).size, RUNS)
  // Each message's version after its send, read here: no D1 read from the test runs while a resend is measured.
  const versions = []
  for (const id of messages) versions.push((await db.prepare('SELECT version FROM messages WHERE id=?').bind(id).first()).version)
  let resent = 0, canaries = 0
  const calls = [
    send,
    await worker.measure(RESEND, both(async () => {
      const n = resent++
      assert.ok((await api(`/deliveries/${sent[n]}:resend`, 'POST', { endpoint: endpoint.name, request_id: crypto.randomUUID(), message_etag: String(versions[n]) })).delivery.name)
    }), RUNS),
    await worker.measure(TEST, both(async () => {
      assert.ok((await api(`/endpoints/${endpoint.id}:test`, 'POST', { request_id: crypto.randomUUID() })).delivery.name)
    }), RUNS),
    await worker.measure(CANARY, both(async () => {
      assert.equal((await ops('startCanary', { run_id: `canary-cpu-${canaries++}` })).state, 'queued')
    }), RUNS),
  ]
  // The coordinator built every event: each is frozen in R2 and none was refused.
  const { n } = await db.prepare('SELECT count(*) n FROM deliveries').first()
  assert.equal(n, 4 * RUNS)
  return calls
}

test('workerd: a Worker request that creates a delivery stays well below the Free CPU limit; the coordinator builds the event', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
  const script = await bundle()
  const keys = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }
  const outbound = async request => {
    const url = new URL(request.url)
    if (url.href === `${ENV.ACCESS_ISSUER}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] })
    assert.equal(url.hostname, 'consumer.example.org', 'no unexpected outbound fetch')
    return new Response(null, { status: 204 })
  }
  // Every isolate's coordinator numbers, in the order measureInIsolates measures the isolates (its `runs`).
  const coordinatorCpu = []
  const { runs, reference } = await measureInIsolates(COLD_ISOLATES, () => start(script, outbound, keys), isolate => {
    const numbers = []
    coordinatorCpu.push(numbers)
    return session(isolate, numbers)
  })
  console.log(`cpu bounds (reference ms, medians of ${COLD_ISOLATES} isolates): the Worker's first runs < ${WORKER_COLD_BOUND_MS}, ` +
    `warm medians < ${WORKER_WARM_BOUND_MS}; the coordinator's slowest /deliveries/create < ${COORDINATOR_BOUND_MS}`)
  assert.equal(reference.size, 4)
  for (const { label, first, median: warm } of reference.values()) {
    assert.ok(first < WORKER_COLD_BOUND_MS, `${label}: first run, the median of ${COLD_ISOLATES} isolates: ${first.toFixed(2)} reference ms`)
    assert.ok(warm < WORKER_WARM_BOUND_MS, `${label}: warm median, the median of ${COLD_ISOLATES} isolates: ${warm.toFixed(2)} reference ms`)
  }
  // The coordinator runs on the same machine at the same moment as the Worker, so its isolate's numbers are divided by
  // the Worker isolate's speed too.
  assert.equal(coordinatorCpu.length, runs.length)
  const coordinator = runs.flatMap((run, index) => coordinatorCpu[index].map(ms => ms / scaleFor(run.calibration.speed)))
  const sends = runs.flatMap((run, index) => coordinatorCpu[index].slice(0, 2 * RUNS).map(ms => ms / scaleFor(run.calibration.speed)))
  console.log(`cpu coordinator per send or resend, reference ms, ${runs.length} isolate(s): median ${median(sends).toFixed(2)}, max ${Math.max(...sends).toFixed(2)}`)
  assert.ok(Math.max(...coordinator) < COORDINATOR_BOUND_MS, `coordinator: the slowest /deliveries/create ${Math.max(...coordinator).toFixed(2)} reference ms`)
})
