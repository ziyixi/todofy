import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPLACED_KEYS, SHAPE_KEYS, generateConfig, generateSecrets, main, readBase } from '../generate-ci-config.mjs'

// Synthetic values only.
function environment() {
  return {
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    DASHBOARD_PUBLIC_HOST: 'home.example.org',
    DASHBOARD_ACCESS_ISSUER: 'https://example.cloudflareaccess.com',
    DASHBOARD_ACCESS_AUDIENCE: 'b'.repeat(64),
    MAIL_HERO_PUBLIC_HOST: 'mail.example.org',
    TODOFY_PUBLIC_HOST: 'todofy.example.org',
    GITHUB_SHA: 'c'.repeat(40),
    DASHBOARD_ACCESS_OWNER: 'owner@example.org',
    DASHBOARD_ACCESS_OWNER_ALIASES: 'alias@example.org, second@example.net',
    DASHBOARD_CSRF_SIGNING_KEY: 'd'.repeat(64),
    DASHBOARD_CF_ANALYTICS_TOKEN: 'synthetic_analytics-token-0000000000000',
  }
}

const base = await readBase()

test('wrangler.toml has only keys the generator copies or replaces', () => {
  for (const key of Object.keys(base)) assert.ok(SHAPE_KEYS.includes(key) || REPLACED_KEYS.includes(key), key)
  assert.throws(() => generateConfig(environment(), { ...base, d1_databases: [] }), /does not know: d1_databases/)
})

test('the production config keeps the shape and replaces account, route and vars', () => {
  const config = generateConfig(environment(), base)
  for (const key of SHAPE_KEYS) assert.deepEqual(config[key], base[key], key)
  assert.equal(config.name, 'home')
  assert.equal(config.main, 'src/index.ts')
  assert.equal(config.account_id, 'a'.repeat(32))
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.deepEqual(config.routes, [{ pattern: 'home.example.org', custom_domain: true }])
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['HomeState'] }])
  assert.deepEqual(config.durable_objects, { bindings: [{ name: 'HOME', class_name: 'HomeState' }] })
  assert.deepEqual(config.services, [
    { binding: 'MAIL_HERO', service: 'mail-hero', entrypoint: 'Ops' },
    { binding: 'TODOFY', service: 'todofy', entrypoint: 'Ops' },
  ])
  assert.deepEqual(config.triggers, { crons: ['*/30 * * * *'] })
  assert.equal(config.assets.directory, '../web/dist')
  assert.equal(config.assets.run_worker_first, true)
  assert.deepEqual(config.vars, {
    PUBLIC_HOST: 'home.example.org',
    ACCESS_ISSUER: 'https://example.cloudflareaccess.com',
    ACCESS_AUDIENCE: 'b'.repeat(64),
    ACCOUNT_ID: 'a'.repeat(32),
    MAIL_HERO_URL: 'https://mail.example.org/',
    TODOFY_URL: 'https://todofy.example.org/',
    CANARY_UTC_HOUR: '16',
    BUILD_SHA: 'c'.repeat(40),
  })
  const text = JSON.stringify(config)
  for (const secret of ['owner@example.org', 'alias@example.org', 'd'.repeat(64), 'synthetic_analytics-token']) assert.ok(!text.includes(secret), secret)
  assert.ok(!text.includes('DEV_'))
  assert.ok(!('limits' in config))
})

test('the secrets file holds the owner, aliases, CSRF key and analytics token', () => {
  assert.deepEqual(generateSecrets(environment()), {
    ACCESS_OWNER: 'owner@example.org',
    ACCESS_OWNER_ALIASES: 'alias@example.org,second@example.net',
    CSRF_SIGNING_KEY: 'd'.repeat(64),
    CF_ANALYTICS_TOKEN: 'synthetic_analytics-token-0000000000000',
  })
  // An emptied alias list replaces the previous secret with a single space.
  assert.equal(generateSecrets({ ...environment(), DASHBOARD_ACCESS_OWNER_ALIASES: '' }).ACCESS_OWNER_ALIASES, ' ')
  assert.equal(generateSecrets({ ...environment(), DASHBOARD_ACCESS_OWNER_ALIASES: undefined }).ACCESS_OWNER_ALIASES, ' ')
})

test('the canary hour is optional and bounded', () => {
  assert.equal(generateConfig({ ...environment(), DASHBOARD_CANARY_UTC_HOUR: '' }, base).vars.CANARY_UTC_HOUR, '16')
  assert.equal(generateConfig({ ...environment(), DASHBOARD_CANARY_UTC_HOUR: '0' }, base).vars.CANARY_UTC_HOUR, '0')
  assert.equal(generateConfig({ ...environment(), DASHBOARD_CANARY_UTC_HOUR: '23' }, base).vars.CANARY_UTC_HOUR, '23')
  for (const hour of ['24', '-1', '07', '1.5', ' 3']) {
    assert.throws(() => generateConfig({ ...environment(), DASHBOARD_CANARY_UTC_HOUR: hour }, base), /DASHBOARD_CANARY_UTC_HOUR/)
  }
})

