// contracts/ops-v1: CPU of Mail Hero's Ops calls inside workerd, against Workers Free's 10 ms per invocation, measured
// and calibrated by the shared meter (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU profile of the Worker's isolate
// around each call, and the machine's speed from a fixed workload run in the same isolate. A second Worker plays the
// dashboard and calls Ops through a real service binding. The coordinator (a Durable Object) runs in Mail Hero's
// isolate here, so a number includes its share of /ops/status and /ops/guard, which Cloudflare meters separately: an
// upper bound for the entrypoint.
//
// What the bounds guard is the cost of ops-v1 on proto/ (the protobuf-es runtime, the wire codec and the contract's
// value rules, checked on every answer). It runs alone and serially (`npm run test:cpu`, its own CI step), never
// beside the other workerd suites of `npm test`: another isolate busy at the same moment is not in the calibration,
// which runs after the calls (so that each first run is the isolate's first run of its path). The isolate's first
// status() is one sample per isolate, so it is measured in COLD_ISOLATES fresh isolates and the median counts, each
// scaled by its own isolate's speed.
//
// Measured on the reference machine (an Apple M1 Max) on 2026-10-01, 24 serial runs of this test alone: an isolate's
// first status() took 5.0-7.1 ms of reference time (an earlier review's serial runs saw up to 7.6 ms), the median of
// three isolates 5.4-6.6 ms; other calls' first runs at most 2.7 ms; warm medians at most 2.2 ms (status() the
// heaviest: six D1 reads and the coordinator's /ops/status). Before the move onto proto/ the first status() took
// 3.1-5.2 ms. COLD_BOUND_MS is 8 ms, about 1.4 ms above the highest median: the isolate's first status() leaves about
// a quarter of Free's 10 ms on the reference machine, less than before the move (about half). The bounds are
// milliseconds of that machine, multiplied by the measured speed (never below 1); a machine slower than MAX_SPEED
// fails the test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { connectCpuMeter, FREE_CPU_MS, MAX_SPEED, median, scaleFor, tooSlow } from '../../../../tools/workerd-cpu/workerd-cpu.mts'
import { migrationStatements } from '../migrations.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
// A port range of its own (FlowDay's CPU test uses 9000-9499, Lab's 9500-9999), one port per isolate.
const PORT = 10_000 + Math.floor(Math.random() * 400)
/** The bound of the median isolate's first status(), and of every other call's first run, in reference milliseconds. */
const COLD_BOUND_MS = 0.8 * FREE_CPU_MS
/** The bound of a call's warm median, in reference milliseconds (today at most 2.2). */
const WARM_BOUND_MS = 0.3 * FREE_CPU_MS
const RUNS = 11
/** Fresh isolates whose first status() is measured; their median is held to COLD_BOUND_MS. */
const COLD_ISOLATES = 3
const UNKNOWN_EVENT = '6d3b2f0e-4c1a-4b7e-8a52-0c9e7f1d2a31'

