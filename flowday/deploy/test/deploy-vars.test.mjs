// The deploy wrapper (../deploy-vars.mjs): Lab's rules with FlowDay's inputs, and no real deploy before F2.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG, INJECTED, SettingError, generateSecrets, injectedVars, placeholderIn, refusal, run, wranglerArgs } from '../deploy-vars.mjs'

const WRAPPER = fileURLToPath(new URL('../deploy-vars.mjs', import.meta.url))
const WORKER = fileURLToPath(new URL('../../worker/', import.meta.url))

// Synthetic values only.
function environment() {
  return {
    GITHUB_SHA: 'c'.repeat(40),
    FLOWDAY_ACCESS_OWNER: 'owner@example.org',
    FLOWDAY_ACCESS_OWNER_ALIASES: 'alias@example.org, second@example.net',
    FLOWDAY_CSRF_SIGNING_KEY: 'd'.repeat(64),
    FLOWDAY_CREDENTIAL_KEY: 'e'.repeat(64),
  }
}

test('the marker lists every input of each mode', () => {
  const marked = {}
  for (const [, mode, names] of readFileSync(WRAPPER, 'utf8').matchAll(/^\/\/ deploy-vars-inputs (\w+): (.+)$/gm)) {
    marked[mode] = [...(marked[mode] ?? []), ...names.split(' ')]
  }
  assert.deepEqual(marked, {
    exec: INJECTED.map(({ from }) => from),
    secrets: ['FLOWDAY_ACCESS_OWNER', 'FLOWDAY_ACCESS_OWNER_ALIASES', 'FLOWDAY_CSRF_SIGNING_KEY', 'FLOWDAY_CREDENTIAL_KEY'],
  })
})

test('the build becomes a --var flag and must be the 40-hex commit', () => {
  assert.deepEqual(injectedVars(environment()), { BUILD_SHA: 'c'.repeat(40) })
  assert.deepEqual(wranglerArgs(environment()), ['--var', `BUILD_SHA:${'c'.repeat(40)}`])
  for (const value of ['main', 'c'.repeat(39), '', undefined]) {
    const env = { ...environment(), GITHUB_SHA: value }
    if (value === undefined) delete env.GITHUB_SHA
    assert.throws(() => injectedVars(env), /deploy setting: GITHUB_SHA$/, JSON.stringify(value))
  }
})

test('the secrets file holds the owner, aliases, CSRF key and credential key; invalid values are refused by name', () => {
  assert.deepEqual(generateSecrets(environment()), {
    ACCESS_OWNER: 'owner@example.org',
    ACCESS_OWNER_ALIASES: 'alias@example.org,second@example.net',
    CSRF_SIGNING_KEY: 'd'.repeat(64),
    CREDENTIAL_KEY: 'e'.repeat(64),
  })
  assert.equal(generateSecrets({ ...environment(), FLOWDAY_ACCESS_OWNER_ALIASES: '' }).ACCESS_OWNER_ALIASES, ' ')
  for (const [name, value] of [
    ['FLOWDAY_ACCESS_OWNER', undefined], ['FLOWDAY_ACCESS_OWNER', 'not-an-email'],
    ['FLOWDAY_ACCESS_OWNER_ALIASES', 'a@example.org,a@example.org'],
    ['FLOWDAY_CSRF_SIGNING_KEY', 'd'.repeat(63)], ['FLOWDAY_CSRF_SIGNING_KEY', undefined],
    ['FLOWDAY_CREDENTIAL_KEY', 'e'.repeat(63)], ['FLOWDAY_CREDENTIAL_KEY', 'not hex'], ['FLOWDAY_CREDENTIAL_KEY', undefined],
  ]) {
    const env = { ...environment(), [name]: value }
    if (value === undefined) delete env[name]
    assert.throws(() => generateSecrets(env), (error) => error instanceof SettingError && error.message === `Invalid or missing deploy setting: ${name}`, name)
  }
})

