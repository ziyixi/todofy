import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG, INJECTED, SettingError, generateSecrets, injectedVars, placeholderIn, refusal, wranglerArgs } from '../deploy-vars.mjs'

const WRAPPER = fileURLToPath(new URL('../deploy-vars.mjs', import.meta.url))
const WORKER = fileURLToPath(new URL('../../worker/', import.meta.url))
const PRIVATE = 'synthetic-private-token'

// Synthetic values only; subprocesses never invoke Wrangler or contact an account.
function environment() {
  return {
    GITHUB_SHA: 'c'.repeat(40),
    NEWSLETTER_CONSOLE_ACCESS_OWNER: 'owner@example.org',
    NEWSLETTER_CONSOLE_ACCESS_OWNER_ALIASES: 'alias@example.org, second@example.net',
  }
}

function temporary(check) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'newsletter-console-deploy-test-')))
  try { check(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
}

function invoke(args, env = environment(), cwd = WORKER) {
  return spawnSync(process.execPath, [WRAPPER, ...args], {
    cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 10_000,
  })
}

test('only the exact source SHA becomes a plain var; the secrets are Home\'s owner identity', () => {
  const marked = {}
  for (const [, mode, names] of readFileSync(WRAPPER, 'utf8').matchAll(/^\/\/ deploy-vars-inputs (\w+): (.+)$/gm)) {
    marked[mode] = [...(marked[mode] ?? []), ...names.split(' ')]
  }
  assert.deepEqual(marked, {
    exec: ['GITHUB_SHA'],
    secrets: ['NEWSLETTER_CONSOLE_ACCESS_OWNER', 'NEWSLETTER_CONSOLE_ACCESS_OWNER_ALIASES', 'DASHBOARD_WORKER_SECRETS'],
  })
  assert.deepEqual(INJECTED.map(({ name, from }) => ({ name, from })), [{ name: 'BUILD_SHA', from: 'GITHUB_SHA' }])
  const env = { ...environment(), DEV_AUTH_BYPASS: 'true' }
  assert.deepEqual(injectedVars(env), { BUILD_SHA: 'c'.repeat(40) })
  assert.deepEqual(wranglerArgs(env), ['--var', `BUILD_SHA:${'c'.repeat(40)}`])
  for (const value of ['main', 'C'.repeat(40), 'c'.repeat(39), 'c'.repeat(41), '', undefined]) {
    assert.throws(() => injectedVars({ ...env, GITHUB_SHA: value }),
      (error) => error instanceof SettingError && error.setting === 'GITHUB_SHA')
  }
})

test('the owner and aliases are validated, and an empty alias list overwrites old ones', () => {
  assert.deepEqual(generateSecrets(environment()), {
    ACCESS_OWNER: 'owner@example.org', ACCESS_OWNER_ALIASES: 'alias@example.org,second@example.net',
  })
  assert.equal(generateSecrets({ ...environment(), NEWSLETTER_CONSOLE_ACCESS_OWNER_ALIASES: '' }).ACCESS_OWNER_ALIASES, ' ')
  const cases = [
    ['NEWSLETTER_CONSOLE_ACCESS_OWNER', undefined], ['NEWSLETTER_CONSOLE_ACCESS_OWNER', 'not-an-email'],
    ['NEWSLETTER_CONSOLE_ACCESS_OWNER', 'ownér@example.org'],
    ['NEWSLETTER_CONSOLE_ACCESS_OWNER_ALIASES', undefined], ['NEWSLETTER_CONSOLE_ACCESS_OWNER_ALIASES', 'a@example.org,a@example.org'],
    ['NEWSLETTER_CONSOLE_ACCESS_OWNER_ALIASES', Array.from({ length: 9 }, (_, i) => `a${i}@example.org`).join(',')],
  ]
  for (const [name, value] of cases) {
    assert.throws(() => generateSecrets({ ...environment(), [name]: value }),
      (error) => error instanceof SettingError && error.setting === name, `${name}=${String(value)}`)
  }
})

test('Home\'s map gives nothing but the owner identity, and the identity secrets win as they do for Home', () => {
  const home = { ACCESS_OWNER: 'stale@example.org', ACCESS_OWNER_ALIASES: 'old@example.org', CF_ANALYTICS_TOKEN: PRIVATE, CSRF_SIGNING_KEY: PRIVATE }
  const secrets = generateSecrets({ ...environment(), DASHBOARD_WORKER_SECRETS: JSON.stringify(home) })
  assert.deepEqual(secrets, { ACCESS_OWNER: 'owner@example.org', ACCESS_OWNER_ALIASES: 'alias@example.org,second@example.net' })
  assert.ok(!JSON.stringify(secrets).includes(PRIVATE))
  // A map Home's own deploy would refuse is refused here too, without its values in the message.
  for (const map of ['[1]', 'null', PRIVATE, JSON.stringify({ ...home, UNDECLARED: PRIVATE }), JSON.stringify({ ACCESS_OWNER: 7 })]) {
    assert.throws(() => generateSecrets({ ...environment(), DASHBOARD_WORKER_SECRETS: map }),
      (error) => error instanceof SettingError && error.setting === 'DASHBOARD_WORKER_SECRETS' && !error.message.includes(PRIVATE))
  }
})

test('the secrets file is private, never overwritten, and its values never printed', () => {
  temporary((directory) => {
    const path = join(directory, 'secrets.json')
    const first = invoke(['secrets', path])
    assert.equal(first.status, 0, first.stderr)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))).sort(), ['ACCESS_OWNER', 'ACCESS_OWNER_ALIASES'])
    const again = invoke(['secrets', path])
    assert.equal(again.status, 1)
    assert.match(again.stderr, /already exists/)
    for (const result of [first, again]) assert.ok(!(result.stdout + result.stderr).includes('owner@example.org'))
    const missing = invoke(['secrets', join(directory, 'other.json')], { GITHUB_SHA: 'c'.repeat(40) })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /NEWSLETTER_CONSOLE_ACCESS_OWNER/)
    assert.ok(!existsSync(join(directory, 'other.json')))
  })
})

