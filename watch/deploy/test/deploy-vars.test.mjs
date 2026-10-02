// The deploy wrapper (../deploy-vars.mjs): Lab's, FlowDay's and the links app's rules with the watch app's inputs, and
// no real deploy with the AUD placeholder. Synthetic values only; the wrapper runs a stub instead of wrangler. (The owner rules are
// compared with the dashboard's wrapper in .github/scripts/test_wrangler_configs.py: an app reads no other app.)
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

function environment() {
  return {
    GITHUB_SHA: 'c'.repeat(40),
    WATCH_ACCESS_OWNER: 'owner@example.org',
    WATCH_ACCESS_OWNER_ALIASES: 'alias@example.org, second@example.net',
    WATCH_CSRF_SIGNING_KEY: 'd'.repeat(64),
  }
}

test('the marker lists every input of each mode', () => {
  const marked = {}
  for (const [, mode, names] of readFileSync(WRAPPER, 'utf8').matchAll(/^\/\/ deploy-vars-inputs (\w+): (.+)$/gm)) {
    marked[mode] = [...(marked[mode] ?? []), ...names.split(' ')]
  }
  assert.deepEqual(marked, {
    exec: INJECTED.map(({ from }) => from),
    secrets: ['WATCH_ACCESS_OWNER', 'WATCH_ACCESS_OWNER_ALIASES', 'WATCH_CSRF_SIGNING_KEY'],
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

test('the secrets file holds the owner, aliases and CSRF key; invalid values are refused by name', () => {
  assert.deepEqual(generateSecrets(environment()), {
    ACCESS_OWNER: 'owner@example.org',
    ACCESS_OWNER_ALIASES: 'alias@example.org,second@example.net',
    CSRF_SIGNING_KEY: 'd'.repeat(64),
  })
  assert.equal(generateSecrets({ ...environment(), WATCH_ACCESS_OWNER_ALIASES: '' }).ACCESS_OWNER_ALIASES, ' ')
  for (const [name, value] of [
    ['WATCH_ACCESS_OWNER', undefined], ['WATCH_ACCESS_OWNER', 'not-an-email'], ['WATCH_ACCESS_OWNER', 'ówner@example.org'],
    ['WATCH_ACCESS_OWNER_ALIASES', 'a@example.org,a@example.org'],
    ['WATCH_CSRF_SIGNING_KEY', 'd'.repeat(63)], ['WATCH_CSRF_SIGNING_KEY', undefined],
  ]) {
    const env = { ...environment(), [name]: value }
    if (value === undefined) delete env[name]
    assert.throws(() => generateSecrets(env), (error) => error instanceof SettingError && error.message === `Invalid or missing deploy setting: ${name}`, name)
  }
})

test('since W2 a real deploy needs the real Access AUD; the placeholder refuses it, a dry-run always runs', () => {
  const committed = readFileSync(CONFIG, 'utf8')
  const W1_AUD = `ACCESS_AUDIENCE = "${'0'.repeat(64)}"`
  // The committed config with a real-looking AUD, and with the W1 placeholder (a revert, or the W2 fill-in not done).
  const real = committed.replace(/^ACCESS_AUDIENCE = "[^"]+"$/m, `ACCESS_AUDIENCE = "${'a'.repeat(64)}"`)
  const placeholder = committed.replace(/^ACCESS_AUDIENCE = "[^"]+"$/m, W1_AUD)
  assert.notEqual(real, placeholder)
  assert.equal(placeholderIn(real), null)
  assert.equal(placeholderIn(placeholder), 'ACCESS_AUDIENCE')
  assert.equal(placeholderIn(`# ${W1_AUD}\n`), null)

  const deploy = ['npx', '--no-install', 'wrangler', 'deploy']
  const realDeploy = [...deploy, '--config', '../wrangler.toml', '--secrets-file', '/tmp/s.json']
  const dryRun = [...deploy, '--dry-run', '--config', '../wrangler.toml', '--outdir', '/tmp/x']
  assert.equal(refusal(realDeploy, WORKER, () => real), null)
  assert.equal(refusal(dryRun, WORKER, () => real), null)
  assert.match(refusal(realDeploy, WORKER, () => placeholder), /^ACCESS_AUDIENCE .*placeholder/)
  assert.equal(refusal(dryRun, WORKER, () => placeholder), null)

  for (const argv of [
    [], deploy, [...deploy, '--dry-run', '--config', 'wrangler.toml'], [...deploy, '--dry-run', '--config', '../../lab/wrangler.toml'],
    [...deploy, '--config', '../wrangler.toml', '--env', 'production'],
    [...deploy, '--config', '../wrangler.toml', '--keep-vars'],
    [...deploy, '--config', '../wrangler.toml', '--var', 'BUILD_SHA:x'],
    ['npx', 'wrangler', 'secret', 'put', 'X', '--config', '../wrangler.toml'],
  ]) assert.notEqual(refusal(argv, WORKER, () => real), null, argv.join(' '))
})

test('exec runs the deploy (or dry-run) unchanged plus the --var flag; secrets writes 0600 and never overwrites; nothing is printed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-deploy-vars-'))
  try {
    const out = join(dir, 'argv.json')
    const stub = join(dir, 'stub.mjs')
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))\n`)
    const config = relative(WORKER, CONFIG)
    const env = { PATH: process.env.PATH, ...environment() }
    const result = spawnSync(process.execPath, [WRAPPER, 'exec', '--', process.execPath, stub, 'deploy', '--dry-run', '--config', config], { cwd: WORKER, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), ['deploy', '--dry-run', '--config', config, ...wranglerArgs(environment())])
    // A real deploy runs the stub (in place of wrangler) with the committed AUD, and is refused before it would run
    // while the AUD is the placeholder (wrangler-config.test.mjs requires the real one since W2).
    rmSync(out)
    const refused = spawnSync(process.execPath, [WRAPPER, 'exec', '--', process.execPath, stub, 'deploy', '--config', config], { cwd: WORKER, env, encoding: 'utf8' })
    if (placeholderIn(readFileSync(CONFIG, 'utf8')) === null) {
      assert.equal(refused.status, 0, refused.stderr)
      assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), ['deploy', '--config', config, ...wranglerArgs(environment())])
    } else {
      assert.equal(refused.status, 2)
      assert.ok(!existsSync(out))
    }

    const secrets = join(dir, 'secrets.json')
    const written = spawnSync(process.execPath, [WRAPPER, 'secrets', secrets], { env, encoding: 'utf8' })
    assert.equal(written.status, 0, written.stderr)
    assert.equal(statSync(secrets).mode & 0o777, 0o600)
    const again = spawnSync(process.execPath, [WRAPPER, 'secrets', secrets], { env, encoding: 'utf8' })
    assert.equal(again.status, 1)
    const bad = join(dir, 'bad.json')
    const invalid = spawnSync(process.execPath, [WRAPPER, 'secrets', bad], { env: { ...env, WATCH_CSRF_SIGNING_KEY: 'secret-looking-value' }, encoding: 'utf8' })
    assert.equal(invalid.stderr.trim(), 'Invalid or missing deploy setting: WATCH_CSRF_SIGNING_KEY')
    assert.ok(!existsSync(bad))

    const printed = [result, refused, written, again, invalid].map(({ stdout, stderr }) => stdout + stderr).join('\n')
    for (const value of Object.values(environment())) assert.ok(!printed.includes(value), 'printed a value')
    assert.ok(!printed.includes('secret-looking-value'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(run(['nonsense'], environment()), 2)
})
