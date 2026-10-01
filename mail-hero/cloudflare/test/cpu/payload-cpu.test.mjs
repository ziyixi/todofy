// mail.received.v1: CPU of building one event's frozen bytes (buildPayload: the content policy, the generated message
// of proto/mailhero/webhook/v1/mail_received.proto and the wire codec, which checks every rule) inside workerd, measured
// and calibrated like the Ops calls (tools/workerd-cpu/workerd-cpu.mts). An event is built once, when its delivery is
// created: in the coordinator's alarm for automatic forwards (a Durable Object invocation, 30 s on Free), and in the
// Worker's own request for an owner's send or resend and for the dashboard's canary (10 ms on Free). The email()
// handler builds nothing: it streams the raw message to R2 and leaves MIME parsing and events to the alarm.
//
// Three events: the owner's connection test (the smallest), 105 attachments (the 100-record metadata cap), and the
// largest body (256 KiB of text, most of it control characters JSON escapes, so the bytes approach the 1 MiB limit).
// Each is the isolate's first build of an event (a fresh isolate per case), then warm runs.
//
// Measured on the reference machine (an Apple M1 Max) on 2026-10-01, three serial runs of this test alone each, in
// reference ms, before the move onto proto/ (the same test on the hand-written builder) -> after: the connection test
// first 0.4-1.0 -> 2.2-2.5, warm 0.0-0.4 -> 0.4; 105 attachments first 0.7-0.8 -> 3.7-3.9, warm 0.4 -> 0.8-1.0;
// the largest body first 2.5-2.7 -> 4.1-4.7, warm 2.3 -> 2.3-2.4 (JSON.stringify of 256 KiB dominates both). The first
// build runs the codec's code paths and reads the contract's rules from the descriptors for the first time, as an
// isolate's first status() does for ops-v1 (test/cpu/native-ops-cpu.test.mjs); an isolate that answered status() has
// run part of them already. COLD_BOUND_MS is 7 ms, about 1.5 times the largest first build, and WARM_BOUND_MS 3.5 ms:
// milliseconds of the reference machine, scaled by the measured speed (never below 1).
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { connectCpuMeter, FREE_CPU_MS, MAX_SPEED, scaleFor, tooSlow } from '../../../../tools/workerd-cpu/workerd-cpu.mts'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
// A port range of its own (the Ops CPU test uses 10000-10399).
const PORT = 10_400 + Math.floor(Math.random() * 300)
/** The bound of an isolate's first build of an event, in reference milliseconds. */
const COLD_BOUND_MS = 0.7 * FREE_CPU_MS
/** The bound of a warm build, in reference milliseconds. */
const WARM_BOUND_MS = 0.35 * FREE_CPU_MS
const RUNS = 11
const CASES = ['connection_test', 'attachments_105', 'max_size']

const ENTRY = `
  import { buildPayload, syntheticTestMail } from './src/native/pipeline';
  const base = syntheticTestMail();
  const attachment = n => ({ part_id: String(n), filename: 'f' + n + '.txt', content_type: 'text/plain', size: 8, storage_status: 'stored' });
  const mails = {
    connection_test: base,
    attachments_105: { ...base, subject: 'Many small files', attachments: Array.from({ length: 105 }, (_, n) => attachment(n + 1)) },
    max_size: { ...base, subject: 'Quarterly report', text: '\\u0001'.repeat(155000) + 'y'.repeat(107144) },
  };
  export default { async fetch(request) {
    const mail = mails[new URL(request.url).pathname.slice(1)];
    const payload = buildPayload('f8c1e9a0-1a98-4fb8-8ca1-4c0a3e71ffff', 'f8c1e9a0-1a98-4fb8-8ca1-4c0a3e72ffff', '2026-10-01T08:00:00.000Z',
      structuredClone(mail), 'inbox@mail.example.org');
    return new Response(String(payload.length));
  } };`

async function start(script, port) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'mail-hero-payload', modules: true, script, compatibilityDate: '2026-09-07', host: '127.0.0.1', port: 0, inspectorPort: port,
  }))
  await mf.ready
  // The isolate is up (its global scope ran, as before any request); no event has been built yet.
  const meter = await connectCpuMeter(port, 'mail-hero-payload')
  const call = async name => {
    const response = await mf.dispatchFetch(`http://payload/${name}`)
    assert.equal(response.status, 200)
    return Number(await response.text())
  }
  return { mf, meter, call }
}

test('workerd buildPayload: an event is built well below the Free CPU limit, an isolate\'s first one too', { timeout: 300000 }, async t => {
  const script = (await build({ stdin: { contents: ENTRY, resolveDir: root, sourcefile: 'payload-cpu-entry.ts', loader: 'ts' },
    bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false })).outputFiles[0].text
  for (const [i, name] of CASES.entries()) {
    const { mf, meter, call } = await start(script, PORT + i)
    t.after(() => { meter.close(); return mf.dispose() })
    const measured = await meter.measure(`buildPayload(${name})`, async () => assert.ok(await call(name) <= 1024 * 1024), RUNS)
    const calibration = await meter.calibrate()
    assert.ok(calibration.speed <= MAX_SPEED, tooSlow(calibration))
    const scale = scaleFor(calibration.speed)
    console.log(`cpu buildPayload(${name}) in reference ms: first ${(measured.first / scale).toFixed(2)}, warm median ${(measured.median / scale).toFixed(2)} (speed ${calibration.speed.toFixed(2)})`)
    assert.ok(measured.first < COLD_BOUND_MS * scale, `${name}: first build ${measured.first.toFixed(2)} ms`)
    assert.ok(measured.median < WARM_BOUND_MS * scale, `${name}: warm median ${measured.median.toFixed(2)} ms`)
  }
})