test('invalid or missing settings fail by name, before anything is written', () => {
  const configCases = [
    ['CLOUDFLARE_ACCOUNT_ID', undefined], ['CLOUDFLARE_ACCOUNT_ID', 'x'.repeat(32)],
    ['DASHBOARD_PUBLIC_HOST', 'https://home.example.org/'], ['DASHBOARD_PUBLIC_HOST', 'Home.Example.org'],
    ['DASHBOARD_PUBLIC_HOST', 'mail.example.org'], ['DASHBOARD_PUBLIC_HOST', 'todofy.example.org'],
    ['DASHBOARD_ACCESS_ISSUER', 'https://example.cloudflareaccess.com/'], ['DASHBOARD_ACCESS_ISSUER', 'https://evil.example.com'],
    ['DASHBOARD_ACCESS_AUDIENCE', 'b'.repeat(63)], ['MAIL_HERO_PUBLIC_HOST', undefined], ['TODOFY_PUBLIC_HOST', 'todofy'],
    ['GITHUB_SHA', 'main'], ['GITHUB_SHA', undefined],
  ]
  for (const [name, value] of configCases) {
    assert.throws(() => generateConfig({ ...environment(), [name]: value }, base), new RegExp(`CI setting: ${name}$`), `${name}=${value}`)
  }
  const secretCases = [
    ['DASHBOARD_ACCESS_OWNER', undefined], ['DASHBOARD_ACCESS_OWNER', 'not-an-email'],
    ['DASHBOARD_ACCESS_OWNER', 'Kate@example.org'], ['DASHBOARD_ACCESS_OWNER', 'ownér@example.org'],
    ['DASHBOARD_ACCESS_OWNER', ' owner@example.org'],
    ['DASHBOARD_ACCESS_OWNER_ALIASES', 'alias@example.org\ninjected'], ['DASHBOARD_ACCESS_OWNER_ALIASES', 'alias@example.org,Kim@example.net'],
    ['DASHBOARD_ACCESS_OWNER_ALIASES', 'a@example.org,a@example.org'],
    ['DASHBOARD_ACCESS_OWNER_ALIASES', Array.from({ length: 9 }, (_, i) => `a${i}@example.org`).join(',')],
    ['DASHBOARD_ACCESS_OWNER_ALIASES', Array.from({ length: 8 }, (_, i) => `${'x'.repeat(300)}${i}@example.org`).join(',')],
    ['DASHBOARD_CSRF_SIGNING_KEY', 'd'.repeat(63)], ['DASHBOARD_CSRF_SIGNING_KEY', undefined],
    ['DASHBOARD_CF_ANALYTICS_TOKEN', undefined], ['DASHBOARD_CF_ANALYTICS_TOKEN', 'short'], ['DASHBOARD_CF_ANALYTICS_TOKEN', 'token with spaces 000000000'],
  ]
  for (const [name, value] of secretCases) {
    assert.throws(() => generateSecrets({ ...environment(), [name]: value }), new RegExp(`CI setting: ${name}$`), name)
  }
})

test('main writes both files 0600, never overwrites, never prints values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-generator-'))
  const outputs = { config: join(dir, 'config.json'), secrets: join(dir, 'secrets.json') }
  const printed = []
  const original = { log: console.log, error: console.error }
  console.log = (...args) => printed.push(args.join(' '))
  console.error = (...args) => printed.push(args.join(' '))
  try {
    assert.equal(await main(environment(), outputs), 0)
    assert.equal(statSync(outputs.config).mode & 0o777, 0o600)
    assert.equal(statSync(outputs.secrets).mode & 0o777, 0o600)
    assert.equal(JSON.parse(readFileSync(outputs.secrets, 'utf8')).ACCESS_OWNER, 'owner@example.org')
    assert.equal(JSON.parse(readFileSync(outputs.config, 'utf8')).name, 'home')

    // Existing files are kept.
    writeFileSync(outputs.config, 'local')
    assert.equal(await main(environment(), outputs), 1)
    assert.equal(readFileSync(outputs.config, 'utf8'), 'local')

    // An invalid secret leaves nothing behind.
    rmSync(outputs.config)
    rmSync(outputs.secrets)
    assert.equal(await main({ ...environment(), DASHBOARD_CSRF_SIGNING_KEY: 'bad' }, outputs), 1)
    assert.ok(!existsSync(outputs.config))
    assert.ok(!existsSync(outputs.secrets))

    // The config was written but the secrets file exists: the new config is removed again.
    writeFileSync(outputs.secrets, 'local')
    assert.equal(await main(environment(), outputs), 1)
    assert.ok(!existsSync(outputs.config))
    assert.equal(readFileSync(outputs.secrets, 'utf8'), 'local')
  } finally {
    console.log = original.log
    console.error = original.error
    rmSync(dir, { recursive: true, force: true })
  }
  const text = printed.join('\n')
  assert.match(text, /values were not printed/)
  assert.match(text, /Invalid or missing CI setting: DASHBOARD_CSRF_SIGNING_KEY/)
  for (const value of Object.values(environment())) assert.ok(!text.includes(value), 'printed a value')
})
