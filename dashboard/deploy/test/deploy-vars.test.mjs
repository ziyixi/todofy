import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG, INJECTED, SettingError, deployTokenReused, generateSecrets, injectedVars, refusal, run, wranglerArgs } from '../deploy-vars.mjs'

const WRAPPER = fileURLToPath(new URL('../deploy-vars.mjs', import.meta.url))
const WORKER = fileURLToPath(new URL('../../worker/', import.meta.url))

// Synthetic values only.
function environment() {
  return {
    GITHUB_SHA: 'c'.repeat(40),
    DASHBOARD_CANARY_ENABLED: 'true',
    DASHBOARD_ACCESS_OWNER: 'owner@example.org',
    DASHBOARD_ACCESS_OWNER_ALIASES: 'alias@example.org, second@example.net',
    DASHBOARD_CSRF_SIGNING_KEY: 'd'.repeat(64),
    DASHBOARD_CF_ANALYTICS_TOKEN: 'synthetic_analytics-token-0000000000000',
  }
}

test('the marker lists every input of each mode', () => {
  const marked = {}
  for (const [, mode, names] of readFileSync(WRAPPER, 'utf8').matchAll(/^\/\/ deploy-vars-inputs (\w+): (.+)$/gm)) {
    marked[mode] = [...(marked[mode] ?? []), ...names.split(' ')]
  }
  assert.deepEqual(marked, {
    exec: INJECTED.map(({ from }) => from),
    secrets: ['DASHBOARD_ACCESS_OWNER', 'DASHBOARD_ACCESS_OWNER_ALIASES', 'DASHBOARD_CSRF_SIGNING_KEY', 'DASHBOARD_CF_ANALYTICS_TOKEN'],
  })
})

test('the build and the canary switch become --var flags', () => {
  assert.deepEqual(injectedVars(environment()), { CANARY_ENABLED: 'true', BUILD_SHA: 'c'.repeat(40) })
  assert.deepEqual(wranglerArgs({ ...environment(), DASHBOARD_CANARY_ENABLED: 'false' }), [
    '--var', 'CANARY_ENABLED:false', '--var', `BUILD_SHA:${'c'.repeat(40)}`,
  ])
})

test('the canary switch: exactly true or false; unset, empty or anything else is refused', () => {
  assert.equal(injectedVars({ ...environment(), DASHBOARD_CANARY_ENABLED: 'true' }).CANARY_ENABLED, 'true')
  assert.equal(injectedVars({ ...environment(), DASHBOARD_CANARY_ENABLED: 'false' }).CANARY_ENABLED, 'false')
  // An empty value is a deleted or renamed GitHub variable: it must not turn stopped canaries back on.
  for (const value of ['', 'False', 'TRUE', '0', '1', 'no', 'off', ' false', 'false ', 'false\n', 'yes', undefined]) {
    const env = { ...environment(), DASHBOARD_CANARY_ENABLED: value }
    if (value === undefined) delete env.DASHBOARD_CANARY_ENABLED
    assert.throws(() => injectedVars(env), /deploy setting: DASHBOARD_CANARY_ENABLED$/, JSON.stringify(value))
  }
})

test('the build must be the 40-hex commit', () => {
  for (const value of ['main', 'C'.repeat(40), 'c'.repeat(39), '', undefined]) {
    const env = { ...environment(), GITHUB_SHA: value }
    if (value === undefined) delete env.GITHUB_SHA
    assert.throws(() => injectedVars(env), /deploy setting: GITHUB_SHA$/, JSON.stringify(value))
  }
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
  const cases = [
    ['DASHBOARD_ACCESS_OWNER', undefined], ['DASHBOARD_ACCESS_OWNER', 'not-an-email'],
    ['DASHBOARD_ACCESS_OWNER', '\u212aate@example.org'], ['DASHBOARD_ACCESS_OWNER', 'own\u00e9r@example.org'],
    ['DASHBOARD_ACCESS_OWNER', ' owner@example.org'],
    ['DASHBOARD_ACCESS_OWNER_ALIASES', undefined],
    ['DASHBOARD_ACCESS_OWNER_ALIASES', 'alias@example.org\ninjected'], ['DASHBOARD_ACCESS_OWNER_ALIASES', 'alias@example.org,\u212aim@example.net'],
    ['DASHBOARD_ACCESS_OWNER_ALIASES', 'a@example.org,a@example.org'],
    ['DASHBOARD_ACCESS_OWNER_ALIASES', Array.from({ length: 9 }, (_, i) => `a${i}@example.org`).join(',')],
    ['DASHBOARD_ACCESS_OWNER_ALIASES', Array.from({ length: 8 }, (_, i) => `${'x'.repeat(300)}${i}@example.org`).join(',')],
    ['DASHBOARD_CSRF_SIGNING_KEY', 'd'.repeat(63)], ['DASHBOARD_CSRF_SIGNING_KEY', undefined],
    ['DASHBOARD_CF_ANALYTICS_TOKEN', undefined], ['DASHBOARD_CF_ANALYTICS_TOKEN', 'short'], ['DASHBOARD_CF_ANALYTICS_TOKEN', 'token with spaces 000000000'],
  ]
  for (const [name, value] of cases) {
    const env = { ...environment(), [name]: value }
    if (value === undefined) delete env[name]
    assert.throws(() => generateSecrets(env), (error) => error instanceof SettingError && error.message === `Invalid or missing deploy setting: ${name}`, name)
  }
})

