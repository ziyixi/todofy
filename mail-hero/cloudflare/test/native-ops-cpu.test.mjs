// contracts/ops-v1: CPU of Mail Hero's Ops calls inside workerd, against Workers Free's 10 ms per invocation, measured
// and calibrated by the shared meter (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU profile of the Worker's isolate
// around each call, and the machine's speed from a fixed workload run in the same isolate. A second Worker plays the
// dashboard and calls Ops through a real service binding. The coordinator (a Durable Object) runs in Mail Hero's
// isolate here, so a number includes its share of /ops/status and /ops/guard, which Cloudflare meters separately: an
// upper bound for the entrypoint.
//
// What the bounds guard is the cost of ops-v1 on proto/ (the protobuf-es runtime, the wire codec and the contract's
// value rules, checked on every answer). Measured on the reference machine (an Apple M1 Max) on 2026-10-01, three runs
// each: the isolate's first status() 3.1-5.2 ms before the move and 4.5-5.5 ms after; warm medians 0.4-1.6 ms before
// and 0.4-1.7 ms after (status() the heaviest: six D1 reads and the coordinator's /ops/status). The bounds are
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
import { connectCpuMeter, FREE_CPU_MS, MAX_SPEED, scaleFor, tooSlow } from '../../../tools/workerd-cpu/workerd-cpu.mts'
import { migrationStatements } from './migrations.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
// A port range of its own (FlowDay's CPU test uses 9000-9499, Lab's 9500-9999).
const PORT = 10_000 + Math.floor(Math.random() * 500)
/** The bound of a call's first run in the isolate, in reference milliseconds (today 4.5-5.5 for status()). */
const COLD_BOUND_MS = 0.7 * FREE_CPU_MS
/** The bound of a call's warm median, in reference milliseconds (today at most 1.7). */
const WARM_BOUND_MS = 0.3 * FREE_CPU_MS
const RUNS = 11
const UNKNOWN_EVENT = '6d3b2f0e-4c1a-4b7e-8a52-0c9e7f1d2a31'

test('workerd Ops: every call stays well below the Free CPU limit, the isolate\'s first one too', { timeout: 120000 }, async t => {
  const script = (await build({ entryPoints: [join(root, 'src/native/index.ts')], bundle: true, format: 'esm', platform: 'neutral',
    external: ['cloudflare:workers'], write: false })).outputFiles[0].text
  const temp = await mkdtemp(join(tmpdir(), 'mail-hero-ops-cpu-'))
  const mf = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0, inspectorPort: PORT,
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
  t.after(async () => { meter?.close(); await mf.dispose(); await rm(temp, { recursive: true, force: true }) })
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
  // first status() below is the isolate's first run of the Ops code paths (the entrypoint's and /ops/status).
  const coordinators = await mf.getDurableObjectNamespace('COORDINATOR', 'mail-hero')
  const warmed = await coordinators.get(coordinators.idFromName('inbox-v1')).fetch('https://coordinator/status')
  assert.equal(warmed.status, 200)
  meter = await connectCpuMeter(PORT, 'mail-hero')
  const cold = await meter.cpu(() => ops('status'))
  console.log(`cpu status() as the isolate's first Ops call: ${cold.toFixed(2)} ms`)
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
  const coldBound = COLD_BOUND_MS * scaleFor(calibration.speed), warmBound = WARM_BOUND_MS * scaleFor(calibration.speed)
  console.log(`cpu bounds: first < ${coldBound.toFixed(2)} ms, warm median < ${warmBound.toFixed(2)} ms`)
  assert.ok(calibration.speed <= MAX_SPEED, tooSlow(calibration))
  assert.ok(cold < coldBound, `status() as the isolate's first Ops call: ${cold.toFixed(2)} ms`)
  for (const { label, first, median } of calls) {
    assert.ok(first < coldBound, `${label}: first run ${first.toFixed(2)} ms`)
    assert.ok(median < warmBound, `${label}: warm median ${median.toFixed(2)} ms`)
  }
})
