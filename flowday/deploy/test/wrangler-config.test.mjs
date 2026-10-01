// The committed production config ../../wrangler.toml, read with the pinned wrangler's own raw-config reader
// (worker/node_modules): the shape the Worker "flowday" needs, nothing personal or injected, the real D1 id and
// Access AUD (F2), and exactly one hostname, the production Custom Domain (since the F4 cutover).
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
const KEYS = ['name', 'account_id', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'routes', 'observability', 'assets', 'd1_databases', 'vars']
// The production host (F4), taken over from the old container; the F3 staging host is gone.
const HOST = 'flowday.ziyixi.science'

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

test('exactly one hostname, the production Custom Domain (F4), and PUBLIC_HOST names it', () => {
  assert.deepEqual(config.routes, [{ pattern: HOST, custom_domain: true }])
  assert.equal(config.route, undefined)
  assert.equal(config.vars.PUBLIC_HOST, HOST)
  // No other hostname anywhere in the config's values (comments may name the staging host).
  const values = readFileSync(CONFIG, 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
  const hosts = new Set(values.match(/[a-z0-9.-]*ziyixi\.science/g))
  assert.deepEqual([...hosts], [HOST])
})

test('entry, static assets (the Next.js export) and the D1 binding with the real database id (F2)', () => {
  assert.equal(config.main, 'worker/src/index.ts')
  assert.ok(existsSync(new URL(config.main, APP)))
  assert.deepEqual(config.assets, { directory: 'web/out', binding: 'ASSETS', run_worker_first: true, not_found_handling: 'single-page-application' })
  assert.equal(config.d1_databases.length, 1)
  const { database_id: id, ...database } = config.d1_databases[0]
  assert.deepEqual(database, { binding: 'DB', database_name: 'flowday', migrations_dir: 'migrations' })
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.notEqual(id, '00000000-0000-0000-0000-000000000000')
  assert.ok(existsSync(new URL('migrations/0001_init.sql', APP)))
})

test('vars: the production host, the public Access issuer and the real AUD; nothing injected, secret or for development', () => {
  assert.deepEqual(Object.keys(config.vars).sort(), ['ACCESS_AUDIENCE', 'ACCESS_ISSUER', 'PUBLIC_HOST'])
  assert.match(config.vars.ACCESS_ISSUER, /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/)
  assert.match(config.vars.ACCESS_AUDIENCE, /^[0-9a-f]{64}$/)
  assert.notEqual(config.vars.ACCESS_AUDIENCE, '0'.repeat(64))
  // The same Access team (issuer) as the other Workers.
  assert.equal(config.vars.ACCESS_ISSUER, wrangler.experimental_readRawConfig({ config: new URL('../lab/wrangler.toml', APP).pathname }).rawConfig.vars.ACCESS_ISSUER)
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