test('only a deploy of the committed config runs, never with --env, --keep-vars or a --var of its own', () => {
  assert.equal(refusal(['wrangler', 'deploy', '--dry-run', '--config', '../wrangler.toml'], WORKER), null)
  for (const [argv, reason] of [
    [[], /no command/],
    [['wrangler', 'deploy', '--config', '../wrangler.toml', '--env', 'preview'], /--env/],
    [['wrangler', 'deploy', '--config', '../wrangler.toml', '--keep-vars'], /--keep-vars/],
    [['wrangler', 'deploy', '--config', '../wrangler.toml', '--var', 'X:1'], /--var/],
    [['wrangler', 'versions', 'upload', '--config', '../wrangler.toml'], /only a deploy/],
    [['wrangler', 'deploy'], /--config must name/],
    [['wrangler', 'deploy', '--config', 'elsewhere.toml'], /--config must name/],
  ]) assert.match(refusal(argv, WORKER) ?? '', reason, argv.join(' '))
})

test('a real deploy needs the real Access audience; a dry run is allowed only before the application exists', () => {
  const withoutAudience = readFileSync(CONFIG, 'utf8')
  assert.ok(!/^\s*ACCESS_AUDIENCE\s*=/m.test(withoutAudience))
  const deploy = ['wrangler', 'deploy', '--config', '../wrangler.toml']
  assert.match(refusal(deploy, WORKER, () => withoutAudience) ?? '', /ACCESS_AUDIENCE/)
  assert.equal(refusal([...deploy, '--dry-run'], WORKER, () => withoutAudience), null)
  const zeros = `${withoutAudience}ACCESS_AUDIENCE = "${'0'.repeat(64)}"\n`
  assert.match(refusal([...deploy, '--dry-run'], WORKER, () => zeros) ?? '', /ACCESS_AUDIENCE/)
  const real = `${withoutAudience}ACCESS_AUDIENCE = "${'b'.repeat(64)}"\n`
  assert.equal(refusal(deploy, WORKER, () => real), null)
  assert.equal(placeholderIn(real), null)
  for (const value of ['', '0'.repeat(64), 'not-an-audience']) {
    assert.equal(placeholderIn(`[vars]\nACCESS_AUDIENCE = "${value}"\n`), 'ACCESS_AUDIENCE')
  }
})

test('exec appends the build var and passes the exit status through', () => {
  temporary((directory) => {
    const stub = join(directory, 'stub.mjs')
    const output = join(directory, 'args.json')
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))\n`)
    const result = invoke(['exec', '--', process.execPath, stub, 'deploy', '--dry-run', '--config', '../wrangler.toml'])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).slice(-2), ['--var', `BUILD_SHA:${'c'.repeat(40)}`])
    const refused = invoke(['exec', '--', process.execPath, stub, 'deploy', '--config', '../wrangler.toml'])
    assert.equal(refused.status, 2)
    assert.match(refused.stderr, /ACCESS_AUDIENCE/)
  })
})
