// The deploy wrapper (../deploy-vars.mjs): mailsort's rules with recall's inputs, no real deploy without the Access AUD,
// and never a machine token's digest in a secrets file. Synthetic values only; the wrapper runs a stub instead of
// wrangler. (The owner rules are compared with the dashboard's wrapper in .github/scripts/test_wrangler_configs.py: an
// app reads no other app.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG, INJECTED, OWNER_ONLY_SECRETS, SettingError, generateSecrets, injectedVars, placeholderIn, refusal, run, wranglerArgs } from '../deploy-vars.mjs'

// CLI children keep their minimal environment and use the pinned interpreter directly.
const NODE_EXECUTABLE = process.env.JS_BINARY__NODE_BINARY ?? process.execPath

const WRAPPER = fileURLToPath(new URL('../deploy-vars.mjs', import.meta.url))
const WORKER = fileURLToPath(new URL('../../worker/', import.meta.url))

function environment() {
  return {
    GITHUB_SHA: 'c'.repeat(40),
    RECALL_ACCESS_OWNER: 'owner@example.org',
    RECALL_ACCESS_OWNER_ALIASES: 'alias@example.org, second@example.net',
  }
}

test('the marker lists every input of each mode', () => {
  const marked = {}
  for (const [, mode, names] of readFileSync(WRAPPER, 'utf8').matchAll(/^\/\/ deploy-vars-inputs (\w+): (.+)$/gm)) {
    marked[mode] = [...(marked[mode] ?? []), ...names.trim().split(/\s+/)]
  }
  assert.deepEqual(marked, {
    exec: INJECTED.map(({ from }) => from),
    secrets: ['RECALL_ACCESS_OWNER', 'RECALL_ACCESS_OWNER_ALIASES'],
  })
})

test('the build becomes the one --var flag: the 40-hex commit', () => {
  assert.deepEqual(injectedVars(environment()), { BUILD_SHA: 'c'.repeat(40) })
  assert.deepEqual(wranglerArgs(environment()), ['--var', `BUILD_SHA:${'c'.repeat(40)}`])
  assert.deepEqual(injectedVars({ ...environment(), BUILD_SOURCE_SHA: 'e'.repeat(40) }), { BUILD_SHA: 'e'.repeat(40) })
  for (const value of ['main', 'c'.repeat(39), 'C'.repeat(40), '', undefined]) {
    const env = { ...environment(), GITHUB_SHA: value }
    if (value === undefined) delete env.GITHUB_SHA
    assert.throws(() => injectedVars(env), /deploy setting: GITHUB_SHA$/, JSON.stringify(value))
  }
})

test('the secrets file holds the owner and aliases; invalid values are refused by name', () => {
  assert.deepEqual(generateSecrets(environment()), {
    ACCESS_OWNER: 'owner@example.org',
    ACCESS_OWNER_ALIASES: 'alias@example.org,second@example.net',
  })
  assert.equal(generateSecrets({ ...environment(), RECALL_ACCESS_OWNER_ALIASES: '' }).ACCESS_OWNER_ALIASES, ' ')
  for (const [name, value] of [
    ['RECALL_ACCESS_OWNER', undefined], ['RECALL_ACCESS_OWNER', 'not-an-email'], ['RECALL_ACCESS_OWNER', 'ówner@example.org'],
    ['RECALL_ACCESS_OWNER_ALIASES', 'a@example.org,a@example.org'], ['RECALL_ACCESS_OWNER_ALIASES', undefined],
  ]) {
    const env = { ...environment(), [name]: value }
    if (value === undefined) delete env[name]
    assert.throws(() => generateSecrets(env), (error) => error instanceof SettingError && error.message === `Invalid or missing deploy setting: ${name}`, name)
  }
})

