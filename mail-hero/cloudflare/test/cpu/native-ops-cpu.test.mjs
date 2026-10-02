// contracts/ops-v1: CPU of Mail Hero's Ops calls inside workerd, against Workers Free's 10 ms per invocation, measured
// and calibrated by the shared meter (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU profile of the Worker's isolate
// around each call, and the machine's speed from a fixed workload run in the same isolate. A second Worker plays the
// dashboard and calls Ops through a real service binding. The coordinator (a Durable Object) runs in Mail Hero's
// isolate here, so a number includes its share of /ops/status and /ops/guard, which Cloudflare meters separately: an
// upper bound for the entrypoint.
//
// What the bounds guard is the cost of ops-v1 on proto/ (the protobuf-es runtime, the wire codec and the contract's
// value rules, checked on every answer). It runs alone and serially (`npm run test:cpu`, its own CI step), never
// beside the other workerd suites of `npm test`: another isolate busy at the same moment is not in the calibration.
// The whole session runs in COLD_ISOLATES fresh isolates (measureInIsolates): each isolate calibrates after its calls,
// so that each first run is the isolate's first run of its path, every number is divided by its own isolate's speed
// (never below 1), and the bounds hold each number's median across the isolates, in milliseconds of the reference
// machine (an Apple M1 Max). A median speed above MAX_SPEED fails the test.
//
// Measured on the reference machine on 2026-10-01: an isolate's first status() took 3.5-7.7 ms of reference time (35
// isolates, median 5.8), the median of three isolates 4.9-6.9 ms; GitHub runners read single isolates 4.8-7.3 ms and
// medians of three 5.0-7.1 ms (the faster runners the higher: their cold runs are relatively slower than the warm
// calibration). Other calls' first runs at most 2.7 ms (runners 3.7); warm medians at most 2.2 ms (status() the
// heaviest: six D1 reads and the coordinator's /ops/status). Before the move onto proto/ the first status() took
// 3.1-5.2 ms. COLD_BOUND_MS is 9 ms, about a quarter above the runners' highest median, and an injected 5 ms more in
// the first status() fails on the reference machine (tools/workerd-cpu/README.md): the isolate's first status() leaves
// about 4 ms of Free's 10 ms on the reference machine, less than before the move (about half).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { COLD_ISOLATES, connectCpuMeter, CPU_TEST_TIMEOUT_MS, FREE_CPU_MS, measureInIsolates } from '../../../../tools/workerd-cpu/workerd-cpu.mts'
import { migrationStatements } from '../migrations.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const COLD_LABEL = "status() as the isolate's first Ops call"
/** The bound of the isolate's first status() (the median of COLD_ISOLATES isolates), in reference milliseconds. */
const COLD_BOUND_MS = 0.9 * FREE_CPU_MS
/** The bound of every other call's first run, in reference milliseconds (today at most 2.7). */
const FIRST_BOUND_MS = 0.8 * FREE_CPU_MS
/** The bound of a call's warm median, in reference milliseconds (today at most 2.2). */
const WARM_BOUND_MS = 0.3 * FREE_CPU_MS
const RUNS = 11
const UNKNOWN_EVENT = '6d3b2f0e-4c1a-4b7e-8a52-0c9e7f1d2a31'

/** A fresh Mail Hero isolate (its D1 migrated, its coordinator constructed) and a dashboard Worker calling its Ops. */
async function start(script) {
  const temp = await mkdtemp(join(tmpdir(), 'mail-hero-ops-cpu-'))
  // inspectorPort 0: the OS picks a free port, which the meter reads back from Miniflare.
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0, inspectorPort: 0,
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
    meter = await connectCpuMeter(mf, 'mail-hero')
    return { ops, meter, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

/** One isolate's session: its first status(), then every call's first run and warm runs. */
async function session({ ops, meter }) {
  const until = new Date(Date.now() + 3_600_000).toISOString()
  return [
    await meter.measure(COLD_LABEL, () => ops('status'), 1),
    await meter.measure('status()', async () => assert.equal((await ops('status')).app, 'mail-hero'), RUNS),
    await meter.measure('setGuard(shed), the same input again', async () => assert.equal((await ops('setGuard', { level: 'shed', reason: 'd1_reads_high', until })).level, 'shed'), RUNS),
    await meter.measure('status() while shed', () => ops('status'), RUNS),
    await meter.measure('canaryDelivery(unknown)', async () => assert.equal((await ops('canaryDelivery', UNKNOWN_EVENT)).state, 'unknown'), RUNS),
    await meter.measure('startCanary (archive mode: unavailable, no write)', async () => assert.equal((await ops('startCanary', { run_id: 'canary-2026-10-01' })).reason, 'no_endpoint'), RUNS),
  ]
}

test('workerd Ops: every call stays well below the Free CPU limit, the isolate\'s first one too', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
  const script = (await build({ entryPoints: [join(root, 'src/native/index.ts')], bundle: true, format: 'esm', platform: 'neutral',
    external: ['cloudflare:workers'], write: false })).outputFiles[0].text
  const { reference } = await measureInIsolates(COLD_ISOLATES, () => start(script), session)
  console.log(`cpu bounds (reference ms, medians of ${COLD_ISOLATES} isolates): the isolate's first status() < ${COLD_BOUND_MS}, ` +
    `other first runs < ${FIRST_BOUND_MS}, warm medians < ${WARM_BOUND_MS}`)
  assert.equal(reference.size, 6)
  for (const { label, first, median } of reference.values()) {
    if (label === COLD_LABEL) {
      assert.ok(first < COLD_BOUND_MS, `${label}, the median of ${COLD_ISOLATES} isolates: ${first.toFixed(2)} reference ms`)
      continue
    }
    assert.ok(first < FIRST_BOUND_MS, `${label}: first run ${first.toFixed(2)} reference ms`)
    assert.ok(median < WARM_BOUND_MS, `${label}: warm median ${median.toFixed(2)} reference ms`)
  }
})