test('reusing the deploy token as the analytics token is flagged, not refused', () => {
  const token = environment().DASHBOARD_CF_ANALYTICS_TOKEN
  assert.equal(generateSecrets({ ...environment(), CF_API_TOKEN: token }).CF_ANALYTICS_TOKEN, token)
  assert.equal(deployTokenReused({ ...environment(), CF_API_TOKEN: token }), true)
  assert.equal(deployTokenReused({ ...environment(), CF_API_TOKEN: ` ${token}\n` }), true)
  assert.equal(deployTokenReused({ ...environment(), CF_API_TOKEN: 'synthetic-deploy-token-0000000000000000' }), false)
  assert.equal(deployTokenReused({ ...environment(), CF_API_TOKEN: '' }), false)
  assert.equal(deployTokenReused(environment()), false)
  const env = { ...environment(), CF_API_TOKEN: 'synthetic-deploy-token-0000000000000000' }
  assert.ok(!JSON.stringify([injectedVars(env), generateSecrets(env)]).includes('synthetic-deploy-token'))
})

test('only a deploy of dashboard/wrangler.toml, without --env, --keep-vars or its own --var, may run', () => {
  const deploy = ['npx', '--no-install', 'wrangler', 'deploy']
  assert.equal(refusal([...deploy, '--config', '../wrangler.toml', '--secrets-file', '/tmp/s.json'], WORKER), null)
  assert.equal(refusal([...deploy, '--dry-run', '--config=../wrangler.toml'], WORKER), null)
  for (const argv of [
    [], deploy, [...deploy, '--config', 'wrangler.toml'], [...deploy, '--config', '../../mail-hero/wrangler.toml'],
    [...deploy, '--config', '../wrangler.toml', '--env', 'production'], [...deploy, '--config', '../wrangler.toml', '-e', 'x'],
    [...deploy, '--config', '../wrangler.toml', '--keep-vars'], [...deploy, '--config', '../wrangler.toml', '--var', 'BUILD_SHA:x'],
    ['npx', 'wrangler', 'versions', 'deploy', '--config', '../wrangler.toml', '--env=x'],
  ]) assert.notEqual(refusal(argv, WORKER), null, argv.join(' '))
})

test('exec runs the command unchanged plus the --var flags; secrets writes 0600 and never overwrites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-deploy-vars-'))
  try {
    const out = join(dir, 'argv.json')
    const stub = join(dir, 'stub.mjs')
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))\n`)
    const config = relative(WORKER, CONFIG)
    const env = { PATH: process.env.PATH, ...environment() }
    const result = spawnSync(process.execPath, [WRAPPER, 'exec', '--', process.execPath, stub, 'deploy', '--config', config], { cwd: WORKER, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), ['deploy', '--config', config, ...wranglerArgs(environment())])

    const secrets = join(dir, 'secrets.json')
    const written = spawnSync(process.execPath, [WRAPPER, 'secrets', secrets], { env, encoding: 'utf8' })
    assert.equal(written.status, 0, written.stderr)
    assert.equal(statSync(secrets).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(readFileSync(secrets, 'utf8')), generateSecrets(environment()))
    const again = spawnSync(process.execPath, [WRAPPER, 'secrets', secrets], { env, encoding: 'utf8' })
    assert.equal(again.status, 1)
    assert.match(again.stderr, /already exists/)

    const bad = join(dir, 'bad.json')
    const invalid = spawnSync(process.execPath, [WRAPPER, 'secrets', bad], { env: { ...env, DASHBOARD_CSRF_SIGNING_KEY: 'secret-looking-value' }, encoding: 'utf8' })
    assert.equal(invalid.status, 1)
    assert.equal(invalid.stderr.trim(), 'Invalid or missing deploy setting: DASHBOARD_CSRF_SIGNING_KEY')
    assert.ok(!existsSync(bad))

    const printed = [result, written, again, invalid].map(({ stdout, stderr }) => stdout + stderr).join('\n')
    for (const value of Object.values(environment()).filter(Boolean)) assert.ok(!printed.includes(value), 'printed a value')
    assert.ok(!printed.includes('secret-looking-value'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(run(['nonsense'], environment()), 2)
})