/** A fresh Mail Hero isolate (its D1 migrated, its coordinator constructed) and a dashboard Worker calling its Ops. */
async function start(script, port) {
  const temp = await mkdtemp(join(tmpdir(), 'mail-hero-ops-cpu-'))
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0, inspectorPort: port,
    d1Persist: join(temp, 'd1'), r2Persist: join(temp, 'r2'), durableObjectsPersist: join(temp, 'do'),
    workers: [
      { name: 'mail-hero', modules: true, script, compatibilityDate: '2026-09-07',
        d1Databases: { DB: 'ops-cpu' }, r2Buckets: ['MAIL_STORE'],
        durableObjects: { COORDINATOR: { className: 'MailCoordinator', useSQLite: true } },
        bindings: { RECEIVE_ADDRESS: 'inbox@mail.example.org', ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com', ACCESS_AUDIENCE: 'synthetic',
          ACCESS_OWNER: 'owner@example.org', CREDENTIAL_KEY: 'a'.repeat(64), WEBHOOK_ALLOWED_HOSTS: 'consumer.example.org',
          FORCE_SEND_PAUSED: 'false', MAINTENANCE_MODE: 'false', PUBLIC_HOST: 'mail-hero.example.net' },
        serviceBindings: { ASSETS: () => new Response('synthetic') } },
      { name: 'dashboard', modules: true, compatibilityDate: '2026-09-07',
        script: `export default { async fetch(request, env) {
          const { method, args } = await request.json()
          try { return Response.json({ ok: await env.MAIL_HERO[method](...args) }) }
          catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'not_an_error' }) }
        } }`,
        serviceBindings: { MAIL_HERO: { name: 'mail-hero', entrypoint: 'Ops' } } },
    ],
  }))
  let meter
  const dispose = async () => { meter?.close(); await mf.dispose(); await rm(temp, { recursive: true, force: true }) }
  try {
    await mf.ready
    const db = await mf.getD1Database('DB', 'mail-hero')
    for (const name of (await readdir(join(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort()) {
      await db.batch(migrationStatements(await readFile(join(root, 'migrations', name), 'utf8')).map(sql => db.prepare(sql)))
    }
    const dashboard = await mf.getWorker('dashboard')
    const ops = async (method, ...args) => {
      const result = await (await dashboard.fetch('http://dashboard/', { method: 'POST', body: JSON.stringify({ method, args }) })).json()
      if (result.error !== undefined) throw new Error(`${method}: ${result.error}`)
      return result.ok
    }
    // Cloudflare meters the coordinator's invocations apart from the entrypoint's; here they share the isolate. So the
    // coordinator is constructed first, through a route that runs none of the ops code (its own /status), and the
    // first status() is the isolate's first run of the Ops code paths (the entrypoint's and /ops/status).
    const coordinators = await mf.getDurableObjectNamespace('COORDINATOR', 'mail-hero')
    const warmed = await coordinators.get(coordinators.idFromName('inbox-v1')).fetch('https://coordinator/status')
    assert.equal(warmed.status, 200)
    meter = await connectCpuMeter(port, 'mail-hero')
    return { ops, meter, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

test('workerd Ops: every call stays well below the Free CPU limit, the isolate\'s first one too', { timeout: 300000 }, async t => {
  const script = (await build({ entryPoints: [join(root, 'src/native/index.ts')], bundle: true, format: 'esm', platform: 'neutral',
    external: ['cloudflare:workers'], write: false })).outputFiles[0].text
  // The isolate's first status(), in fresh isolates one after another, each in reference milliseconds.
  const colds = []
  let last
  for (let i = 0; i < COLD_ISOLATES; i++) {
    const isolate = await start(script, PORT + i)
    const cold = await isolate.meter.cpu(() => isolate.ops('status'))
    if (i < COLD_ISOLATES - 1) {
      const { speed } = await isolate.meter.calibrate()
      assert.ok(speed <= MAX_SPEED, `isolate ${i}: speed ${speed.toFixed(2)}`)
      colds.push(cold / scaleFor(speed))
      console.log(`cpu status() as isolate ${i}'s first Ops call: ${cold.toFixed(2)} ms (speed ${speed.toFixed(2)})`)
      await isolate.dispose()
    } else {
      last = { ...isolate, cold }
      t.after(isolate.dispose)
    }
  }
  const { ops, meter } = last
  const until = new Date(Date.now() + 3_600_000).toISOString()
  const calls = [
    await meter.measure('status()', async () => assert.equal((await ops('status')).app, 'mail-hero'), RUNS),
    await meter.measure('setGuard(shed), the same input again', async () => assert.equal((await ops('setGuard', { level: 'shed', reason: 'd1_reads_high', until })).level, 'shed'), RUNS),
    await meter.measure('status() while shed', () => ops('status'), RUNS),
    await meter.measure('canaryDelivery(unknown)', async () => assert.equal((await ops('canaryDelivery', UNKNOWN_EVENT)).state, 'unknown'), RUNS),
    await meter.measure('startCanary (archive mode: unavailable, no write)', async () => assert.equal((await ops('startCanary', { run_id: 'canary-2026-10-01' })).reason, 'no_endpoint'), RUNS),
  ]
  // Calibrated after the calls, so that each first run above is still the isolate's first run of its path.
  const calibration = await meter.calibrate()
  assert.ok(calibration.speed <= MAX_SPEED, tooSlow(calibration))
  const scale = scaleFor(calibration.speed)
  colds.push(last.cold / scale)
  console.log(`cpu status() as isolate ${COLD_ISOLATES - 1}'s first Ops call: ${last.cold.toFixed(2)} ms (speed ${calibration.speed.toFixed(2)})`)
  const cold = median(colds)
  console.log(`cpu first status(), median of ${COLD_ISOLATES} isolates: ${cold.toFixed(2)} reference ms (bound ${COLD_BOUND_MS})`)
  const coldBound = COLD_BOUND_MS * scale, warmBound = WARM_BOUND_MS * scale
  console.log(`cpu bounds here: first < ${coldBound.toFixed(2)} ms, warm median < ${warmBound.toFixed(2)} ms`)
  assert.ok(cold < COLD_BOUND_MS, `status() as an isolate's first Ops call, median: ${cold.toFixed(2)} reference ms`)
  for (const { label, first, median: warm } of calls) {
    assert.ok(first < coldBound, `${label}: first run ${first.toFixed(2)} ms`)
    assert.ok(warm < warmBound, `${label}: warm median ${warm.toFixed(2)} ms`)
  }
})
