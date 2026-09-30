// The committed production config ../../wrangler.toml, read with the pinned wrangler's own raw-config
// reader (worker/node_modules). These are the static checks the retired CI config generator made on GitHub
// variables and on the shape it copied.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { CONFIG, INJECTED } from '../deploy-vars.mjs'

const APP = new URL('../../', import.meta.url)
const require = createRequire(new URL('worker/package.json', APP))
const wrangler = await import(pathToFileURL(require.resolve('wrangler')).href)
// Plain JSON values (the TOML parser returns null-prototype objects).
const config = JSON.parse(JSON.stringify(wrangler.experimental_readRawConfig({ config: CONFIG }).rawConfig))

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
// Every key the Worker "home" uses; a new one must be added here on purpose (and checked below).
const KEYS = ['name', 'account_id', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'routes', 'observability',
  'assets', 'durable_objects', 'migrations', 'services', 'triggers', 'vars']

test('the top level is the production Worker, with only known keys', () => {
  assert.deepEqual(Object.keys(config).sort(), [...KEYS].sort())
  assert.equal(config.name, 'home')
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.deepEqual(config.observability, { enabled: true })
})

test('entry and assets resolve from the dashboard root', () => {
  assert.equal(config.main, 'worker/src/index.ts')
  assert.ok(existsSync(new URL(config.main, APP)))
  assert.deepEqual(config.assets, { directory: 'web/dist', binding: 'ASSETS', run_worker_first: true, not_found_handling: 'single-page-application' })
})

test('the Durable Object, the Ops service bindings and the one cron', () => {
  assert.deepEqual(config.durable_objects, { bindings: [{ name: 'HOME', class_name: 'HomeState' }] })
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['HomeState'] }])
  assert.deepEqual(config.services, [
    { binding: 'MAIL_HERO', service: 'mail-hero', entrypoint: 'Ops' },
    { binding: 'TODOFY', service: 'todofy', entrypoint: 'Ops' },
  ])
  assert.deepEqual(config.triggers, { crons: ['*/30 * * * *'] })
})

test('account, route, Access and the canary hour', () => {
  const { vars } = config
  assert.deepEqual(Object.keys(vars).sort(), ['ACCESS_AUDIENCE', 'ACCESS_ISSUER', 'ACCOUNT_ID', 'CANARY_UTC_HOUR', 'PUBLIC_HOST'])
  assert.match(config.account_id, /^[a-f0-9]{32}$/)
  assert.equal(vars.ACCOUNT_ID, config.account_id)
  assert.match(vars.PUBLIC_HOST, DOMAIN)
  assert.deepEqual(config.routes, [{ pattern: vars.PUBLIC_HOST, custom_domain: true }])
  assert.match(vars.ACCESS_ISSUER, /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/)
  assert.match(vars.ACCESS_AUDIENCE, /^[a-f0-9]{64}$/)
  assert.match(vars.CANARY_UTC_HOUR, /^(?:[0-9]|1[0-9]|2[0-3])$/)
})

test('injected values, secrets and dev switches are never committed', () => {
  const names = Object.keys(config.vars)
  for (const { name } of INJECTED) assert.ok(!names.includes(name), name)
  for (const name of ['ACCESS_OWNER', 'ACCESS_OWNER_ALIASES', 'CSRF_SIGNING_KEY', 'CF_ANALYTICS_TOKEN']) assert.ok(!names.includes(name), name)
  assert.deepEqual(names.filter((name) => name.startsWith('DEV_')), [])
  assert.ok(!readFileSync(CONFIG, 'utf8').split('\n').filter((line) => !line.startsWith('#')).join('\n').includes('@'))
})

test('the workerd runtime tests run the committed compatibility date', () => {
  const harness = readFileSync(new URL('worker/test/runtime/harness.ts', APP), 'utf8')
  const dates = [...harness.matchAll(/compatibilityDate:\s*'([^']+)'/g)].map(([, date]) => date)
  assert.ok(dates.length >= 3)
  for (const date of dates) assert.equal(date, config.compatibility_date)
})
