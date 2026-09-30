// The committed production config ../../wrangler.toml, read with the pinned wrangler's own raw-config
// reader. These are the static checks the retired CI config generator made on GitHub variables.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CONFIG, INJECTED } from '../deploy-vars.mjs'

const APP = new URL('../../', import.meta.url)
const CLOUDFLARE = new URL('cloudflare/', APP)
const require = createRequire(new URL('package.json', CLOUDFLARE))
const wrangler = await import(pathToFileURL(require.resolve('wrangler')).href)
// Plain JSON values (the TOML parser returns null-prototype objects).
const config = JSON.parse(JSON.stringify(wrangler.experimental_readRawConfig({ config: CONFIG }).rawConfig))

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
const hosts = (value) => value.split(',')

test('the top level is the production Worker: no environments, no keep_vars, no dev switches', () => {
  assert.equal(config.name, 'mail-hero')
  assert.equal('env' in config, false)
  assert.equal('keep_vars' in config, false)
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.deepEqual(config.observability, { enabled: false })
  assert.equal('limits' in config, false, 'Workers Free: no paid cpu_ms setting')
  assert.equal('triggers' in config, false, 'the Durable Object alarm schedules all work')
  assert.deepEqual(Object.keys(config.vars).filter((name) => name.startsWith('DEV_')), [])
})

test('entry, migrations and assets resolve from the app root', () => {
  assert.equal(config.main, 'cloudflare/src/native/index.ts')
  assert.ok(existsSync(new URL(config.main, APP)))
  const [database] = config.d1_databases
  assert.equal(database.migrations_dir, 'cloudflare/migrations')
  assert.ok(readdirSync(new URL(`${database.migrations_dir}/`, APP)).some((name) => name.endsWith('.sql')))
  assert.deepEqual(config.assets, { directory: 'uiassets/dist', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true })
})

test('personal values and operational switches are never committed', () => {
  const injected = INJECTED.map(({ name }) => name)
  assert.deepEqual(Object.keys(config.vars).filter((name) => injected.includes(name)), [])
  for (const name of ['RECEIVE_ADDRESS', 'ACCESS_OWNER', 'ACCESS_OWNER_ALIASES', 'CREDENTIAL_KEY', 'ALERT_WEBHOOK_TOKEN', 'BACKUP_TOKEN']) {
    assert.equal(name in config.vars, false, name)
  }
  // No address of any kind in the public file.
  assert.ok(!readFileSync(CONFIG, 'utf8').split('\n').filter((line) => !line.startsWith('#')).join('\n').includes('@'))
})

test('account, database, buckets and the Durable Object', () => {
  assert.match(config.account_id, /^[a-f0-9]{32}$/)
  const [database, ...otherDatabases] = config.d1_databases
  assert.deepEqual(otherDatabases, [])
  assert.equal(database.binding, 'DB')
  assert.match(database.database_name, /^[a-zA-Z0-9_-]{1,63}$/)
  assert.match(database.database_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.deepEqual(config.r2_buckets.map(({ binding }) => binding), ['MAIL_STORE', 'BACKUP_STORE'])
  for (const { bucket_name: bucket } of config.r2_buckets) assert.match(bucket, BUCKET)
  assert.equal(new Set(config.r2_buckets.map(({ bucket_name: bucket }) => bucket)).size, 2)
  assert.deepEqual(config.durable_objects, { bindings: [{ name: 'COORDINATOR', class_name: 'MailCoordinator' }] })
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['MailCoordinator'] }])
})

test('Access, the owner host and the webhook hosts', () => {
  const { vars } = config
  assert.match(vars.ACCESS_ISSUER, /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/)
  assert.match(vars.ACCESS_AUDIENCE, /^[a-f0-9]{64}$/)
  assert.match(vars.PUBLIC_HOST, DOMAIN)
  // The one route is the owner UI's custom domain, the host ops-v1 status() links to.
  assert.deepEqual(config.routes, [{ pattern: vars.PUBLIC_HOST, custom_domain: true }])
  assert.ok(hosts(vars.WEBHOOK_ALLOWED_HOSTS).length >= 1)
  for (const host of hosts(vars.WEBHOOK_ALLOWED_HOSTS)) assert.match(host, DOMAIN)
})

test('the optional alert webhook, when configured, is an exact credential-free HTTPS URL on an allowed host', () => {
  const { vars } = config
  if (!('ALERT_WEBHOOK_URL' in vars)) {
    assert.equal('ALERT_WEBHOOK_ALLOWED_HOSTS' in vars, false)
    return
  }
  const url = new URL(vars.ALERT_WEBHOOK_URL)
  assert.equal(url.protocol, 'https:')
  assert.equal(url.username + url.password + url.hash, '')
  assert.ok(url.port === '' || url.port === '443')
  for (const host of hosts(vars.ALERT_WEBHOOK_ALLOWED_HOSTS)) assert.match(host, DOMAIN)
  assert.ok(hosts(vars.ALERT_WEBHOOK_ALLOWED_HOSTS).includes(url.hostname))
})

test('the daily ingest limits are bounded positive integers', () => {
  for (const [name, maximum] of [['INGEST_DAILY_MESSAGE_LIMIT', 100000], ['INGEST_DAILY_BYTE_LIMIT', 10737418240]]) {
    assert.match(config.vars[name], /^[1-9][0-9]*$/, name)
    assert.ok(Number(config.vars[name]) <= maximum, name)
  }
})

test('the workerd tests run the committed compatibility date', () => {
  assert.match(config.compatibility_date, /^\d{4}-\d{2}-\d{2}$/)
  const tests = new URL('test/', CLOUDFLARE)
  let files = 0
  for (const name of readdirSync(tests).filter((file) => file.endsWith('.mjs'))) {
    for (const [, date] of readFileSync(new URL(name, tests), 'utf8').matchAll(/compatibilityDate\s*:\s*'([^']+)'/g)) {
      assert.equal(date, config.compatibility_date, name)
      files += 1
    }
  }
  assert.ok(files >= 8, 'every Miniflare runtime test names the date')
})

test('the admin helper targets the committed account', () => {
  const admin = readFileSync(new URL('deploy/cloudflare-admin.py', APP), 'utf8')
  assert.equal(admin.match(/^ACCOUNT = "([0-9a-f]{32})"$/m)?.[1], config.account_id)
  assert.equal(fileURLToPath(new URL('wrangler.toml', APP)), CONFIG)
})
