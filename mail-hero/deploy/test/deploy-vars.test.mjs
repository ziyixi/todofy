import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG, INJECTED, SettingError, injectedVars, refusal, wranglerArgs } from '../deploy-vars.mjs'

const WRAPPER = fileURLToPath(new URL('../deploy-vars.mjs', import.meta.url))
const CLOUDFLARE = fileURLToPath(new URL('../../cloudflare/', import.meta.url))

// Synthetic values only.
function environment() {
  return {
    MAIL_HERO_RECEIVE_ADDRESS: 'hero@inbox.example.org',
    MAIL_HERO_ACCESS_OWNER: 'owner@example.org',
    MAIL_HERO_ACCESS_OWNER_ALIASES: 'alias@example.org',
    MAIL_HERO_FORCE_SEND_PAUSED: 'false',
    MAIL_HERO_MAINTENANCE_MODE: 'false',
  }
}

test('the five injected vars: three personal values and the two operational switches', () => {
  assert.deepEqual(INJECTED.map(({ name, from, kind }) => [name, from, kind]), [
    ['RECEIVE_ADDRESS', 'MAIL_HERO_RECEIVE_ADDRESS', 'personal'],
    ['ACCESS_OWNER', 'MAIL_HERO_ACCESS_OWNER', 'personal'],
    ['ACCESS_OWNER_ALIASES', 'MAIL_HERO_ACCESS_OWNER_ALIASES', 'personal'],
    ['FORCE_SEND_PAUSED', 'MAIL_HERO_FORCE_SEND_PAUSED', 'toggle'],
    ['MAINTENANCE_MODE', 'MAIL_HERO_MAINTENANCE_MODE', 'toggle'],
  ])
  // .github/scripts/test_wrangler_configs.py reads this marker to check every CI step's env.
  const marked = [...readFileSync(WRAPPER, 'utf8').matchAll(/^\/\/ deploy-vars-inputs (\w+): (.+)$/gm)]
  assert.deepEqual(marked.map(([, mode]) => mode), ['exec', 'exec'])
  assert.deepEqual(marked.flatMap(([, , names]) => names.split(' ')), INJECTED.map(({ from }) => from))
})

test('valid values become --var flags in order, the alias list normalized', () => {
  assert.deepEqual(injectedVars(environment()), {
    RECEIVE_ADDRESS: 'hero@inbox.example.org', ACCESS_OWNER: 'owner@example.org', ACCESS_OWNER_ALIASES: 'alias@example.org',
    FORCE_SEND_PAUSED: 'false', MAINTENANCE_MODE: 'false',
  })
  assert.deepEqual(wranglerArgs({ ...environment(), MAIL_HERO_FORCE_SEND_PAUSED: 'true' }), [
    '--var', 'RECEIVE_ADDRESS:hero@inbox.example.org', '--var', 'ACCESS_OWNER:owner@example.org',
    '--var', 'ACCESS_OWNER_ALIASES:alias@example.org', '--var', 'FORCE_SEND_PAUSED:true', '--var', 'MAINTENANCE_MODE:false',
  ])
  assert.equal(injectedVars({ ...environment(), MAIL_HERO_ACCESS_OWNER_ALIASES: ' a@example.org , b@example.net ,' }).ACCESS_OWNER_ALIASES,
    'a@example.org,b@example.net')
  // No aliases: the var is still sent, as "", so the previous list never survives a deploy.
  for (const empty of ['', ' ']) {
    assert.equal(injectedVars({ ...environment(), MAIL_HERO_ACCESS_OWNER_ALIASES: empty }).ACCESS_OWNER_ALIASES, '')
  }
  assert.ok(wranglerArgs({ ...environment(), MAIL_HERO_ACCESS_OWNER_ALIASES: '' }).includes('ACCESS_OWNER_ALIASES:'))
})

