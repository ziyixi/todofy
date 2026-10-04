// Read the sole production config with the same pinned Wrangler that CI deploys.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseToml } from '../../../tools/cf-guard/toml.mjs'
import { CONFIG, INJECTED, generateSecrets } from '../deploy-vars.mjs'
import { homeURLFromConfig, validateHomeURL } from '../public-navigation.mjs'

const APP = new URL('../../', import.meta.url)
const require = createRequire(new URL('worker/package.json', APP))
const wrangler = await import(pathToFileURL(require.resolve('wrangler')).href)
const config = JSON.parse(JSON.stringify(wrangler.experimental_readRawConfig({ config: CONFIG }).rawConfig))
const profile = parseToml(readFileSync(new URL('../config/cloud.toml', APP), 'utf8'))
const resources = parseToml(readFileSync(new URL('../config/resources.toml', APP), 'utf8'))
const values = readFileSync(CONFIG, 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')

test('the sole production Worker has one exact public host and sends all assets through authentication', () => {
  const keys = ['name', 'account_id', 'main', 'compatibility_date', 'workers_dev', 'preview_urls',
    'routes', 'assets', 'durable_objects', 'migrations', 'observability', 'vars']
  assert.deepEqual(Object.keys(config).sort(), keys.sort())
  assert.equal(config.name, 'fleet')
  assert.equal(config.account_id, resources.account_id)
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.deepEqual(config.routes, [{ pattern: profile.platform_hostname, custom_domain: true }])
  assert.equal(config.main, 'worker/src/index.ts')
  assert.ok(existsSync(new URL(config.main, APP)))
  assert.deepEqual(config.assets, {
    directory: 'web/dist', binding: 'ASSETS', run_worker_first: true,
    not_found_handling: 'single-page-application',
  })
})

test('Fleet owns only its SQLite observation object, with no scheduled or business-service bindings', () => {
  assert.deepEqual(config.durable_objects, { bindings: [{ name: 'FLEET', class_name: 'FleetState' }] })
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['FleetState'] }])
  for (const key of ['triggers', 'services', 'd1_databases', 'r2_buckets', 'kv_namespaces', 'queues', 'ai']) {
    assert.equal(config[key], undefined, key)
  }
})

test('public vars match the profile, and an activated AUD must be the recorded real identity', () => {
  const keys = ['ACCESS_ISSUER', 'HOME_URL', 'HOST_EPOCH', 'HOST_KEY', 'PUBLIC_HOST']
  if (config.vars.ACCESS_AUDIENCE !== undefined) keys.push('ACCESS_AUDIENCE')
  assert.deepEqual(Object.keys(config.vars).sort(), keys.sort())
  assert.equal(config.vars.PUBLIC_HOST, profile.platform_hostname)
  assert.equal(config.vars.ACCESS_ISSUER, profile.access_issuer)
  assert.equal(config.vars.HOST_KEY, profile.vps.observer_node_key)
  assert.match(config.vars.HOST_EPOCH, /^[1-9][0-9]*$/)
  assert.equal(config.vars.ACCESS_AUDIENCE, resources.access_audiences.fleet)
  if (config.vars.ACCESS_AUDIENCE !== undefined) {
    assert.match(config.vars.ACCESS_AUDIENCE, /^[0-9a-f]{64}$/)
    assert.notEqual(config.vars.ACCESS_AUDIENCE, '0'.repeat(64))
  }
})

test('the Home navigation link is a declared HTTPS origin, not UI source or observed host data', () => {
  assert.equal(homeURLFromConfig(), config.vars.HOME_URL)
  assert.equal(validateHomeURL('https://home.example.test/'), 'https://home.example.test/')
  for (const value of [undefined, '', 'javascript:alert(1)', 'http://home.example.test/', 'https://127.0.0.1/', 'https://user:secret@home.example.test/', 'https://home.example.test/path', 'https://home.example.test/?token=x']) {
    assert.throws(() => validateHomeURL(value), /Fleet HOME_URL/)
  }
})

test('private inputs, source identity and every declared development bypass stay out of production vars', () => {
  const declared = [...readFileSync(new URL('worker/src/env.ts', APP), 'utf8')
    .matchAll(/readonly (DEV_[A-Z0-9_]+)\?:/g)].map(([, name]) => name)
  assert.deepEqual(declared.sort(), ['DEV_AUTH_BYPASS', 'DEV_NOW'])
  const secrets = generateSecrets({
    FLEET_ACCESS_OWNER: 'owner@example.com', FLEET_ACCESS_OWNER_ALIASES: '',
    FLEET_REPORT_HMAC_KEY: 'a'.repeat(64), DEV_AUTH_BYPASS: 'true', DEV_NOW: 'synthetic',
  })
  assert.deepEqual(Object.keys(secrets).sort(), ['ACCESS_OWNER', 'ACCESS_OWNER_ALIASES', 'REPORT_HMAC_KEY'])
  for (const name of [...Object.keys(secrets), ...INJECTED.map(({ name }) => name), ...declared]) {
    assert.ok(!Object.hasOwn(config.vars, name), name)
  }
  const deployed = [...INJECTED.map(({ name }) => name), ...Object.keys(secrets)]
  for (const name of declared) assert.ok(!deployed.includes(name), name)
  assert.ok(!/\bDEV_[A-Z0-9_]+/.test(values))
  assert.ok(!values.includes('@'), 'no personal address in committed values')
})

test('real workerd fixtures exercise the production compatibility date', () => {
  const harness = readFileSync(new URL('worker/test/runtime/harness.ts', APP), 'utf8')
  const dates = [...harness.matchAll(/compatibilityDate:\s*'([^']+)'/g)].map(([, date]) => date)
  assert.ok(dates.length > 0)
  for (const date of dates) assert.equal(date, config.compatibility_date)
})