test('before F2 the committed config holds both placeholders: only a --dry-run deploy may run', () => {
  assert.equal(placeholderIn(readFileSync(CONFIG, 'utf8')), 'database_id')
  assert.match(readFileSync(CONFIG, 'utf8'), new RegExp(`^ACCESS_AUDIENCE = "${'0'.repeat(64)}"$`, 'm'))
  const deploy = ['npx', '--no-install', 'wrangler', 'deploy']
  assert.equal(refusal([...deploy, '--dry-run', '--config', '../wrangler.toml', '--outdir', '/tmp/x'], WORKER), null)
  assert.match(refusal([...deploy, '--config', '../wrangler.toml', '--secrets-file', '/tmp/s.json'], WORKER), /placeholder/)
  for (const argv of [
    [], deploy, [...deploy, '--dry-run', '--config', 'wrangler.toml'], [...deploy, '--dry-run', '--config', '../../lab/wrangler.toml'],
    [...deploy, '--dry-run', '--config', '../wrangler.toml', '--env', 'production'],
    [...deploy, '--dry-run', '--config', '../wrangler.toml', '--keep-vars'],
    [...deploy, '--dry-run', '--config', '../wrangler.toml', '--var', 'BUILD_SHA:x'],
    ['npx', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--config', '../wrangler.toml'],
  ]) assert.notEqual(refusal(argv, WORKER), null, argv.join(' '))
})

test('exec runs the dry-run unchanged plus the --var flag; secrets writes 0600 and never overwrites; nothing is printed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowday-deploy-vars-'))
  try {
    const out = join(dir, 'argv.json')
    const stub = join(dir, 'stub.mjs')
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))\n`)
    const config = relative(WORKER, CONFIG)
    const env = { PATH: process.env.PATH, ...environment() }
    const result = spawnSync(process.execPath, [WRAPPER, 'exec', '--', process.execPath, stub, 'deploy', '--dry-run', '--config', config], { cwd: WORKER, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), ['deploy', '--dry-run', '--config', config, ...wranglerArgs(environment())])
    const refused = spawnSync(process.execPath, [WRAPPER, 'exec', '--', process.execPath, stub, 'deploy', '--config', config], { cwd: WORKER, env, encoding: 'utf8' })
    assert.equal(refused.status, 2)

    const secrets = join(dir, 'secrets.json')
    const written = spawnSync(process.execPath, [WRAPPER, 'secrets', secrets], { env, encoding: 'utf8' })
    assert.equal(written.status, 0, written.stderr)
    assert.equal(statSync(secrets).mode & 0o777, 0o600)
    const again = spawnSync(process.execPath, [WRAPPER, 'secrets', secrets], { env, encoding: 'utf8' })
    assert.equal(again.status, 1)
    const bad = join(dir, 'bad.json')
    const invalid = spawnSync(process.execPath, [WRAPPER, 'secrets', bad], { env: { ...env, FLOWDAY_CSRF_SIGNING_KEY: 'secret-looking-value' }, encoding: 'utf8' })
    assert.equal(invalid.stderr.trim(), 'Invalid or missing deploy setting: FLOWDAY_CSRF_SIGNING_KEY')
    assert.ok(!existsSync(bad))

    const printed = [result, refused, written, again, invalid].map(({ stdout, stderr }) => stdout + stderr).join('\n')
    for (const value of Object.values(environment())) assert.ok(!printed.includes(value), 'printed a value')
    assert.ok(!printed.includes('secret-looking-value'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(run(['nonsense'], environment()), 2)
})

test('the owner rules are the same lines as the dashboard and Lab wrappers (the same secrets feed all three)', () => {
  const rules = /^(?:const ACCESS_EMAIL|const MAX_ALIASES|const MAX_LIST_CHARS) = .+$/gm
  const ours = readFileSync(WRAPPER, 'utf8').match(rules)
  assert.equal(ours.length, 3)
  for (const other of ['../../../lab/deploy/deploy-vars.mjs', '../../../dashboard/deploy/deploy-vars.mjs']) {
    assert.deepEqual(readFileSync(fileURLToPath(new URL(other, import.meta.url)), 'utf8').match(rules), ours)
  }
})
