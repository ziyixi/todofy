import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONFIG, INJECTED, SECRETS, SettingError, generateSecrets, injectedVars, refusal, run, secretsFileProblem, wranglerArgs, writeSecrets,
} from '../deploy-vars.mjs'

const WRAPPER = fileURLToPath(new URL('../deploy-vars.mjs', import.meta.url))
const CLOUDFLARE = fileURLToPath(new URL('../../cloudflare/', import.meta.url))
const SHA = 'c'.repeat(40)
// U+212A KELVIN SIGN: not printable ASCII, refused in Access identities (packages/edge-auth SPEC.md #36).

// Synthetic values only.
function environment() {
  return {
    GITHUB_SHA: SHA,
    MAIL_HERO_RECEIVE_ADDRESS: 'hero@inbox.example.org',
    MAIL_HERO_ACCESS_OWNER: 'owner@example.org',
    MAIL_HERO_ACCESS_OWNER_ALIASES: 'alias@example.org',
    MAIL_HERO_FORCE_SEND_PAUSED: 'false',
    MAIL_HERO_MAINTENANCE_MODE: 'false',
  }
}

function withTemp(body) {
  const dir = mkdtempSync(join(tmpdir(), 'mail-hero-deploy-vars-'))
  try { return body(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('two switches and the build are --var; the three personal values are Worker secrets', () => {
  assert.deepEqual(INJECTED.map(({ name, from, kind }) => [name, from, kind]), [
    ['FORCE_SEND_PAUSED', 'MAIL_HERO_FORCE_SEND_PAUSED', 'toggle'],
    ['MAINTENANCE_MODE', 'MAIL_HERO_MAINTENANCE_MODE', 'toggle'],
    ['BUILD_SHA', 'GITHUB_SHA', 'build'],
  ])
  assert.deepEqual(SECRETS.map(({ name, from, kind }) => [name, from, kind]), [
    ['RECEIVE_ADDRESS', 'MAIL_HERO_RECEIVE_ADDRESS', 'personal'],
    ['ACCESS_OWNER', 'MAIL_HERO_ACCESS_OWNER', 'personal'],
    ['ACCESS_OWNER_ALIASES', 'MAIL_HERO_ACCESS_OWNER_ALIASES', 'personal'],
  ])
  // .github/scripts/test_wrangler_configs.py reads this marker to check every CI step's env.
  const marked = {}
  for (const [, mode, names] of readFileSync(WRAPPER, 'utf8').matchAll(/^\/\/ deploy-vars-inputs (\w+): (.+)$/gm)) {
    marked[mode] = [...(marked[mode] ?? []), ...names.split(' ')]
  }
  assert.deepEqual(marked, { exec: INJECTED.map(({ from }) => from), secrets: SECRETS.map(({ from }) => from) })
})

test('valid values become --var flags in order; no personal value is ever a --var', () => {
  assert.deepEqual(injectedVars(environment()), { FORCE_SEND_PAUSED: 'false', MAINTENANCE_MODE: 'false', BUILD_SHA: SHA })
  assert.deepEqual(wranglerArgs({ ...environment(), MAIL_HERO_FORCE_SEND_PAUSED: 'true' }), [
    '--var', 'FORCE_SEND_PAUSED:true', '--var', 'MAINTENANCE_MODE:false', '--var', `BUILD_SHA:${SHA}`,
  ])
  // The flags never depend on (or carry) the personal values: those may even be absent here.
  const args = wranglerArgs({ GITHUB_SHA: SHA, MAIL_HERO_FORCE_SEND_PAUSED: 'false', MAIL_HERO_MAINTENANCE_MODE: 'true' }).join(' ')
  for (const { name } of SECRETS) assert.ok(!args.includes(name), name)
})

test('the secrets file holds the address, the owner and the normalized alias list', () => {
  assert.deepEqual(generateSecrets(environment()), {
    RECEIVE_ADDRESS: 'hero@inbox.example.org', ACCESS_OWNER: 'owner@example.org', ACCESS_OWNER_ALIASES: 'alias@example.org',
  })
  assert.equal(generateSecrets({ ...environment(), MAIL_HERO_ACCESS_OWNER_ALIASES: ' a@example.org , b@example.net ,' }).ACCESS_OWNER_ALIASES,
    'a@example.org,b@example.net')
  // No aliases: still uploaded (as one space, read as none), so the previous list never survives a deploy.
  for (const empty of ['', ' ']) {
    assert.equal(generateSecrets({ ...environment(), MAIL_HERO_ACCESS_OWNER_ALIASES: empty }).ACCESS_OWNER_ALIASES, ' ')
  }
})

test('a missing or invalid value fails by name and never shows the value', () => {
  const cases = [
    ...[...INJECTED, ...SECRETS].map(({ from }) => [from, undefined]),
    ['GITHUB_SHA', ''], ['GITHUB_SHA', 'main'], ['GITHUB_SHA', 'C'.repeat(40)], ['GITHUB_SHA', 'c'.repeat(39)], ['GITHUB_SHA', `${SHA}\n`],
    ['MAIL_HERO_RECEIVE_ADDRESS', ''], ['MAIL_HERO_RECEIVE_ADDRESS', 'not-an-address'], ['MAIL_HERO_RECEIVE_ADDRESS', 'hero@inbox.example.org\n'],
    ['MAIL_HERO_ACCESS_OWNER', ''], ['MAIL_HERO_ACCESS_OWNER', '\u212Aate@example.org'], ['MAIL_HERO_ACCESS_OWNER', 'ownér@example.org'],
    ['MAIL_HERO_ACCESS_OWNER', ' owner@example.org'],
    ['MAIL_HERO_ACCESS_OWNER_ALIASES', 'owner@example.org\ninjected-value'], ['MAIL_HERO_ACCESS_OWNER_ALIASES', 'alias@example.org,\u212Aim@example.net'],
    ['MAIL_HERO_ACCESS_OWNER_ALIASES', Array.from({ length: 9 }, (_, i) => `a${i}@example.org`).join(',')],
    ['MAIL_HERO_ACCESS_OWNER_ALIASES', Array.from({ length: 8 }, (_, i) => `${'x'.repeat(300)}${i}@example.org`).join(',')],
    ['MAIL_HERO_FORCE_SEND_PAUSED', ''], ['MAIL_HERO_FORCE_SEND_PAUSED', 'False'], ['MAIL_HERO_FORCE_SEND_PAUSED', '1'],
    ['MAIL_HERO_MAINTENANCE_MODE', ''], ['MAIL_HERO_MAINTENANCE_MODE', 'false '], ['MAIL_HERO_MAINTENANCE_MODE', 'yes'],
  ]
  for (const [name, value] of cases) {
    const env = { ...environment(), [name]: value }
    if (value === undefined) delete env[name]
    const personal = SECRETS.some(({ from }) => from === name)
    assert.throws(() => (personal ? generateSecrets(env) : wranglerArgs(env)), (error) => {
      assert.ok(error instanceof SettingError)
      assert.equal(error.message, `Invalid or missing deploy setting: ${name}`)
      return true
    }, `${name}=${JSON.stringify(value)}`)
  }
})

test('a secrets file must hold exactly the three valid personal values', () => withTemp((dir) => {
  const path = join(dir, 'secrets.json')
  const good = generateSecrets(environment())
  const problem = (content) => {
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
    return secretsFileProblem(path)
  }
  assert.equal(problem(good), null)
  assert.equal(problem({ ...good, ACCESS_OWNER_ALIASES: ' ' }), null)
  assert.match(secretsFileProblem(join(dir, 'absent.json')), /missing/)
  for (const content of [
    'not json', '[]', 'null',
    { RECEIVE_ADDRESS: good.RECEIVE_ADDRESS, ACCESS_OWNER: good.ACCESS_OWNER },
    { ...good, CREDENTIAL_KEY: '0'.repeat(64) },
    { ...good, RECEIVE_ADDRESS: '' }, { ...good, RECEIVE_ADDRESS: 'nobody' }, { ...good, RECEIVE_ADDRESS: 7 },
    { ...good, ACCESS_OWNER: '\u212Aate@example.org' }, { ...good, ACCESS_OWNER_ALIASES: '' },
    { ...good, ACCESS_OWNER_ALIASES: ' alias@example.org' }, { ...good, ACCESS_OWNER_ALIASES: 'a@example.org, b@example.org' },
  ]) assert.notEqual(problem(content), null, JSON.stringify(content))
  // A refusal never quotes a value.
  assert.ok(!problem({ ...good, RECEIVE_ADDRESS: 'secret-looking-value' }).includes('secret-looking-value'))
}))

test('only a deploy of mail-hero/wrangler.toml with one valid --secrets-file, without --env, --keep-vars or its own --var, may run', () => withTemp((dir) => {
  const secrets = join(dir, 'secrets.json')
  writeSecrets(secrets, environment())
  const deploy = ['npx', '--no-install', 'wrangler', 'deploy']
  const file = ['--secrets-file', secrets]
  assert.equal(refusal([...deploy, '--config', '../wrangler.toml', ...file], CLOUDFLARE), null)
  assert.equal(refusal([...deploy, '--dry-run', '--config=../wrangler.toml', '--outdir', '/tmp/x', `--secrets-file=${secrets}`], CLOUDFLARE), null)
  assert.equal(refusal([...deploy, '-c', CONFIG, '--secrets-file', relative(CLOUDFLARE, secrets)], CLOUDFLARE), null)
  for (const argv of [
    [],
    deploy,
    [...deploy, ...file],
    [...deploy, '--config', 'wrangler.toml', ...file],
    [...deploy, '--config', '../../todofy/wrangler.toml', ...file],
    // The personal values ride in the same upload, or the deploy does not run (it would drop them).
    [...deploy, '--config', '../wrangler.toml'],
    [...deploy, '--config', '../wrangler.toml', '--secrets-file'],
    [...deploy, '--config', '../wrangler.toml', ...file, ...file],
    [...deploy, '--config', '../wrangler.toml', '--secrets-file', join(dir, 'absent.json')],
    [...deploy, '--config', '../wrangler.toml', ...file, '--env', 'production'],
    [...deploy, '--config', '../wrangler.toml', ...file, '--env=production'],
    [...deploy, '--config', '../wrangler.toml', ...file, '-e', 'production'],
    [...deploy, '--config', '../wrangler.toml', ...file, '--keep-vars'],
    [...deploy, '--config', '../wrangler.toml', ...file, '--var', 'RECEIVE_ADDRESS:x@example.org'],
    ['npx', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', '../wrangler.toml', ...file],
  ]) assert.notEqual(refusal(argv, CLOUDFLARE), null, argv.join(' '))
}))

function runWrapper(args, env, cwd = CLOUDFLARE) {
  return spawnSync(process.execPath, [WRAPPER, ...args], { cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' })
}

test('exec runs the command unchanged plus the --var flags, and exits with its status', () => withTemp((dir) => {
  const out = join(dir, 'argv.json')
  const stub = join(dir, 'stub.mjs')
  writeFileSync(stub, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))\nprocess.exit(Number(process.env.STUB_STATUS ?? 0))\n`)
  chmodSync(stub, 0o755)
  const config = relative(CLOUDFLARE, CONFIG)
  const secrets = join(dir, 'secrets.json')

  const written = runWrapper(['secrets', secrets], environment())
  assert.equal(written.status, 0, written.stderr)
  assert.equal(statSync(secrets).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(readFileSync(secrets, 'utf8')), generateSecrets(environment()))
  const again = runWrapper(['secrets', secrets], environment())
  assert.equal(again.status, 1)
  assert.match(again.stderr, /already exists/)

  // The exec step needs only the switches and the build: the personal values reach it in the file.
  const execEnv = { GITHUB_SHA: SHA, MAIL_HERO_FORCE_SEND_PAUSED: 'false', MAIL_HERO_MAINTENANCE_MODE: 'false', STUB_STATUS: '3' }
  const command = ['exec', '--', process.execPath, stub, 'deploy', '--dry-run', '--config', config, '--secrets-file', secrets]
  const result = runWrapper(command, execEnv)
  assert.equal(result.status, 3, result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')),
    ['deploy', '--dry-run', '--config', config, '--secrets-file', secrets, ...wranglerArgs(environment())])

  // A refused command, a missing secrets file or a bad value never starts the command.
  rmSync(out)
  const refused = runWrapper(['exec', '--', process.execPath, stub, 'deploy', '--config', config, '--secrets-file', secrets, '--keep-vars'], execEnv)
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /Refused: --keep-vars/)
  const noFile = runWrapper(['exec', '--', process.execPath, stub, 'deploy', '--config', config], execEnv)
  assert.equal(noFile.status, 2)
  assert.match(noFile.stderr, /Refused: exactly one --secrets-file/)
  const invalid = runWrapper(command, { ...execEnv, MAIL_HERO_MAINTENANCE_MODE: 'secret-looking-value' })
  assert.equal(invalid.status, 1)
  assert.equal(invalid.stderr.trim(), 'Invalid or missing deploy setting: MAIL_HERO_MAINTENANCE_MODE')
  const bad = join(dir, 'bad.json')
  const badSecret = runWrapper(['secrets', bad], { ...environment(), MAIL_HERO_ACCESS_OWNER: 'secret-looking-value' })
  assert.equal(badSecret.status, 1)
  assert.equal(badSecret.stderr.trim(), 'Invalid or missing deploy setting: MAIL_HERO_ACCESS_OWNER')
  assert.ok(!existsSync(bad))
  assert.throws(() => readFileSync(out), /ENOENT/)

  const printed = [written, again, result, refused, noFile, invalid, badSecret].map(({ stdout, stderr }) => stdout + stderr).join('\n')
  for (const value of Object.values(environment())) assert.ok(!printed.includes(value), 'printed a value')
  assert.ok(!printed.includes('secret-looking-value'))
}))

test('check validates without printing values', () => {
  const ok = runWrapper(['check'], environment(), dirname(CONFIG))
  assert.equal(ok.status, 0, ok.stderr)
  for (const value of Object.values(environment())) assert.ok(!ok.stdout.includes(value))
  for (const name of ['MAIL_HERO_FORCE_SEND_PAUSED', 'MAIL_HERO_RECEIVE_ADDRESS']) {
    const env = environment()
    delete env[name]
    const missing = runWrapper(['check'], env, dirname(CONFIG))
    assert.equal(missing.status, 1)
    assert.equal(missing.stderr.trim(), `Invalid or missing deploy setting: ${name}`)
  }
  assert.equal(run(['nonsense'], environment()), 2)
})
