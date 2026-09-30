// The committed production config ../../wrangler.toml, read with the pinned wrangler's own raw-config
// reader (worker/node_modules): the shape the Worker "lab" needs, and nothing personal or injected.
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

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
// Every key the Worker "lab" uses; a new one must be added here on purpose (and checked below).
const KEYS = ['name', 'account_id', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'routes', 'observability',
  'assets', 'durable_objects', 'migrations', 'd1_databases', 'services', 'ai', 'vars']

test('the top level is the production Worker, with only known keys and no cron', () => {
  assert.deepEqual(Object.keys(config).sort(), [...KEYS].sort())
  assert.equal(config.name, 'lab')
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.deepEqual(config.observability, { enabled: true })
  // LabState schedules itself with setAlarm(); the account's Free cron slots stay untouched.
  assert.equal(config.triggers, undefined)
})

test('entry and assets resolve from the lab root', () => {
  assert.equal(config.main, 'worker/src/index.ts')
  assert.ok(existsSync(new URL(config.main, APP)))
  assert.deepEqual(config.assets, { directory: 'web/dist', binding: 'ASSETS', run_worker_first: true, not_found_handling: 'single-page-application' })
})

test('the Durable Object, D1, Workers AI and the one service binding to Todofy', () => {
  assert.deepEqual(config.durable_objects, { bindings: [{ name: 'LAB', class_name: 'LabState' }] })
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['LabState'] }])
  assert.equal(config.d1_databases.length, 1)
  assert.deepEqual({ ...config.d1_databases[0], database_id: '-' }, { binding: 'DB', database_name: 'lab', database_id: '-', migrations_dir: 'migrations' })
  assert.match(config.d1_databases[0].database_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.notEqual(config.d1_databases[0].database_id, '00000000-0000-0000-0000-000000000000')
  assert.ok(existsSync(new URL('migrations/0001_init.sql', APP)))
  assert.deepEqual(config.ai, { binding: 'AI' })
  assert.deepEqual(config.services, [{ binding: 'TODOFY', service: 'todofy', entrypoint: 'Ops' }])
})

test('account, route, Access, the neuron ceiling and the fetch hour', () => {
  const { vars } = config
  assert.deepEqual(Object.keys(vars).sort(), ['ACCESS_AUDIENCE', 'ACCESS_ISSUER', 'LAB_DAILY_NEURONS', 'LAB_FETCH_UTC_HOUR', 'PUBLIC_HOST'])
  assert.match(config.account_id, /^[a-f0-9]{32}$/)
  assert.match(vars.PUBLIC_HOST, DOMAIN)
  assert.deepEqual(config.routes, [{ pattern: vars.PUBLIC_HOST, custom_domain: true }])
  assert.match(vars.ACCESS_ISSUER, /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/)
  assert.match(vars.ACCESS_AUDIENCE, /^[a-f0-9]{64}$/)
  assert.notEqual(vars.ACCESS_AUDIENCE, '0'.repeat(64))
  // The approved ceiling: at most half of the account's 10,000 daily neurons.
  assert.match(vars.LAB_DAILY_NEURONS, /^[0-9]{1,4}$/)
  assert.ok(Number(vars.LAB_DAILY_NEURONS) <= 5000)
  assert.match(vars.LAB_FETCH_UTC_HOUR, /^(?:[0-9]|1[0-9]|2[0-3])$/)
})

test('injected values, secrets and dev switches are never committed', () => {
  const names = Object.keys(config.vars)
  for (const { name } of INJECTED) assert.ok(!names.includes(name), name)
  for (const name of ['ACCESS_OWNER', 'ACCESS_OWNER_ALIASES', 'CSRF_SIGNING_KEY']) assert.ok(!names.includes(name), name)
  assert.deepEqual(names.filter((name) => name.startsWith('DEV_')), [])
  assert.ok(!readFileSync(CONFIG, 'utf8').split('\n').filter((line) => !line.startsWith('#')).join('\n').includes('@'))
})

test('the workerd runtime tests run the committed compatibility date', () => {
  const harness = readFileSync(new URL('worker/test/runtime/harness.ts', APP), 'utf8')
  const dates = [...harness.matchAll(/compatibilityDate:\s*'([^']+)'/g)].map(([, date]) => date)
  assert.ok(dates.length >= 4)
  for (const date of dates) assert.equal(date, config.compatibility_date)
})
