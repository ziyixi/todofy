// The shared deploy-vars core (../worker-deploy.mjs) on its own: each app's deploy/test keeps proving its wrapper end
// to end; these tests pin the declarations, including combinations no single app uses (every guard rule, several
// identifiers). Synthetic values and scratch app folders only; the stub in place of wrangler only records its arguments.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BUILD_SHA, SettingError, workerDeploy } from '../worker-deploy.mjs'

const CORE = new URL('../worker-deploy.mjs', import.meta.url).href
const AUD = 'a'.repeat(64)
const ZERO_AUD = '0'.repeat(64)
const D1 = '12345678-abcd-4def-8123-456789abcdef'
const ZERO_D1 = '00000000-0000-0000-0000-000000000000'

// A scratch app folder: <dir>/wrangler.toml with `config`, <dir>/worker/, and a wrapper at <dir>/deploy/deploy-vars.mjs.
function scratch(check, config = '') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-deploy-test-')))
  try {
    mkdirSync(join(dir, 'deploy'))
    mkdirSync(join(dir, 'worker'))
    writeFileSync(join(dir, 'wrangler.toml'), config)
    check(dir, pathToFileURL(join(dir, 'deploy', 'deploy-vars.mjs')).href)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const standard = (url, options = {}) => workerDeploy(url, {
  worker: 'watch', injected: [BUILD_SHA], owner: 'WATCH_ACCESS_OWNER', guard: { ACCESS_AUDIENCE: 'zeros' }, ...options,
})
const owner = { GITHUB_SHA: 'c'.repeat(40), WATCH_ACCESS_OWNER: 'owner@example.org', WATCH_ACCESS_OWNER_ALIASES: '' }

test('the wrapper reads the wrangler.toml beside its deploy/ folder and refuses an unknown guard', () => {
  scratch((dir, url) => {
    assert.equal(standard(url).CONFIG, join(dir, 'wrangler.toml'))
    for (const guard of [{ ACCESS_AUDIENCE: 'loose' }, { account_id: 'zeros' }, { toString: 'zeros' }]) {
      assert.throws(() => standard(url, { guard }), /Unknown deploy guard/)
    }
  })
})

test('injected rows become --var flags in their order; the commit may come from a repair source', () => {
  scratch((_, url) => {
    const toggle = { name: 'MODE', from: 'APP_MODE', kind: 'toggle', pattern: /^(?:on|off)$/ }
    const deploy = standard(url, { injected: [toggle, BUILD_SHA] })
    assert.deepEqual(deploy.INJECTED, [toggle, BUILD_SHA])
    assert.deepEqual(deploy.wranglerArgs({ ...owner, APP_MODE: 'off' }), ['--var', 'MODE:off', '--var', `BUILD_SHA:${'c'.repeat(40)}`])
    assert.equal(deploy.injectedVars({ ...owner, APP_MODE: 'on', BUILD_SOURCE_SHA: 'e'.repeat(40) }).BUILD_SHA, 'e'.repeat(40))
    for (const [name, env] of [['APP_MODE', { ...owner }], ['APP_MODE', { ...owner, APP_MODE: 'ON' }],
      ['BUILD_SOURCE_SHA', { ...owner, APP_MODE: 'on', BUILD_SOURCE_SHA: 'E'.repeat(40) }]]) {
      assert.throws(() => deploy.injectedVars(env), (error) => error instanceof SettingError && error.setting === name)
    }
  })
})

test('the owner inputs overlay the map: the aliases are checked first, then the owner, each refusal naming its input', () => {
  scratch((_, url) => {
    const deploy = standard(url)
    const env = { WATCH_ACCESS_OWNER: 'owner@example.org', WATCH_ACCESS_OWNER_ALIASES: ' b@example.org , c@example.org' }
    assert.deepEqual(deploy.generateSecrets(env), { ACCESS_OWNER: 'owner@example.org', ACCESS_OWNER_ALIASES: 'b@example.org,c@example.org' })
    assert.deepEqual(deploy.generateSecrets({ ...env, WATCH_WORKER_SECRETS: JSON.stringify({ ACCESS_OWNER: 'other@example.org' }) }).ACCESS_OWNER,
      'owner@example.org')
    assert.throws(() => deploy.generateSecrets({ ...env, WATCH_ACCESS_OWNER: 'x', WATCH_ACCESS_OWNER_ALIASES: 'x' }), { setting: 'WATCH_ACCESS_OWNER_ALIASES' })
    assert.throws(() => deploy.generateSecrets({ ...env, WATCH_ACCESS_OWNER: 'x' }), { setting: 'WATCH_ACCESS_OWNER' })
    assert.throws(() => deploy.generateSecrets({ ...env, WATCH_WORKER_SECRETS: JSON.stringify({ UNDECLARED: 'x' }) }), { setting: 'WATCH_WORKER_SECRETS' })
    assert.throws(() => standard(url, { worker: 'no-such-worker' }), /Unknown Worker secret declaration/)
  })
})

test('a personal secret row is checked after the owner and lands beside the owner values, over the map', () => {
  scratch((_, url) => {
    const deploy = standard(url, {
      worker: 'fleet', owner: 'FLEET_ACCESS_OWNER',
      secrets: [{ name: 'REPORT_HMAC_KEY', from: 'FLEET_REPORT_HMAC_KEY', pattern: /^[0-9a-f]{64}$/ }],
    })
    const env = { FLEET_ACCESS_OWNER: 'owner@example.org', FLEET_ACCESS_OWNER_ALIASES: '', FLEET_REPORT_HMAC_KEY: 'd'.repeat(64) }
    assert.deepEqual(deploy.generateSecrets(env), { ACCESS_OWNER: 'owner@example.org', ACCESS_OWNER_ALIASES: ' ', REPORT_HMAC_KEY: 'd'.repeat(64) })
    const map = { FLEET_WORKER_SECRETS: JSON.stringify({ REPORT_HMAC_KEY: 'e'.repeat(64) }) }
    assert.equal(deploy.generateSecrets({ ...env, ...map }).REPORT_HMAC_KEY, 'd'.repeat(64))
    assert.throws(() => deploy.generateSecrets({ ...env, FLEET_ACCESS_OWNER: 'x', FLEET_REPORT_HMAC_KEY: 'x' }), { setting: 'FLEET_ACCESS_OWNER' })
    for (const value of [undefined, 'd'.repeat(63), 'D'.repeat(64)]) {
      assert.throws(() => deploy.generateSecrets({ ...env, FLEET_REPORT_HMAC_KEY: value }),
        (error) => error instanceof SettingError && error.setting === 'FLEET_REPORT_HMAC_KEY', String(value))
    }
  })
})

test('a map that names an owner-only secret is refused by the map name', () => {
  scratch((_, url) => {
    // An owner-only secret is never a declared binding (worker-secrets.json), so a map naming one is refused as
    // undeclared first; this check is the second line. A declared name stands in for one here.
    const deploy = standard(url, { worker: 'recall', owner: 'RECALL_ACCESS_OWNER', ownerOnly: ['ACCESS_OWNER_ALIASES'] })
    assert.deepEqual(deploy.OWNER_ONLY_SECRETS, ['ACCESS_OWNER_ALIASES'])
    assert.deepEqual(standard(url).OWNER_ONLY_SECRETS, [])
    assert.throws(() => deploy.generateSecrets({ RECALL_ACCESS_OWNER: 'owner@example.org', RECALL_ACCESS_OWNER_ALIASES: '' }),
      (error) => error instanceof SettingError && error.setting === 'RECALL_WORKER_SECRETS')
  })
})

test('each guard rule: what refuses a real deploy and what refuses a dry run', () => {
  scratch((dir, url) => {
    const real = ['wrangler', 'deploy', '--config', '../wrangler.toml']
    const dry = [...real, '--dry-run']
    const worker = join(dir, 'worker')
    const texts = {
      absent: '# ACCESS_AUDIENCE = "' + AUD + '"\n',
      real: `ACCESS_AUDIENCE = "${AUD}"\n`,
      zeros: `ACCESS_AUDIENCE = "${ZERO_AUD}"\n`,
      malformed: 'ACCESS_AUDIENCE = "invalid"\n',
    }
    // [rule, text]: [placeholderIn, real deploy refused, dry run refused]
    const expected = {
      zeros: { absent: [null, false, false], real: [null, false, false], zeros: ['ACCESS_AUDIENCE', true, false], malformed: [null, false, false] },
      required: { absent: ['ACCESS_AUDIENCE', true, false], real: [null, false, false], zeros: ['ACCESS_AUDIENCE', true, false], malformed: ['ACCESS_AUDIENCE', true, false] },
      strict: { absent: ['ACCESS_AUDIENCE', true, false], real: [null, false, false], zeros: ['ACCESS_AUDIENCE', true, true], malformed: ['ACCESS_AUDIENCE', true, true] },
    }
    for (const [rule, cases] of Object.entries(expected)) {
      const deploy = standard(url, { guard: { ACCESS_AUDIENCE: rule } })
      for (const [label, [placeholder, realRefused, dryRefused]] of Object.entries(cases)) {
        const text = texts[label]
        assert.equal(deploy.placeholderIn(text), placeholder, `${rule} ${label}`)
        assert.equal(deploy.refusal(real, worker, () => text) !== null, realRefused, `${rule} ${label} real`)
        assert.equal(deploy.refusal(dry, worker, () => text) !== null, dryRefused, `${rule} ${label} dry`)
      }
    }
    assert.match(standard(url).refusal(real, worker, () => texts.zeros), /^ACCESS_AUDIENCE in the committed config is the all-zeros placeholder/)
    assert.match(standard(url, { guard: { ACCESS_AUDIENCE: 'required' } }).refusal(real, worker, () => texts.absent), /^ACCESS_AUDIENCE is missing/)

    // Several identifiers are checked in the declared order; a strict one later in the list still refuses a dry run.
    const both = standard(url, { guard: { database_id: 'zeros', ACCESS_AUDIENCE: 'strict' } })
    const zeroBoth = `database_id = "${ZERO_D1}"\nACCESS_AUDIENCE = "${ZERO_AUD}"\n`
    assert.equal(both.placeholderIn(zeroBoth), 'database_id')
    assert.match(both.refusal(dry, worker, () => zeroBoth), /^ACCESS_AUDIENCE /)
    assert.equal(both.placeholderIn(`database_id = "${D1}"\nACCESS_AUDIENCE = "${AUD}"\n`), null)
    assert.equal(both.refusal(dry, worker, () => `database_id = "${ZERO_D1}"\n`), null)
  })
})

test('only a deploy of the committed config, without --env, --keep-vars or its own --var, runs through the wrapper', () => {
  scratch((dir, url) => {
    const deploy = standard(url)
    const worker = join(dir, 'worker')
    const ok = ['wrangler', 'deploy', '--dry-run', '--config', '../wrangler.toml']
    assert.equal(deploy.refusal(ok, worker), null)
    assert.equal(deploy.refusal(['wrangler', 'deploy', `--config=${join(dir, 'wrangler.toml')}`], worker), null)
    for (const argv of [[], ['wrangler', 'deploy'], ['wrangler', 'secret', 'put', 'X', '--config', '../wrangler.toml'],
      ['wrangler', 'deploy', '--config', 'missing.toml'], ['wrangler', 'deploy', '-c'],
      ...['--env', '-e', '--env=x', '-ex', '--keep-vars', '--keep-vars=true', '--var', '--var=A:b'].map((flag) => [...ok, flag])]) {
      assert.notEqual(deploy.refusal(argv, worker), null, argv.join(' '))
    }
  }, `ACCESS_AUDIENCE = "${AUD}"\n`)
})

test('as a script the wrapper runs its commands, printing names only; imported, it runs nothing', () => {
  scratch((dir) => {
    const wrapper = join(dir, 'deploy', 'deploy-vars.mjs')
    writeFileSync(wrapper, `import { BUILD_SHA, workerDeploy } from ${JSON.stringify(CORE)}\n`
      + 'const deploy = workerDeploy(import.meta.url, { worker: \'fleet\', injected: [BUILD_SHA], owner: \'FLEET_ACCESS_OWNER\',\n'
      + '  secrets: [{ name: \'REPORT_HMAC_KEY\', from: \'FLEET_REPORT_HMAC_KEY\', pattern: /^[0-9a-f]{64}$/ }], guard: { ACCESS_AUDIENCE: \'strict\' } })\n'
      + 'export const { run } = deploy\ndeploy.main()\n')
    const stub = join(dir, 'stub.mjs')
    const recorded = join(dir, 'argv.json')
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2)))\n`)
    const env = { PATH: process.env.PATH, GITHUB_SHA: 'c'.repeat(40), FLEET_ACCESS_OWNER: 'owner@example.org', FLEET_ACCESS_OWNER_ALIASES: '', FLEET_REPORT_HMAC_KEY: 'd'.repeat(64) }
    const invoke = (args, extra = {}) => spawnSync(process.execPath, [wrapper, ...args], { cwd: join(dir, 'worker'), env: { ...env, ...extra }, encoding: 'utf8' })

    const secrets = join(dir, 'secrets.json')
    const written = invoke(['secrets', secrets])
    assert.equal(written.status, 0, written.stderr)
    assert.equal(written.stdout, 'Wrote the secrets file: ACCESS_OWNER, ACCESS_OWNER_ALIASES, REPORT_HMAC_KEY (values not printed).\n')
    const again = invoke(['secrets', secrets])
    assert.deepEqual([again.status, again.stderr], [1, 'The secrets file already exists; nothing was overwritten.\n'])
    const invalid = invoke(['check'], { FLEET_REPORT_HMAC_KEY: 'secret-looking-value' })
    assert.deepEqual([invalid.status, invalid.stderr], [1, 'Invalid or missing deploy setting: FLEET_REPORT_HMAC_KEY\n'])
    // The config has no AUD yet: a dry run runs the stub with the flag added, a real deploy is refused before it.
    const dry = invoke(['exec', '--', process.execPath, stub, 'deploy', '--dry-run', '--config', '../wrangler.toml'])
    assert.equal(dry.status, 0, dry.stderr)
    assert.deepEqual(JSON.parse(readFileSync(recorded, 'utf8')), ['deploy', '--dry-run', '--config', '../wrangler.toml', '--var', `BUILD_SHA:${'c'.repeat(40)}`])
    rmSync(recorded)
    const refused = invoke(['exec', '--', process.execPath, stub, 'deploy', '--config', '../wrangler.toml'])
    assert.equal(refused.status, 2)
    assert.match(refused.stderr, /^Refused: ACCESS_AUDIENCE is missing/)
    assert.ok(!existsSync(recorded))
    assert.equal(invoke(['nonsense']).status, 2)
    for (const result of [written, again, invalid, dry, refused]) {
      for (const value of ['owner@example.org', 'd'.repeat(64), 'c'.repeat(40), 'secret-looking-value']) {
        assert.ok(!(result.stdout + result.stderr).includes(value), 'printed a value')
      }
    }

    // Imported (as a test or drift_desired.py imports a wrapper), the same file runs no command.
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(wrapper).href)})`],
      { cwd: join(dir, 'worker'), env, encoding: 'utf8' })
    assert.deepEqual([imported.status, imported.stdout, imported.stderr], [0, '', ''])
  })
})
