// The committed production config ../../wrangler.toml, read with the pinned wrangler's own raw-config reader
// (worker/node_modules): the shape the Worker "recall" needs, nothing personal or injected, its one Custom Domain, one
// SQLite Durable Object and one private R2 bucket, and no cron, D1, KV, queue, AI or service binding.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { CONFIG, INJECTED, OWNER_ONLY_SECRETS } from '../deploy-vars.mjs'

const APP = new URL('../../', import.meta.url)
const require = createRequire(new URL('worker/package.json', APP))
const wrangler = await import(pathToFileURL(require.resolve('wrangler')).href)
const read = (path) => JSON.parse(JSON.stringify(wrangler.experimental_readRawConfig({ config: path }).rawConfig))
const config = read(CONFIG)
const values = readFileSync(CONFIG, 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')

// Every key the Worker "recall" uses; a new one must be added here on purpose (and checked below).
const KEYS = ['name', 'account_id', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'routes', 'observability', 'assets', 'durable_objects', 'migrations', 'r2_buckets', 'vars']

test('the top level is the production Worker: known keys only, no cron, no workers.dev or preview URL, one Custom Domain', () => {
  assert.deepEqual(Object.keys(config).sort(), [...KEYS].sort())
  assert.equal(config.name, 'recall')
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.equal(config.triggers, undefined)
  assert.deepEqual(config.routes, [{ pattern: 'recall.ziyixi.science', custom_domain: true }])
  assert.match(config.account_id, /^[a-f0-9]{32}$/)
})

test('no request URL reaches a log: invocation logs and traces are off', () => {
  assert.deepEqual(config.observability, { enabled: true, logs: { enabled: true, invocation_logs: false }, traces: { enabled: false } })
})

test('every request reaches the Worker first (the machine tokens, Access, private headers)', () => {
  assert.equal(config.main, 'worker/src/index.ts')
  assert.ok(existsSync(new URL(config.main, APP)))
  assert.deepEqual(config.assets, { directory: 'web/dist', binding: 'ASSETS', run_worker_first: true, not_found_handling: 'single-page-application' })
})

test('one SQLite Durable Object, RecallState, and one private R2 bucket; no D1, KV, queue, AI, browser or service binding', () => {
  assert.deepEqual(config.durable_objects, { bindings: [{ name: 'RECALL', class_name: 'RecallState' }] })
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['RecallState'] }])
  assert.deepEqual(config.r2_buckets, [{ binding: 'STORE', bucket_name: 'recall-store' }])
  for (const key of ['d1_databases', 'kv_namespaces', 'queues', 'ai', 'browser', 'services']) assert.equal(config[key], undefined, key)
})

test('no secret is declared required: the machine tokens live in RecallState, and a deploy keeps any digest put by hand', () => {
  assert.equal(config.secrets, undefined)
  for (const name of OWNER_ONLY_SECRETS) assert.ok(!values.includes(name), name)
})

test('vars: the public host and the Access issuer (and the AUD once Infra apply made it); nothing injected or secret', () => {
  const names = Object.keys(config.vars).sort()
  assert.ok(['ACCESS_ISSUER,PUBLIC_HOST', 'ACCESS_AUDIENCE,ACCESS_ISSUER,PUBLIC_HOST'].includes(names.join()), names.join())
  assert.equal(config.vars.PUBLIC_HOST, 'recall.ziyixi.science')
  assert.match(config.vars.ACCESS_ISSUER, /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/)
  if (config.vars.ACCESS_AUDIENCE !== undefined) {
    assert.match(config.vars.ACCESS_AUDIENCE, /^[0-9a-f]{64}$/)
    assert.notEqual(config.vars.ACCESS_AUDIENCE, '0'.repeat(64))
  }
  for (const { name } of INJECTED) assert.ok(!names.includes(name), name)
  for (const name of names) assert.ok(!name.startsWith('DEV_'), name)
  for (const name of ['ACCESS_OWNER', 'ACCESS_OWNER_ALIASES', 'CSRF_SIGNING_KEY']) assert.ok(!names.includes(name), name)
  assert.ok(!values.includes('@'))
  assert.deepEqual([...new Set(values.match(/[a-z0-9.-]*ziyixi\.science/g))], ['recall.ziyixi.science'])
})

test('the development config is the production one without routes, account and secrets: never deployable', () => {
  const dev = read(new URL('wrangler.test.toml', APP).pathname)
  assert.equal(dev.name, 'recall')
  assert.equal(dev.routes, undefined)
  assert.equal(dev.account_id, undefined)
  assert.deepEqual(dev.durable_objects, config.durable_objects)
  assert.deepEqual(dev.migrations, config.migrations)
  assert.deepEqual(dev.r2_buckets, config.r2_buckets)
  assert.equal(dev.compatibility_date, config.compatibility_date)
  assert.ok(!readFileSync(new URL('wrangler.test.toml', APP), 'utf8').includes('ziyixi.science'))
})

test('the workerd runtime tests run the committed compatibility date', () => {
  const harness = readFileSync(new URL('worker/test/runtime/harness.ts', APP), 'utf8')
  const dates = [...harness.matchAll(/COMPATIBILITY_DATE = '([^']+)'/g)].map(([, date]) => date)
  assert.equal(dates.length, 1)
  for (const date of dates) assert.equal(date, config.compatibility_date)
})
