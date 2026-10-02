// The committed production config ../../wrangler.toml, read with the pinned wrangler's own raw-config reader
// (worker/node_modules): the shape the Worker "watch" needs, nothing personal or injected, since W2 (the first deploy)
// its one Custom Domain and the Access application's AUD. One SQLite Durable Object and no cron, D1, R2 or KV.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { CONFIG, INJECTED } from '../deploy-vars.mjs'

const APP = new URL('../../', import.meta.url)
const require = createRequire(new URL('worker/package.json', APP))
const wrangler = await import(pathToFileURL(require.resolve('wrangler')).href)
const config = JSON.parse(JSON.stringify(wrangler.experimental_readRawConfig({ config: CONFIG }).rawConfig))
const values = readFileSync(CONFIG, 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')

// Every key the Worker "watch" uses; a new one must be added here on purpose (and checked below).
const KEYS = ['name', 'account_id', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'routes', 'observability', 'assets', 'durable_objects', 'migrations', 'services', 'vars']

test('the top level is the production Worker: known keys only, no cron, no workers.dev or preview URL, one Custom Domain', () => {
  assert.deepEqual(Object.keys(config).sort(), [...KEYS].sort())
  assert.equal(config.name, 'watch')
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.equal(config.triggers, undefined)
  // The whole host, behind the Access application "watch"; wrangler applies the list as the complete set.
  assert.deepEqual(config.routes, [{ pattern: 'watch.ziyixi.science', custom_domain: true }])
  assert.equal(config.route, undefined)
  assert.match(config.account_id, /^[a-f0-9]{32}$/)
})

test('no request URL reaches a log: invocation logs and traces are off', () => {
  assert.deepEqual(config.observability, { enabled: true, logs: { enabled: true, invocation_logs: false }, traces: { enabled: false } })
})

test('every request reaches the Worker first (Access, private headers), and /new falls back to the page', () => {
  assert.equal(config.main, 'worker/src/index.ts')
  assert.ok(existsSync(new URL(config.main, APP)))
  assert.deepEqual(config.assets, { directory: 'web/dist', binding: 'ASSETS', run_worker_first: true, not_found_handling: 'single-page-application' })
})

test('one SQLite Durable Object, WatchState, and no D1, R2, KV, queue, browser or AI binding', () => {
  assert.deepEqual(config.durable_objects, { bindings: [{ name: 'WATCH', class_name: 'WatchState' }] })
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['WatchState'] }])
  for (const key of ['d1_databases', 'r2_buckets', 'kv_namespaces', 'queues', 'browser', 'ai']) assert.equal(config[key], undefined, key)
})

test("one service binding: Todofy's Intents entrypoint for source watch only, the notification sink (task-intent-v1)", () => {
  // Never Ops: that entrypoint also sheds Todofy (setGuard), stores ops reports and accepts any source.
  assert.deepEqual(config.services, [{ binding: 'TODOFY', service: 'todofy', entrypoint: 'Intents', props: { source: 'watch' } }])
})

test('vars: the public host, the Access issuer and the AUD; nothing injected, secret or for development', () => {
  assert.deepEqual(Object.keys(config.vars).sort(), ['ACCESS_AUDIENCE', 'ACCESS_ISSUER', 'PUBLIC_HOST'])
  assert.equal(config.vars.PUBLIC_HOST, 'watch.ziyixi.science')
  assert.match(config.vars.ACCESS_ISSUER, /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/)
  assert.match(config.vars.ACCESS_AUDIENCE, /^[0-9a-f]{64}$/)
  // W2: the AUD of the Access application "watch" (infra/README.md "Adding an app" step 4), never the placeholder.
  assert.notEqual(config.vars.ACCESS_AUDIENCE, '0'.repeat(64), 'fill in the Access AUD of "watch" in watch/wrangler.toml (W2)')
  const names = Object.keys(config.vars)
  for (const { name } of INJECTED) assert.ok(!names.includes(name), name)
  for (const name of names) assert.ok(!name.startsWith('DEV_'), name)
  for (const name of ['ACCESS_OWNER', 'ACCESS_OWNER_ALIASES', 'CSRF_SIGNING_KEY']) assert.ok(!names.includes(name), name)
  assert.ok(!values.includes('@'))
  // No hostname but PUBLIC_HOST's in the config's values.
  assert.deepEqual([...new Set(values.match(/[a-z0-9.-]*ziyixi\.science/g))], ['watch.ziyixi.science'])
})

test('the workerd runtime tests run the committed compatibility date', () => {
  const harness = readFileSync(new URL('worker/test/runtime/harness.ts', APP), 'utf8')
  const dates = [...harness.matchAll(/compatibilityDate:\s*'([^']+)'/g)].map(([, date]) => date)
  assert.ok(dates.length >= 1)
  for (const date of dates) assert.equal(date, config.compatibility_date)
})
