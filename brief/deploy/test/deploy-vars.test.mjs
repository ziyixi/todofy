// The deploy wrapper (../deploy-vars.mjs): mailsort's rules with the brief's inputs (MODE among them, with its archive
// mode), no real deploy without the Access AUD, and never the Claude or Resend key in a secrets file. Synthetic values
// only; the wrapper runs a stub instead of wrangler. (The owner rules are compared with the dashboard's wrapper in
// .github/scripts/test_wrangler_configs.py: an app reads no other app.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG, INJECTED, OWNER_ONLY_SECRETS, SettingError, generateSecrets, injectedVars, placeholderIn, refusal, run, wranglerArgs } from '../deploy-vars.mjs'

const WRAPPER = fileURLToPath(new URL('../deploy-vars.mjs', import.meta.url))
const WORKER = fileURLToPath(new URL('../../worker/', import.meta.url))

function environment() {
  return {
    GITHUB_SHA: 'c'.repeat(40),
    BRIEF_MODE: 'archive',
    BRIEF_ACCESS_OWNER: 'owner@example.org',
    BRIEF_ACCESS_OWNER_ALIASES: 'alias@example.org, second@example.net',
    BRIEF_FEEDBACK_SIGNING_KEY: 'e'.repeat(64),
    BRIEF_MAIL_FROM: 'Synthetic Brief <brief@example.net>',
    BRIEF_MAIL_TO: 'reader@example.org',
  }
}

test('the marker lists every input of each mode', () => {
  const marked = {}
  for (const [, mode, names] of readFileSync(WRAPPER, 'utf8').matchAll(/^\/\/ deploy-vars-inputs (\w+): (.+)$/gm)) {
    marked[mode] = [...(marked[mode] ?? []), ...names.trim().split(/\s+/)]
  }
  assert.deepEqual(marked, {
    exec: INJECTED.map(({ from }) => from),
    secrets: ['BRIEF_ACCESS_OWNER', 'BRIEF_ACCESS_OWNER_ALIASES', 'BRIEF_FEEDBACK_SIGNING_KEY', 'BRIEF_MAIL_FROM', 'BRIEF_MAIL_TO'],
  })
})

test('the mode and the build become --var flags; the mode is off, archive, shadow or live and the build the 40-hex commit', () => {
  assert.deepEqual(injectedVars(environment()), { MODE: 'archive', BUILD_SHA: 'c'.repeat(40) })
  assert.deepEqual(wranglerArgs(environment()), ['--var', 'MODE:archive', '--var', `BUILD_SHA:${'c'.repeat(40)}`])
  for (const value of ['off', 'archive', 'shadow', 'live']) assert.equal(injectedVars({ ...environment(), BRIEF_MODE: value }).MODE, value)
  for (const value of ['LIVE', 'on', 'paused', '', undefined]) {
    const env = { ...environment(), BRIEF_MODE: value }
    if (value === undefined) delete env.BRIEF_MODE
    assert.throws(() => injectedVars(env), /deploy setting: BRIEF_MODE$/, JSON.stringify(value))
  }
  for (const value of ['main', 'c'.repeat(39), '', undefined]) {
    const env = { ...environment(), GITHUB_SHA: value }
    if (value === undefined) delete env.GITHUB_SHA
    assert.throws(() => injectedVars(env), /deploy setting: GITHUB_SHA$/, JSON.stringify(value))
  }
})

test('the secrets file holds the owner, aliases, feedback key and mail addresses; invalid values are refused by name', () => {
  assert.deepEqual(generateSecrets(environment()), {
    ACCESS_OWNER: 'owner@example.org',
    ACCESS_OWNER_ALIASES: 'alias@example.org,second@example.net',
    FEEDBACK_SIGNING_KEY: 'e'.repeat(64),
    MAIL_FROM: 'Synthetic Brief <brief@example.net>',
    MAIL_TO: 'reader@example.org',
  })
  assert.equal(generateSecrets({ ...environment(), BRIEF_ACCESS_OWNER_ALIASES: '' }).ACCESS_OWNER_ALIASES, ' ')
  assert.equal(generateSecrets({ ...environment(), BRIEF_MAIL_FROM: 'brief@example.net' }).MAIL_FROM, 'brief@example.net')
  assert.equal(generateSecrets({ ...environment(), BRIEF_MAIL_FROM: '简报 <brief@example.net>' }).MAIL_FROM, '简报 <brief@example.net>')
  for (const [name, value] of [
    ['BRIEF_ACCESS_OWNER', undefined], ['BRIEF_ACCESS_OWNER', 'not-an-email'], ['BRIEF_ACCESS_OWNER', 'ówner@example.org'],
    ['BRIEF_ACCESS_OWNER_ALIASES', 'a@example.org,a@example.org'],
    ['BRIEF_FEEDBACK_SIGNING_KEY', 'e'.repeat(65)], ['BRIEF_FEEDBACK_SIGNING_KEY', undefined],
    ['BRIEF_MAIL_FROM', 'Brief <not an address>'], ['BRIEF_MAIL_FROM', 'Brief <brief@example.net>\r\nBcc: x@example.org'], ['BRIEF_MAIL_FROM', undefined],
    ['BRIEF_MAIL_TO', 'Reader <reader@example.org>'], ['BRIEF_MAIL_TO', 'two@example.org,three@example.org'], ['BRIEF_MAIL_TO', ''],
  ]) {
    const env = { ...environment(), [name]: value }
    if (value === undefined) delete env[name]
    assert.throws(() => generateSecrets(env), (error) => error instanceof SettingError && error.message === `Invalid or missing deploy setting: ${name}`, `${name} ${String(value)}`)
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
    [...deploy, '--dry-run', '--config', '../../dashboard/wrangler.toml'],
    [...deploy, '--config', '../wrangler.toml', '--env', 'production'],
    [...deploy, '--config', '../wrangler.toml', '--keep-vars'],
    [...deploy, '--config', '../wrangler.toml', '--var', 'BUILD_SHA:x'],
    ['npx', 'wrangler', 'secret', 'put', 'ANTHROPIC_API_KEY', '--config', '../wrangler.toml'],
  ]) assert.notEqual(refusal(argv, WORKER, () => real), null, argv.join(' '))
})