test('a real deploy needs the Access AUD; without it (or with the all-zeros one) it is refused, a dry-run always runs', () => {
  const committed = readFileSync(CONFIG, 'utf8').replace(/^ACCESS_AUDIENCE = "[^"]+"\n/m, '')
  // The committed config with a real-looking AUD added as the generator adds it, without one, and with the zeros.
  const real = committed.replace(/^ACCESS_ISSUER = (.+)$/m, `ACCESS_ISSUER = $1\nACCESS_AUDIENCE = "${'a'.repeat(64)}"`)
  const placeholder = committed
  const zeros = committed.replace(/^ACCESS_ISSUER = (.+)$/m, `ACCESS_ISSUER = $1\nACCESS_AUDIENCE = "${'0'.repeat(64)}"`)
  assert.notEqual(real, placeholder)
  assert.equal(placeholderIn(real), null)
  assert.equal(placeholderIn(placeholder), 'ACCESS_AUDIENCE')
  assert.equal(placeholderIn(zeros), 'ACCESS_AUDIENCE')
  assert.equal(placeholderIn(`# ACCESS_AUDIENCE = "${'a'.repeat(64)}"\n`), 'ACCESS_AUDIENCE')

  const deploy = ['npx', '--no-install', 'wrangler', 'deploy']
  const realDeploy = [...deploy, '--config', '../wrangler.toml', '--secrets-file', '/tmp/s.json']
  const dryRun = [...deploy, '--dry-run', '--config', '../wrangler.toml', '--outdir', '/tmp/x']
  assert.equal(refusal(realDeploy, WORKER, () => real), null)
  assert.equal(refusal(dryRun, WORKER, () => real), null)
  assert.match(refusal(realDeploy, WORKER, () => placeholder), /^ACCESS_AUDIENCE is missing/)
  assert.equal(refusal(dryRun, WORKER, () => placeholder), null)

  for (const argv of [
    [], deploy, [...deploy, '--dry-run', '--config', 'wrangler.toml'], [...deploy, '--dry-run', '--config', '../wrangler.test.toml'],
    [...deploy, '--dry-run', '--config', '../../mailsort/wrangler.toml'],
    [...deploy, '--config', '../wrangler.toml', '--env', 'production'],
    [...deploy, '--config', '../wrangler.toml', '--keep-vars'],
    [...deploy, '--config', '../wrangler.toml', '--var', 'BUILD_SHA:x'],
    ['npx', 'wrangler', 'secret', 'put', 'INGEST_TOKEN_SHA256', '--config', '../wrangler.toml'],
  ]) assert.notEqual(refusal(argv, WORKER, () => real), null, argv.join(' '))
})

