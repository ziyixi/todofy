// mail.received.v1: CPU of building one event's frozen bytes (buildPayload: the content policy, the generated message
// of proto/mailhero/webhook/v1/mail_received.proto and the wire codec, which checks every rule) inside workerd, measured
// and calibrated like the Ops calls (tools/workerd-cpu/workerd-cpu.mts). An event is built once, when its delivery is
// created, and always in the coordinator, a Durable Object (30 s of CPU per invocation on Free): in its alarm for
// automatic forwards, and in its /deliveries/create for an owner's send, resend or connection test and for the
// dashboard's canary (the Worker's request only waits for the event ID: test/cpu/delivery-request-cpu.test.mjs). The
// email() handler builds nothing: it streams the raw message to R2 and leaves MIME parsing and events to the alarm.
//
// Three events: the owner's connection test (the smallest), 105 attachments (the 100-record metadata cap), and the
// largest parsed input (a 1 MiB UI text, 155,000 of its characters control characters JSON escapes, truncated to the
// webhook's 256 KiB, so the bytes approach the 1 MiB limit; and 105 attachments). Each case is a test of its own,
// measured in COLD_ISOLATES fresh isolates (measureInIsolates): the isolate's first build of an event, then warm runs;
// each isolate calibrates after its builds and its numbers are divided by its own speed (never below 1), and the bounds
// hold each number's median across the isolates, in milliseconds of the reference machine (an Apple M1 Max). A median
// speed above MAX_SPEED fails the test.
//
// Measured on the reference machine on 2026-10-01, in reference ms. Before the move onto proto/ (the hand-written
// builder, one isolate per case): the connection test first 0.4-1.0, warm 0.0-0.4; 105 attachments first 0.6-0.8, warm
// 0.4; the largest parsed input first 3.2-3.3, warm 2.4-2.6. After it, medians of three isolates over eight serial runs
// of `npm run test:cpu` (other work loading the machine to a load average of about 3; single isolates in brackets): the
// connection test first 2.2-2.6 (2.1-2.9), warm 0.4; 105 attachments first 3.6-3.7 (3.5-3.9), warm 0.9; the largest
// parsed input first 6.3-6.6 (6.1-6.6), warm 2.9 (truncating and serialising the text dominates both). The first build
// runs the codec's code paths and reads the contract's rules from the descriptors for the first time. With nine of the
// ten cores busy (`yes`), 3 of 3 runs passed: most calibrations were disturbed and the profiles lost samples, so the
// numbers read low (tools/workerd-cpu/README.md). These bounds are not the Free 10 ms (no Worker request builds an
// event) but a regression gate on the codec, one for the three cases, which run the same codec paths: COLD_BOUND_MS is
// 9.5 ms, about 1.5 times the largest first build, and WARM_BOUND_MS 4.5 ms. An injected 5 ms more in an isolate's
// first build failed the largest case in 3 of 3 runs (11.6-11.7); the smaller cases then read 7.7-9.0 and passed.
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { COLD_ISOLATES, CPU_TEST_TIMEOUT_MS, measureInIsolates } from '../../../../tools/workerd-cpu/workerd-cpu.mts'
import { bundle, startIsolate } from './isolate.mjs'

/** The bound of an isolate's first build of an event (median of COLD_ISOLATES isolates), in reference milliseconds. */
const COLD_BOUND_MS = 9.5
/** The bound of a warm build (the median of COLD_ISOLATES isolates' warm medians), in reference milliseconds. */
const WARM_BOUND_MS = 4.5
const RUNS = 11
const CASES = ['connection_test', 'attachments_105', 'largest_parsed']

const ENTRY = `
  import { buildPayload, syntheticTestMail } from './src/native/pipeline';
  const base = syntheticTestMail();
  const attachment = n => ({ part_id: String(n), filename: 'f' + n + '.txt', content_type: 'text/plain', size: 8, storage_status: 'stored' });
  const mails = {
    connection_test: base,
    attachments_105: { ...base, subject: 'Many small files', attachments: Array.from({ length: 105 }, (_, n) => attachment(n + 1)) },
    largest_parsed: { ...base, subject: 'Quarterly report', text: '\\u0001'.repeat(155000) + 'y'.repeat(1048576 - 155000),
      attachments: Array.from({ length: 105 }, (_, n) => attachment(n + 1)) },
  };
  export default { async fetch(request) {
    const mail = mails[new URL(request.url).pathname.slice(1)];
    const payload = buildPayload('f8c1e9a0-1a98-4fb8-8ca1-4c0a3e71ffff', 'f8c1e9a0-1a98-4fb8-8ca1-4c0a3e72ffff', '2026-10-01T08:00:00.000Z',
      structuredClone(mail), 'inbox@mail.example.org');
    return new Response(String(payload.length));
  } };`

/** The bundle of ENTRY, built once for every case. */
let script

/** A fresh isolate of ENTRY: its global scope ran (as before any request), and no event has been built in it yet. */
function start() {
  return startIsolate({ workers: [{ name: 'mail-hero-payload', modules: true, script, compatibilityDate: '2026-09-07' }], prefix: 'mail-hero-payload-cpu-' },
    ['mail-hero-payload'], async mf => ({
      /** Builds the event of the case `name` and answers its length in bytes. */
      async build(name) {
        const response = await mf.dispatchFetch(`http://payload/${name}`)
        assert.equal(response.status, 200)
        return Number(await response.text())
      },
    }))
}

before(async () => {
  script = await bundle({ contents: ENTRY, sourcefile: 'payload-cpu-entry.ts' })
})

for (const name of CASES) {
  test(`workerd buildPayload(${name}): an event's build stays within its CPU bounds, an isolate's first one too`, { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
    const label = `buildPayload(${name})`
    const { reference } = await measureInIsolates(COLD_ISOLATES, start,
      async ({ meter, build }) => [await meter.measure(label, async () => assert.ok(await build(name) <= 1024 * 1024), RUNS)])
    console.log(`cpu bounds (reference ms, medians of ${COLD_ISOLATES} isolates): first build < ${COLD_BOUND_MS}, warm median < ${WARM_BOUND_MS}`)
    const { first, median } = reference.get(label)
    assert.ok(first < COLD_BOUND_MS, `${label}, the isolate's first build, the median of ${COLD_ISOLATES} isolates: ${first.toFixed(2)} reference ms`)
    assert.ok(median < WARM_BOUND_MS, `${label}, warm median, the median of ${COLD_ISOLATES} isolates: ${median.toFixed(2)} reference ms`)
  })
}
