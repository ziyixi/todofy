// The fresh workerd isolates of Mail Hero's CPU tests (test/cpu/*.test.mjs), which the shared meter's
// measureInIsolates (tools/workerd-cpu/workerd-cpu.mts) starts one after another, and what those tests share: the
// Worker's bundle, its synthetic environment, its D1 migrations and a dashboard Worker that calls its Ops entrypoint.
//
// Teardown is the point of this module. A Miniflare that is still running (workerd, its loopback servers, the inspector
// socket of a meter) keeps Node's event loop alive, and `node --test` then waits for the test file's process forever: a
// CPU test that failed while it held one did not fail, it hung until the CI job's 15-minute timeout (CI run
// 36969376937). So startIsolate disposes of everything it started when any later step of the start fails,
// measureInIsolates disposes of each isolate after its session, also when the session fails, and a guard disposes of
// whatever is still running once the file's last test has ended, a test that timed out included.
// test/cpu/isolate-teardown.test.mjs runs failing tests in a child process and holds it to exiting promptly with
// nothing of workerd left behind.
import { after } from 'node:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { connectCpuMeter } from '../../../../tools/workerd-cpu/workerd-cpu.mts'
import { migrationStatements } from '../migrations.mjs'

/** mail-hero/cloudflare. */
export const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** Mail Hero's bindings for the CPU tests: synthetic values only. */
export const ENV = {
  RECEIVE_ADDRESS: 'inbox@mail.example.org', ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com', ACCESS_AUDIENCE: 'synthetic',
  ACCESS_OWNER: 'owner@example.org', CREDENTIAL_KEY: 'a'.repeat(64), WEBHOOK_ALLOWED_HOSTS: 'consumer.example.org',
  FORCE_SEND_PAUSED: 'false', MAINTENANCE_MODE: 'false', PUBLIC_HOST: 'mail-hero.example.net',
}

/** A Worker that plays the dashboard: it calls Mail Hero's Ops entrypoint through a real service binding. */
export const DASHBOARD_WORKER = {
  name: 'dashboard', modules: true, compatibilityDate: '2026-09-07',
  script: `export default { async fetch(request, env) {
    const { method, args } = await request.json()
    try { return Response.json({ ok: await env.MAIL_HERO[method](...args) }) }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'not_an_error' }) }
  } }`,
  serviceBindings: { MAIL_HERO: { name: 'mail-hero', entrypoint: 'Ops' } },
}

/** The Worker's ESM bundle: of src/native/index.ts, or of an entry given as esbuild's `stdin`. */
export async function bundle(stdin) {
  const input = stdin === undefined ? { entryPoints: [join(root, 'src/native/index.ts')] } : { stdin: { resolveDir: root, loader: 'ts', ...stdin } }
  const { outputFiles } = await build({ ...input, bundle: true, format: 'esm', platform: 'neutral', conditions: ['browser'], external: ['cloudflare:workers'], write: false })
  return outputFiles[0].text
}

/** Applies every migration to the D1 database DB of the Worker `worker`. */
export async function migrate(mf, worker = 'mail-hero') {
  const db = await mf.getD1Database('DB', worker)
  for (const name of (await readdir(join(root, 'migrations'))).filter(name => name.endsWith('.sql')).sort()) {
    await db.batch(migrationStatements(await readFile(join(root, 'migrations', name), 'utf8')).map(sql => db.prepare(sql)))
  }
  return db
}

/** `ops(method, ...args)`: calls Mail Hero's Ops through DASHBOARD_WORKER and returns the answer; an error throws. */
export async function opsCaller(mf) {
  const dashboard = await mf.getWorker('dashboard')
  return async (method, ...args) => {
    const result = await (await dashboard.fetch('http://dashboard/', { method: 'POST', body: JSON.stringify({ method, args }) })).json()
    if (result.error !== undefined) throw new Error(`${method}: ${result.error}`)
    return result.ok
  }
}

/** Isolates started and not yet disposed of: what the guard below disposes of. */
const running = new Set()

// The guard: once the file's last test has ended, failed or timed out (node:test runs a root `after` hook then), any
// isolate still running is disposed of, so that the file's process can exit.
after(async () => {
  const left = [...running]
  if (left.length > 0) console.log(`cpu teardown: ${left.length} isolate(s) still running after the last test, disposed of`)
  await Promise.all(left.map(isolate => isolate.dispose()))
})

/**
 * Starts a fresh isolate for measureInIsolates: a Miniflare of `workers` (inspectorPort 0: the OS picks the port, which
 * the meters read back) that persists D1, R2 and Durable Objects in a new temporary directory; then `prepare(mf)`, the
 * setup outside any measurement, whose fields the isolate gets; then a CPU meter connected to each Worker named in
 * `metered`, after the setup, so that the setup's requests are not in the profiles. Returns the isolate: `mf`, those
 * fields, `meters` by Worker name, `meter` (the first one's, which measureInIsolates calibrates) and `dispose`, which
 * closes the meters, disposes of the Miniflare and removes the directory, at most once. When any step of the start
 * fails, everything it had started is disposed of before the error is thrown.
 */
export async function startIsolate({ workers, prefix = 'mail-hero-cpu-' }, metered, prepare = async () => ({})) {
  const temp = await mkdtemp(join(tmpdir(), prefix))
  let mf
  try {
    mf = new Miniflare(convertV4MiniflareOptions({
      host: '127.0.0.1', port: 0, inspectorPort: 0,
      d1Persist: join(temp, 'd1'), r2Persist: join(temp, 'r2'), durableObjectsPersist: join(temp, 'do'),
      workers,
    }))
  } catch (error) {
    await rm(temp, { recursive: true, force: true })
    throw error
  }
  const meters = new Map()
  let disposing
  const isolate = {
    mf,
    meters,
    dispose() {
      disposing ??= (async () => {
        running.delete(isolate)
        for (const meter of meters.values()) meter.close()
        try {
          await mf.dispose()
        } finally {
          await rm(temp, { recursive: true, force: true })
        }
      })()
      return disposing
    },
  }
  running.add(isolate)
  try {
    await mf.ready
    Object.assign(isolate, await prepare(mf))
    for (const name of metered) meters.set(name, await connectCpuMeter(mf, name))
    isolate.meter = meters.get(metered[0])
    return isolate
  } catch (error) {
    await isolate.dispose()
    throw error
  }
}