test('a missing or invalid value fails by name and never shows the value', () => {
  const cases = [
    ...INJECTED.map(({ from }) => [from, undefined]),
    ['MAIL_HERO_RECEIVE_ADDRESS', ''], ['MAIL_HERO_RECEIVE_ADDRESS', 'not-an-address'], ['MAIL_HERO_RECEIVE_ADDRESS', 'hero@inbox.example.org\n'],
    ['MAIL_HERO_ACCESS_OWNER', ''], ['MAIL_HERO_ACCESS_OWNER', 'Kate@example.org'], ['MAIL_HERO_ACCESS_OWNER', 'ownér@example.org'],
    ['MAIL_HERO_ACCESS_OWNER', ' owner@example.org'],
    ['MAIL_HERO_ACCESS_OWNER_ALIASES', 'owner@example.org\ninjected-value'], ['MAIL_HERO_ACCESS_OWNER_ALIASES', 'alias@example.org,Kim@example.net'],
    ['MAIL_HERO_ACCESS_OWNER_ALIASES', Array.from({ length: 9 }, (_, i) => `a${i}@example.org`).join(',')],
    ['MAIL_HERO_ACCESS_OWNER_ALIASES', Array.from({ length: 8 }, (_, i) => `${'x'.repeat(300)}${i}@example.org`).join(',')],
    ['MAIL_HERO_FORCE_SEND_PAUSED', ''], ['MAIL_HERO_FORCE_SEND_PAUSED', 'False'], ['MAIL_HERO_FORCE_SEND_PAUSED', '1'],
    ['MAIL_HERO_MAINTENANCE_MODE', ''], ['MAIL_HERO_MAINTENANCE_MODE', 'false '], ['MAIL_HERO_MAINTENANCE_MODE', 'yes'],
  ]
  for (const [name, value] of cases) {
    const env = { ...environment(), [name]: value }
    if (value === undefined) delete env[name]
    assert.throws(() => wranglerArgs(env), (error) => {
      assert.ok(error instanceof SettingError)
      assert.equal(error.message, `Invalid or missing deploy setting: ${name}`)
      return true
    }, `${name}=${JSON.stringify(value)}`)
  }
})

test('only a deploy of mail-hero/wrangler.toml, without --env, --keep-vars or its own --var, may run', () => {
  const deploy = ['npx', '--no-install', 'wrangler', 'deploy']
  assert.equal(refusal([...deploy, '--config', '../wrangler.toml'], CLOUDFLARE), null)
  assert.equal(refusal([...deploy, '--dry-run', '--config=../wrangler.toml', '--outdir', '/tmp/x'], CLOUDFLARE), null)
  assert.equal(refusal([...deploy, '-c', CONFIG]), null)
  for (const argv of [
    [],
    deploy,
    [...deploy, '--config', 'wrangler.toml'],
    [...deploy, '--config', '../../todofy/wrangler.toml'],
    [...deploy, '--config', '../wrangler.toml', '--env', 'production'],
    [...deploy, '--config', '../wrangler.toml', '--env=production'],
    [...deploy, '--config', '../wrangler.toml', '-e', 'production'],
    [...deploy, '--config', '../wrangler.toml', '--keep-vars'],
    [...deploy, '--config', '../wrangler.toml', '--var', 'RECEIVE_ADDRESS:x@example.org'],
    ['npx', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', '../wrangler.toml'],
  ]) assert.notEqual(refusal(argv, CLOUDFLARE), null, argv.join(' '))
})

function runWrapper(args, env, cwd = CLOUDFLARE) {
  return spawnSync(process.execPath, [WRAPPER, ...args], { cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' })
}

test('exec runs the command unchanged plus the --var flags, and exits with its status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-hero-deploy-vars-'))
  try {
    const out = join(dir, 'argv.json')
    const stub = join(dir, 'stub.mjs')
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))\nprocess.exit(Number(process.env.STUB_STATUS ?? 0))\n`)
    chmodSync(stub, 0o755)
    const config = relative(CLOUDFLARE, CONFIG)
    const result = runWrapper(['exec', '--', process.execPath, stub, 'deploy', '--dry-run', '--config', config], { ...environment(), STUB_STATUS: '3' })
    assert.equal(result.status, 3, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), ['deploy', '--dry-run', '--config', config, ...wranglerArgs(environment())])
    for (const value of Object.values(environment())) assert.ok(!(result.stdout + result.stderr).includes(value), 'printed a value')

    // A refused command or a bad value never starts the command.
    rmSync(out)
    const refused = runWrapper(['exec', '--', process.execPath, stub, 'deploy', '--config', config, '--keep-vars'], environment())
    assert.equal(refused.status, 2)
    assert.match(refused.stderr, /Refused: --keep-vars/)
    const invalid = runWrapper(['exec', '--', process.execPath, stub, 'deploy', '--config', config], { ...environment(), MAIL_HERO_MAINTENANCE_MODE: 'secret-looking-value' })
    assert.equal(invalid.status, 1)
    assert.equal(invalid.stderr.trim(), 'Invalid or missing deploy setting: MAIL_HERO_MAINTENANCE_MODE')
    assert.ok(!invalid.stderr.includes('secret-looking-value'))
    assert.throws(() => readFileSync(out), /ENOENT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check validates without printing values', () => {
  const ok = runWrapper(['check'], environment(), dirname(CONFIG))
  assert.equal(ok.status, 0, ok.stderr)
  for (const value of Object.values(environment())) assert.ok(!ok.stdout.includes(value))
  const missing = runWrapper(['check'], { ...environment(), MAIL_HERO_FORCE_SEND_PAUSED: undefined }, dirname(CONFIG))
  assert.equal(missing.status, 1)
})
