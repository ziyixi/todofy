// The committed production config ../../wrangler.toml, read with the pinned wrangler's own raw-config reader
// (worker/node_modules): the shape the Worker "flowday" needs, nothing personal or injected, and, before F2, no
// route, no hostname and the all-zeros placeholders.
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

// Every key the Worker "flowday" uses; a new one must be added here on purpose (and checked below).
const KEYS = ['name', 'account_id', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'observability', 'assets', 'd1_databases', 'vars']

test('the top level is the production Worker: known keys only, no cron, no workers.dev or preview URL', () => {
  assert.deepEqual(Object.keys(config).sort(), [...KEYS].sort())
  assert.equal(config.name, 'flowday')
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.deepEqual(config.observability, { enabled: true })
  assert.equal(config.triggers, undefined)
  assert.match(config.account_id, /^[a-f0-9]{32}$/)
  // The same account as the other Workers.
  assert.equal(config.account_id, wrangler.experimental_readRawConfig({ config: new URL('../lab/wrangler.toml', APP).pathname }).rawConfig.account_id)
})

test('no route and no hostname before the F4 cutover commit', () => {
  assert.equal(config.routes, undefined)
  assert.equal(config.route, undefined)
  assert.ok(!/ziyixi\.science/.test(readFileSync(CONFIG, 'utf8').split('\n').filter((line) => !line.startsWith('#')).join('\n')))
})

test('entry, static assets (the Next.js export) and the D1 binding with the placeholder id until F2', () => {
  assert.equal(config.main, 'worker/src/index.ts')
  assert.ok(existsSync(new URL(config.main, APP)))
  assert.deepEqual(config.assets, { directory: 'web/out', binding: 'ASSETS', run_worker_first: true, not_found_handling: 'single-page-application' })
  assert.deepEqual(config.d1_databases, [{ binding: 'DB', database_name: 'flowday', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: 'migrations' }])
  assert.ok(existsSync(new URL('migrations/0001_init.sql', APP)))
})

test('vars: the public Access issuer and the AUD placeholder; nothing injected, secret or for development', () => {
  assert.deepEqual(Object.keys(config.vars).sort(), ['ACCESS_AUDIENCE', 'ACCESS_ISSUER'])
  assert.match(config.vars.ACCESS_ISSUER, /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/)
  assert.equal(config.vars.ACCESS_AUDIENCE, '0'.repeat(64))
  const names = Object.keys(config.vars)
  for (const { name } of INJECTED) assert.ok(!names.includes(name), name)
  for (const name of ['ACCESS_OWNER', 'ACCESS_OWNER_ALIASES', 'CSRF_SIGNING_KEY', 'CREDENTIAL_KEY', 'DEV_AUTH_BYPASS', 'E2E_TEST_ROUTES']) assert.ok(!names.includes(name), name)
  assert.ok(!readFileSync(CONFIG, 'utf8').split('\n').filter((line) => !line.startsWith('#')).join('\n').includes('@'))
})

test('the workerd runtime tests run the committed compatibility date', () => {
  const harness = readFileSync(new URL('worker/test/runtime/harness.ts', APP), 'utf8')
  const dates = [...harness.matchAll(/compatibilityDate:\s*'([^']+)'/g)].map(([, date]) => date)
  assert.ok(dates.length >= 1)
  for (const date of dates) assert.equal(date, config.compatibility_date)
})