test('exec runs the deploy (or dry-run) unchanged plus the --var flag; secrets writes 0600 and never overwrites; nothing is printed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-deploy-vars-'))
  try {
    const out = join(dir, 'argv.json')
    const stub = join(dir, 'stub.mjs')
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))\n`)
    const config = relative(WORKER, CONFIG)
    const env = { PATH: process.env.PATH, ...environment() }
    const result = spawnSync(NODE_EXECUTABLE, ['--preserve-symlinks-main', WRAPPER, 'exec', '--', NODE_EXECUTABLE, stub, 'deploy', '--dry-run', '--config', config], { cwd: WORKER, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), ['deploy', '--dry-run', '--config', config, ...wranglerArgs(environment())])
    // A real deploy runs the stub (in place of wrangler) with the committed AUD, and is refused before it would run
    // while the config has none (before "Infra apply" creates the Access application).
    rmSync(out)
    const refused = spawnSync(NODE_EXECUTABLE, ['--preserve-symlinks-main', WRAPPER, 'exec', '--', NODE_EXECUTABLE, stub, 'deploy', '--config', config], { cwd: WORKER, env, encoding: 'utf8' })
    if (placeholderIn(readFileSync(CONFIG, 'utf8')) === null) {
      assert.equal(refused.status, 0, refused.stderr)
      assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), ['deploy', '--config', config, ...wranglerArgs(environment())])
    } else {
      assert.equal(refused.status, 2)
      assert.ok(!existsSync(out))
    }

    const secrets = join(dir, 'secrets.json')
    const written = spawnSync(NODE_EXECUTABLE, ['--preserve-symlinks-main', WRAPPER, 'secrets', secrets], { env, encoding: 'utf8' })
    assert.equal(written.status, 0, written.stderr)
    assert.equal(statSync(secrets).mode & 0o777, 0o600)
    const again = spawnSync(NODE_EXECUTABLE, ['--preserve-symlinks-main', WRAPPER, 'secrets', secrets], { env, encoding: 'utf8' })
    assert.equal(again.status, 1)
    const bad = join(dir, 'bad.json')
    const invalid = spawnSync(NODE_EXECUTABLE, ['--preserve-symlinks-main', WRAPPER, 'secrets', bad], { env: { ...env, RECALL_ACCESS_OWNER: 'secret-looking-value' }, encoding: 'utf8' })
    assert.equal(invalid.stderr.trim(), 'Invalid or missing deploy setting: RECALL_ACCESS_OWNER')
    assert.ok(!existsSync(bad))

    const printed = [result, refused, written, again, invalid].map(({ stdout, stderr }) => stdout + stderr).join('\n')
    for (const value of Object.values(environment())) assert.ok(!printed.includes(value), 'printed a value')
    assert.ok(!printed.includes('secret-looking-value'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(run(['nonsense'], environment()), 2)
})

test("a machine token's digest never enters a secrets file: a RECALL_WORKER_SECRETS map that names one is refused", () => {
  const secrets = generateSecrets(environment())
  for (const name of OWNER_ONLY_SECRETS) assert.ok(!Object.hasOwn(secrets, name), name)
  for (const name of OWNER_ONLY_SECRETS) {
    const env = { ...environment(), RECALL_WORKER_SECRETS: JSON.stringify({ CSRF_SIGNING_KEY: 'd'.repeat(64), ACCESS_OWNER: 'owner@example.org', [name]: 'a'.repeat(64) }) }
    assert.throws(() => generateSecrets(env), (error) => error instanceof SettingError && error.setting === 'RECALL_WORKER_SECRETS', name)
  }
  // A complete map without the digests is accepted (a cold bootstrap's), the personal inputs taking precedence.
  const map = { ...environment(), RECALL_WORKER_SECRETS: JSON.stringify({ CSRF_SIGNING_KEY: 'e'.repeat(64), ACCESS_OWNER: 'other@example.org' }) }
  assert.equal(Object.hasOwn(generateSecrets(map), 'CSRF_SIGNING_KEY'), false)
  assert.equal(generateSecrets(map).ACCESS_OWNER, environment().RECALL_ACCESS_OWNER)
})

test('the public GitHub secrets spec leaves the digests out; app.toml declares them owner-machine only', () => {
  const specs = JSON.parse(readFileSync(new URL('../../../tools/cloud-config/worker-secrets.json', import.meta.url), 'utf8'))
  const spec = specs.recall
  for (const name of OWNER_ONLY_SECRETS) assert.ok(![...spec.required, ...spec.optional].includes(name), name)
  const manifest = readFileSync(new URL('../../app.toml', import.meta.url), 'utf8')
  const line = manifest.split('\n').find((item) => item.startsWith('owner_machine_secrets = '))
  assert.deepEqual(JSON.parse(line.slice('owner_machine_secrets = '.length)).sort(), [...OWNER_ONLY_SECRETS].sort())
  for (const field of ['personal_secrets', 'manual_secrets', 'optional_secrets']) {
    const declared = manifest.split('\n').find((item) => item.startsWith(`${field} = `)) ?? ''
    for (const name of OWNER_ONLY_SECRETS) assert.ok(!declared.includes(name), `${field} ${name}`)
  }
})
