// Read the sole production config with the same pinned Wrangler that CI deploys.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseToml } from '../../../tools/cf-guard/toml.mjs'
import { CONFIG, INJECTED, generateSecrets } from '../deploy-vars.mjs'
import { homeURLFromConfig, navigationFromConfig, validateHomeURL, validateNavigationURL } from '../public-navigation.mjs'

const APP = new URL('../../', import.meta.url)
const require = createRequire(new URL('worker/package.json', APP))
const wrangler = await import(pathToFileURL(require.resolve('wrangler')).href)
const config = JSON.parse(JSON.stringify(wrangler.experimental_readRawConfig({ config: CONFIG }).rawConfig))
const profile = parseToml(readFileSync(new URL('../config/cloud.toml', APP), 'utf8'))
const resources = parseToml(readFileSync(new URL('../config/resources.toml', APP), 'utf8'))
const values = readFileSync(CONFIG, 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')

test('the sole production Worker has one exact public host and sends all assets through authentication', () => {
  const keys = ['name', 'account_id', 'main', 'compatibility_date', 'workers_dev', 'preview_urls',
    'routes', 'assets', 'observability', 'vars']
  assert.deepEqual(Object.keys(config).sort(), keys.sort())
  assert.equal(config.name, 'newsletter-console')
  assert.equal(config.account_id, resources.account_id)
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.deepEqual(config.routes, [{ pattern: `news.${profile.zone}`, custom_domain: true }])
  assert.equal(config.main, 'worker/src/index.ts')
  assert.ok(existsSync(new URL(config.main, APP)))
  assert.deepEqual(config.assets, {
    directory: 'web/dist', binding: 'ASSETS', run_worker_first: true,
    not_found_handling: 'single-page-application',
  })
  // Explicit log lines only: an invocation log would record every request's URL.
  assert.deepEqual(config.observability, { enabled: true, logs: { enabled: true, invocation_logs: false }, traces: { enabled: false } })
})

test('the console stores nothing: Newsletter\'s SQLite database is the record', () => {
  for (const key of ['durable_objects', 'migrations', 'triggers', 'services', 'd1_databases', 'r2_buckets', 'kv_namespaces', 'queues', 'ai']) {
    assert.equal(config[key], undefined, key)
  }
})

test('public vars match the profile, and an activated AUD must be the recorded real identity', () => {
  const keys = ['ACCESS_ISSUER', 'FLEET_URL', 'HOME_URL', 'MODEL_ROUTER_URL', 'NEWSLETTER_ORIGIN', 'PUBLIC_HOST']
  if (config.vars.ACCESS_AUDIENCE !== undefined) keys.push('ACCESS_AUDIENCE')
  assert.deepEqual(Object.keys(config.vars).sort(), keys.sort())
  assert.equal(config.vars.PUBLIC_HOST, `news.${profile.zone}`)
  assert.equal(config.vars.ACCESS_ISSUER, profile.access_issuer)
  assert.equal(config.vars.NEWSLETTER_ORIGIN, `https://${profile.vps.platform_runtime_host}`)
  assert.equal(config.vars.HOME_URL, `https://home.${profile.zone}/`)
  assert.equal(config.vars.FLEET_URL, `https://fleet.${profile.zone}/`)
  assert.equal(config.vars.MODEL_ROUTER_URL, `https://models.${profile.zone}/`)
  assert.equal(config.vars.ACCESS_AUDIENCE, resources.access_audiences['newsletter-console'])
  if (config.vars.ACCESS_AUDIENCE !== undefined) {
    assert.match(config.vars.ACCESS_AUDIENCE, /^[0-9a-f]{64}$/)
    assert.notEqual(config.vars.ACCESS_AUDIENCE, '0'.repeat(64))
  }
})

test('the navigation links are declared HTTPS origins, not UI source', () => {
  assert.equal(homeURLFromConfig(), config.vars.HOME_URL)
  assert.deepEqual(navigationFromConfig(), { HOME_URL: config.vars.HOME_URL, FLEET_URL: config.vars.FLEET_URL, MODEL_ROUTER_URL: config.vars.MODEL_ROUTER_URL })
  assert.throws(() => validateNavigationURL('FLEET_URL', 'http://fleet.example.test/'), /Newsletter console FLEET_URL/)
  assert.equal(validateHomeURL('https://home.example.test/'), 'https://home.example.test/')
  for (const value of [undefined, '', 'javascript:alert(1)', 'http://home.example.test/', 'https://127.0.0.1/', 'https://user:secret@home.example.test/', 'https://home.example.test/path', 'https://home.example.test/?token=x']) {
    assert.throws(() => validateHomeURL(value), /Newsletter console HOME_URL/)
  }
})

test('private inputs, source identity and every declared development bypass stay out of production vars', () => {
  const declared = [...readFileSync(new URL('worker/src/env.ts', APP), 'utf8')
    .matchAll(/readonly (DEV_[A-Z0-9_]+)\?:/g)].map(([, name]) => name)
  assert.deepEqual(declared.sort(), ['DEV_AUTH_BYPASS'])
  const secrets = generateSecrets({
    NEWSLETTER_CONSOLE_ACCESS_OWNER: 'owner@example.com', NEWSLETTER_CONSOLE_ACCESS_OWNER_ALIASES: '', DEV_AUTH_BYPASS: 'true',
  })
  assert.deepEqual(Object.keys(secrets).sort(), ['ACCESS_OWNER', 'ACCESS_OWNER_ALIASES'])
  for (const name of [...Object.keys(secrets), ...INJECTED.map(({ name }) => name), ...declared]) {
    assert.ok(!Object.hasOwn(config.vars, name), name)
  }
  assert.ok(!/\bDEV_[A-Z0-9_]+/.test(values))
  assert.ok(!values.includes('@'), 'no personal address in committed values')
})

test('real workerd fixtures exercise the production compatibility date', () => {
  const harness = readFileSync(new URL('worker/test/runtime/harness.ts', APP), 'utf8')
  const dates = [...harness.matchAll(/compatibilityDate:\s*'([^']+)'/g)].map(([, date]) => date)
  assert.ok(dates.length > 0)
  for (const date of dates) assert.equal(date, config.compatibility_date)
})
