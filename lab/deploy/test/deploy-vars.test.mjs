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
    LAB_ACCESS_OWNER: 'owner@example.org',
    LAB_ACCESS_OWNER_ALIASES: 'alias@example.org, second@example.net',
    LAB_CSRF_SIGNING_KEY: 'd'.repeat(64),
  }
}

test('the marker lists every input of each mode', () => {
  const marked = {}
  for (const [, mode, names] of readFileSync(WRAPPER, 'utf8').matchAll(/^\/\/ deploy-vars-inputs (\w+): (.+)$/gm)) {
    marked[mode] = [...(marked[mode] ?? []), ...names.split(' ')]
  }
  assert.deepEqual(marked, {
    exec: INJECTED.map(({ from }) => from),
    secrets: ['LAB_ACCESS_OWNER', 'LAB_ACCESS_OWNER_ALIASES', 'LAB_CSRF_SIGNING_KEY'],
  })
})

test('the build becomes a --var flag and must be the 40-hex commit', () => {
  assert.deepEqual(injectedVars(environment()), { BUILD_SHA: 'c'.repeat(40) })
  assert.deepEqual(wranglerArgs(environment()), ['--var', `BUILD_SHA:${'c'.repeat(40)}`])
  for (const value of ['main', 'C'.repeat(40), 'c'.repeat(39), '', undefined]) {
    const env = { ...environment(), GITHUB_SHA: value }
    if (value === undefined) delete env.GITHUB_SHA
    assert.throws(() => injectedVars(env), /deploy setting: GITHUB_SHA$/, JSON.stringify(value))
  }
})

test('the secrets file holds the owner, aliases and CSRF key', () => {
  assert.deepEqual(generateSecrets(environment()), {
    ACCESS_OWNER: 'owner@example.org',
    ACCESS_OWNER_ALIASES: 'alias@example.org,second@example.net',
    CSRF_SIGNING_KEY: 'd'.repeat(64),
  })
  assert.equal(generateSecrets({ ...environment(), LAB_ACCESS_OWNER_ALIASES: '' }).ACCESS_OWNER_ALIASES, ' ')
  const cases = [
    ['LAB_ACCESS_OWNER', undefined], ['LAB_ACCESS_OWNER', 'not-an-email'], ['LAB_ACCESS_OWNER', 'Kate@example.org'],
    ['LAB_ACCESS_OWNER', ' owner@example.org'],
    ['LAB_ACCESS_OWNER_ALIASES', undefined], ['LAB_ACCESS_OWNER_ALIASES', 'alias@example.org\ninjected'],
    ['LAB_ACCESS_OWNER_ALIASES', 'a@example.org,a@example.org'],
    ['LAB_ACCESS_OWNER_ALIASES', Array.from({ length: 9 }, (_, i) => `a${i}@example.org`).join(',')],
    ['LAB_CSRF_SIGNING_KEY', 'd'.repeat(63)], ['LAB_CSRF_SIGNING_KEY', undefined], ['LAB_CSRF_SIGNING_KEY', 'z'.repeat(64)],
  ]
  for (const [name, value] of cases) {
    const env = { ...environment(), [name]: value }
    if (value === undefined) delete env[name]
    assert.throws(() => generateSecrets(env), (error) => error instanceof SettingError && error.message === `Invalid or missing deploy setting: ${name}`, name)
  }
})

test('the committed config carries the real D1 id and Access AUD; the placeholder is refused', () => {
  assert.equal(placeholderIn(readFileSync(CONFIG, 'utf8')), null)
  assert.equal(placeholderIn('database_id = "00000000-0000-0000-0000-000000000000"\n'), 'database_id')
  assert.equal(placeholderIn(`ACCESS_AUDIENCE = "${'0'.repeat(64)}"\n`), 'ACCESS_AUDIENCE')
  assert.equal(placeholderIn('# database_id = "00000000-0000-0000-0000-000000000000"\n'), null)
})

test('only a deploy of lab/wrangler.toml, without --env, --keep-vars or its own --var, may run', () => {
  const deploy = ['npx', '--no-install', 'wrangler', 'deploy']
  assert.equal(refusal([...deploy, '--config', '../wrangler.toml', '--secrets-file', '/tmp/s.json'], WORKER), null)
  assert.equal(refusal([...deploy, '--dry-run', '--config=../wrangler.toml'], WORKER), null)
  for (const argv of [
    [], deploy, [...deploy, '--config', 'wrangler.toml'], [...deploy, '--config', '../../dashboard/wrangler.toml'],
    [...deploy, '--config', '../wrangler.toml', '--env', 'production'], [...deploy, '--config', '../wrangler.toml', '-e', 'x'],
    [...deploy, '--config', '../wrangler.toml', '--keep-vars'], [...deploy, '--config', '../wrangler.toml', '--var', 'BUILD_SHA:x'],
    ['npx', 'wrangler', 'versions', 'deploy', '--config', '../wrangler.toml', '--env=x'],
    ['npx', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--config', '../wrangler.toml'],
  ]) assert.notEqual(refusal(argv, WORKER), null, argv.join(' '))
})

test('exec runs the command unchanged plus the --var flag; secrets writes 0600 and never overwrites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-deploy-vars-'))
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
    const invalid = spawnSync(process.execPath, [WRAPPER, 'secrets', bad], { env: { ...env, LAB_CSRF_SIGNING_KEY: 'secret-looking-value' }, encoding: 'utf8' })
    assert.equal(invalid.status, 1)
    assert.equal(invalid.stderr.trim(), 'Invalid or missing deploy setting: LAB_CSRF_SIGNING_KEY')
    assert.ok(!existsSync(bad))

    const printed = [result, written, again, invalid].map(({ stdout, stderr }) => stdout + stderr).join('\n')
    for (const value of Object.values(environment()).filter(Boolean)) assert.ok(!printed.includes(value), 'printed a value')
    assert.ok(!printed.includes('secret-looking-value'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(run(['nonsense'], environment()), 2)
})
