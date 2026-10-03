import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INJECTED, SettingError, generateSecrets, injectedVars, placeholderIn, refusal, wranglerArgs } from '../deploy-vars.mjs'

const WRAPPER = fileURLToPath(new URL('../deploy-vars.mjs', import.meta.url))
const WORKER = fileURLToPath(new URL('../../worker/', import.meta.url))

// Synthetic values only; subprocesses never invoke Wrangler or contact an account.
function environment() {
  return {
    GITHUB_SHA: 'c'.repeat(40),
    FLEET_ACCESS_OWNER: 'owner@example.org',
    FLEET_ACCESS_OWNER_ALIASES: 'alias@example.org, second@example.net',
    FLEET_REPORT_HMAC_KEY: 'd'.repeat(64),
  }
}

function temporary(check) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-deploy-test-')))
  try { check(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
}

function invoke(args, env = environment(), cwd = WORKER, wrapper = WRAPPER) {
  return spawnSync(process.execPath, [wrapper, ...args], {
    cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 10_000,
  })
}

test('only the exact source SHA becomes a plain var, and mode markers cover the independent private inputs', () => {
  const marked = {}
  for (const [, mode, names] of readFileSync(WRAPPER, 'utf8').matchAll(/^\/\/ deploy-vars-inputs (\w+): (.+)$/gm)) {
    marked[mode] = [...(marked[mode] ?? []), ...names.split(' ')]
  }
  assert.deepEqual(marked, {
    exec: ['GITHUB_SHA'],
    secrets: ['FLEET_ACCESS_OWNER', 'FLEET_ACCESS_OWNER_ALIASES', 'FLEET_REPORT_HMAC_KEY'],
  })
  assert.deepEqual(INJECTED.map(({ name, from }) => ({ name, from })), [{ name: 'BUILD_SHA', from: 'GITHUB_SHA' }])
  const env = { ...environment(), DEV_AUTH_BYPASS: 'true', DEV_NOW: 'synthetic', REPORT_HMAC_KEY: 'private' }
  assert.deepEqual(injectedVars(env), { BUILD_SHA: 'c'.repeat(40) })
  assert.deepEqual(wranglerArgs(env), ['--var', `BUILD_SHA:${'c'.repeat(40)}`])
  for (const value of ['main', 'C'.repeat(40), 'c'.repeat(39), 'c'.repeat(41), '', undefined]) {
    assert.throws(() => injectedVars({ ...env, GITHUB_SHA: value }),
      (error) => error instanceof SettingError && error.setting === 'GITHUB_SHA')
  }
})

test('owner aliases and the report key have bounded validation, and empty aliases overwrite old authorization', () => {
  assert.deepEqual(generateSecrets(environment()), {
    ACCESS_OWNER: 'owner@example.org', ACCESS_OWNER_ALIASES: 'alias@example.org,second@example.net',
    REPORT_HMAC_KEY: 'd'.repeat(64),
  })
  assert.equal(generateSecrets({ ...environment(), FLEET_ACCESS_OWNER_ALIASES: '' }).ACCESS_OWNER_ALIASES, ' ')
  const cases = [
    ['FLEET_ACCESS_OWNER', undefined], ['FLEET_ACCESS_OWNER', 'not-an-email'],
    ['FLEET_ACCESS_OWNER', 'Kate@example.org'], ['FLEET_ACCESS_OWNER', ' owner@example.org'],
    ['FLEET_ACCESS_OWNER_ALIASES', undefined], ['FLEET_ACCESS_OWNER_ALIASES', 'alias@example.org\ninjected'],
    ['FLEET_ACCESS_OWNER_ALIASES', 'a@example.org,a@example.org'],
    ['FLEET_ACCESS_OWNER_ALIASES', Array.from({ length: 9 }, (_, index) => `a${index}@example.org`).join(',')],
    ['FLEET_REPORT_HMAC_KEY', undefined], ['FLEET_REPORT_HMAC_KEY', 'd'.repeat(63)],
    ['FLEET_REPORT_HMAC_KEY', 'z'.repeat(64)],
  ]
  for (const [name, value] of cases) {
    assert.throws(() => generateSecrets({ ...environment(), [name]: value }),
      (error) => error instanceof SettingError && error.message === `Invalid or missing deploy setting: ${name}`, name)
  }
})

test('a wrapper cannot switch config, environment, keep-vars, or inject an unauthorized plain var', () => {
  const deploy = ['npx', '--no-install', 'wrangler', 'deploy', '--dry-run', '--config', '../wrangler.toml']
  assert.equal(refusal(deploy, WORKER), null)
  for (const args of [
    [], ['npx', 'wrangler', 'deploy'], ['npx', 'wrangler', 'secret', 'put', 'REPORT_HMAC_KEY'],
    [...deploy.slice(0, -2), '--config', 'missing.toml'],
    ...['--env', '-e', '--env=production', '-ex', '--keep-vars', '--keep-vars=true',
      '--var', '--var=DEV_AUTH_BYPASS:true'].map((flag) => [...deploy, flag, 'synthetic']),
  ]) assert.notEqual(refusal(args, WORKER), null, args.join(' '))
})

test('a missing AUD permits only dry runs; real, zero and malformed AUD cases cannot bypass the deployment gate', () => {
  temporary((directory) => {
    const deploy = join(directory, 'deploy')
    const worker = join(directory, 'worker')
    mkdirSync(deploy)
    mkdirSync(worker)
    const wrapper = join(deploy, 'deploy-vars.mjs')
    const output = join(directory, 'executed.json')
    const stub = join(directory, 'stub.mjs')
    writeFileSync(wrapper, readFileSync(WRAPPER))
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))\n`)
    for (const [aud, dry, accepted] of [
      [null, true, true], [null, false, false], ['a'.repeat(64), true, true], ['a'.repeat(64), false, true],
      ['0'.repeat(64), true, false], ['0'.repeat(64), false, false], ['invalid', true, false],
    ]) {
      const text = '# ACCESS_AUDIENCE = "' + 'a'.repeat(64) + '"\n[vars]\n'
        + (aud === null ? '' : `ACCESS_AUDIENCE = "${aud}"\n`)
      writeFileSync(join(directory, 'wrangler.toml'), text)
      rmSync(output, { force: true })
      const command = [process.execPath, stub, 'deploy', '--config', '../wrangler.toml']
      if (dry) command.push('--dry-run')
      const result = invoke(['exec', '--', ...command], environment(), worker, wrapper)
      assert.equal(result.status, accepted ? 0 : 2, `${aud === null ? 'missing' : 'present'} AUD; dry=${dry}: ${result.stderr}`)
      assert.equal(existsSync(output), accepted)
      if (accepted) {
        assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), [...command.slice(2), ...wranglerArgs(environment())])
      } else assert.match(result.stderr, /ACCESS_AUDIENCE/)
    }
    assert.equal(placeholderIn('  # ACCESS_AUDIENCE = "' + 'a'.repeat(64) + '"\n'), 'ACCESS_AUDIENCE')
  })
})

test('private files are owner-only and never overwritten; every CLI failure and success prints names without values', () => {
  temporary((directory) => {
    const env = environment()
    const secrets = join(directory, 'secrets.json')
    const checked = invoke(['check'])
    assert.equal(checked.status, 0, checked.stderr)
    const written = invoke(['secrets', secrets])
    assert.equal(written.status, 0, written.stderr)
    assert.equal(statSync(secrets).mode & 0o777, 0o600)
    const saved = readFileSync(secrets, 'utf8')
    assert.deepEqual(JSON.parse(saved), generateSecrets(env))
    const again = invoke(['secrets', secrets], { ...env, FLEET_REPORT_HMAC_KEY: 'e'.repeat(64) })
    assert.equal(again.status, 1)
    assert.match(again.stderr, /already exists/)
    assert.equal(readFileSync(secrets, 'utf8'), saved)
    const bad = join(directory, 'bad.json')
    const invalid = invoke(['secrets', bad], { ...env, FLEET_REPORT_HMAC_KEY: 'secret-looking-value' })
    assert.equal(invalid.status, 1)
    assert.equal(invalid.stderr.trim(), 'Invalid or missing deploy setting: FLEET_REPORT_HMAC_KEY')
    assert.ok(!existsSync(bad))
    const printed = [checked, written, again, invalid].map(({ stdout, stderr }) => stdout + stderr).join('\n')
    for (const value of [...Object.values(env), ...Object.values(generateSecrets(env)), 'e'.repeat(64), 'secret-looking-value']) {
      assert.ok(!printed.includes(value), 'printed a private or injected value')
    }
  })
})

test('exec propagates a failed child rather than reporting a successful deployment', () => {
  temporary((directory) => {
    const stub = join(directory, 'fail.mjs')
    writeFileSync(stub, 'process.exitCode = 7\n')
    const result = invoke(['exec', '--', process.execPath, stub, 'deploy', '--dry-run', '--config', '../wrangler.toml'])
    assert.equal(result.status, 7, result.stderr)
    assert.ok(!result.stdout.includes(environment().GITHUB_SHA))
    assert.ok(!result.stdout.includes(environment().FLEET_REPORT_HMAC_KEY))
  })
})
