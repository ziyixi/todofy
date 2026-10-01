// The committed production config ../../wrangler.toml, read with the pinned wrangler's own raw-config reader
// (worker/node_modules): the shape the Worker "links" needs, nothing personal or injected, and, since L2 (the first
// deploy), the real D1 id and Access AUD and exactly one hostname, the Custom Domain s.ziyixi.science. The assets
// settings are what keeps every short link reaching the Worker: run_worker_first for everything but the launcher's
// hashed files, and no single-page fallback.
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
// The one hostname (L2): the short links and, under /_/, the launcher behind the path-scoped Access app "links".
const HOST = 's.ziyixi.science'

// Every key the Worker "links" uses; a new one must be added here on purpose (and checked below).
const KEYS = ['name', 'account_id', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'routes', 'observability', 'assets', 'd1_databases', 'vars']

test('the top level is the production Worker: known keys only, no cron, no workers.dev or preview URL', () => {
  assert.deepEqual(Object.keys(config).sort(), [...KEYS].sort())
  assert.equal(config.name, 'links')
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.equal(config.triggers, undefined)
  // The account every Worker shares (.github/scripts/test_wrangler_configs.py compares it across the apps).
  assert.match(config.account_id, /^[a-f0-9]{32}$/)
})

test('no request URL reaches a log: invocation logs and traces are off', () => {
  assert.deepEqual(config.observability, { enabled: true, logs: { enabled: true, invocation_logs: false }, traces: { enabled: false } })
})

test('every path but the launcher files reaches the Worker, and the asset layer never answers a key with the page', () => {
  assert.equal(config.main, 'worker/src/index.ts')
  assert.ok(existsSync(new URL(config.main, APP)))
  assert.deepEqual(config.assets, { directory: 'web/dist', binding: 'ASSETS', run_worker_first: ['/*', '!/_/assets/*'] })
  assert.equal(config.assets.not_found_handling, undefined)
  assert.equal(config.assets.html_handling, undefined)
})

test('exactly one hostname since L2, the Custom Domain s.ziyixi.science, and PUBLIC_HOST names it', () => {
  assert.deepEqual(config.routes, [{ pattern: HOST, custom_domain: true }])
  assert.equal(config.route, undefined)
  assert.equal(config.vars.PUBLIC_HOST, HOST)
  // No other hostname anywhere in the config's values.
  assert.deepEqual([...new Set(values.match(/[a-z0-9.-]*ziyixi\.science/g))], [HOST])
})

test('D1 with the real database id (L2), and its migrations', () => {
  assert.deepEqual(config.d1_databases, [{ binding: 'DB', database_name: 'links', database_id: '2f8c5331-06ce-4347-8c0a-90fe51c82260', migrations_dir: 'migrations' }])
  assert.ok(existsSync(new URL('migrations/0001_init.sql', APP)))
})

test('vars: the public host, the Access issuer and the AUD of the Access app "links"; nothing injected, secret or for development', () => {
  assert.deepEqual(Object.keys(config.vars).sort(), ['ACCESS_AUDIENCE', 'ACCESS_ISSUER', 'PUBLIC_HOST'])
  assert.match(config.vars.ACCESS_ISSUER, /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/)
  assert.match(config.vars.ACCESS_AUDIENCE, /^[0-9a-f]{64}$/)
  assert.notEqual(config.vars.ACCESS_AUDIENCE, '0'.repeat(64))
  const names = Object.keys(config.vars)
  for (const { name } of INJECTED) assert.ok(!names.includes(name), name)
  for (const name of ['ACCESS_OWNER', 'ACCESS_OWNER_ALIASES', 'CSRF_SIGNING_KEY', 'DEV_AUTH_BYPASS']) assert.ok(!names.includes(name), name)
  assert.ok(!values.includes('@'))
})

test('the workerd runtime tests run the committed compatibility date', () => {
  const harness = readFileSync(new URL('worker/test/runtime/harness.ts', APP), 'utf8')
  const dates = [...harness.matchAll(/compatibilityDate:\s*'([^']+)'/g)].map(([, date]) => date)
  assert.ok(dates.length >= 1)
  for (const date of dates) assert.equal(date, config.compatibility_date)
})