test('exec runs the deploy (or dry-run) unchanged plus the --var flags; secrets writes 0600 and never overwrites; nothing is printed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brief-deploy-vars-'))
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
    // while the config has none (before "Infra apply" creates the Access application).
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
    const invalid = spawnSync(process.execPath, [WRAPPER, 'secrets', bad], { env: { ...env, BRIEF_FEEDBACK_SIGNING_KEY: 'secret-looking-value' }, encoding: 'utf8' })
    assert.equal(invalid.stderr.trim(), 'Invalid or missing deploy setting: BRIEF_FEEDBACK_SIGNING_KEY')
    assert.ok(!existsSync(bad))

    const printed = [result, refused, written, again, invalid].map(({ stdout, stderr }) => stdout + stderr).join('\n')
    for (const value of Object.values(environment())) assert.ok(!printed.includes(value), 'printed a value')
    assert.ok(!printed.includes('secret-looking-value'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(run(['nonsense'], environment()), 2)
})

test('the Resend and provider keys never enter a secrets file: a BRIEF_WORKER_SECRETS map that names one is refused', () => {
  const secrets = generateSecrets(environment())
  for (const name of OWNER_ONLY_SECRETS) assert.ok(!Object.hasOwn(secrets, name), name)
  const complete = { ACCESS_OWNER: 'owner@example.org', CSRF_SIGNING_KEY: 'd'.repeat(64), FEEDBACK_SIGNING_KEY: 'e'.repeat(64), MAIL_FROM: 'brief@example.net', MAIL_TO: 'reader@example.org' }
  for (const name of OWNER_ONLY_SECRETS) {
    const env = { ...environment(), BRIEF_WORKER_SECRETS: JSON.stringify({ ...complete, [name]: 'synthetic' }) }
    assert.throws(() => generateSecrets(env), (error) => error instanceof SettingError && error.setting === 'BRIEF_WORKER_SECRETS', name)
  }
  // A complete map without them is accepted (a cold bootstrap's), the personal inputs taking precedence.
  const map = { ...environment(), BRIEF_WORKER_SECRETS: JSON.stringify({ ...complete, CSRF_SIGNING_KEY: 'f'.repeat(64) }) }
  assert.equal(Object.hasOwn(generateSecrets(map), 'CSRF_SIGNING_KEY'), false)
  assert.equal(generateSecrets(map).ACCESS_OWNER, environment().BRIEF_ACCESS_OWNER)
})

test('the public GitHub secrets spec excludes the owner-machine Resend key', () => {
  const specs = JSON.parse(readFileSync(new URL('../../../tools/cloud-config/worker-secrets.json', import.meta.url), 'utf8'))
  const spec = specs.brief
  assert.deepEqual(spec, { github_secret: 'BRIEF_WORKER_SECRETS', optional: ['ACCESS_OWNER_ALIASES'], required: ['ACCESS_OWNER', 'FEEDBACK_SIGNING_KEY', 'MAIL_FROM', 'MAIL_TO'] })
  for (const name of OWNER_ONLY_SECRETS) assert.ok(![...spec.required, ...spec.optional].includes(name), name)
  const manifest = readFileSync(new URL('../../app.toml', import.meta.url), 'utf8')
  const line = manifest.split('\n').find((item) => item.startsWith('owner_machine_secrets = '))
  assert.equal(line, `owner_machine_secrets = ${JSON.stringify(OWNER_ONLY_SECRETS).replaceAll(',', ', ')}`)
  for (const field of ['personal_secrets', 'manual_secrets', 'optional_secrets']) {
    const declared = manifest.split('\n').find((item) => item.startsWith(`${field} = `)) ?? ''
    for (const name of OWNER_ONLY_SECRETS) assert.ok(!declared.includes(name), `${field} ${name}`)
  }
})
