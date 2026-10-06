import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeWorkerSecrets, workerSecretSpec } from '../worker-secrets.mjs'

const applications = { dashboard: 'home', fleet: 'fleet', flowday: 'flowday', links: 'links', watch: 'watch', 'mail-hero': 'mail-hero', 'website/relay': 'ziyixi-notion-publish' }
const privateValue = 'synthetic-private-value'
class SettingError extends Error {
  constructor(name) { super(`Invalid deploy field: ${name}`); this.setting = name }
}

for (const [app, worker] of Object.entries(applications)) {
  const wrapper = await import(`../../../${app}/deploy/deploy-vars.mjs`)
  const prefix = app === 'mail-hero' ? 'MAIL_HERO' : app.toUpperCase()
  const environment = {
    GITHUB_SHA: 'a'.repeat(40), DASHBOARD_CANARY_ENABLED: 'false',
    MAIL_HERO_FORCE_SEND_PAUSED: 'false', MAIL_HERO_MAINTENANCE_MODE: 'true', MAIL_HERO_NATIVE_BACKUP_ENABLED: 'true',
    [`${prefix}_ACCESS_OWNER`]: 'owner@example.test', [`${prefix}_ACCESS_OWNER_ALIASES`]: '',
    [`${prefix}_CSRF_SIGNING_KEY`]: 'b'.repeat(64), [`${prefix}_CREDENTIAL_KEY`]: 'b'.repeat(64),
    FLEET_REPORT_HMAC_KEY: 'b'.repeat(64), DASHBOARD_CF_ANALYTICS_TOKEN: 'c'.repeat(40),
    MAIL_HERO_RECEIVE_ADDRESS: 'inbox@example.test',
  }
  test(`${worker}: a repair reports the requested source SHA and keeps the injected metadata`, () => {
    assert.equal(wrapper.injectedVars({ ...environment, BUILD_SOURCE_SHA: 'd'.repeat(40) }).BUILD_SHA, 'd'.repeat(40))
    assert.equal(wrapper.injectedVars({ ...environment, BUILD_SOURCE_SHA: '' }).BUILD_SHA, 'a'.repeat(40))
    assert.equal(wrapper.INJECTED.find(({ name }) => name === 'BUILD_SHA').from, 'GITHUB_SHA')
    for (const sha of ['main', 'D'.repeat(40), 'd'.repeat(39), 'd'.repeat(40) + '\n']) {
      assert.throws(() => wrapper.injectedVars({ ...environment, BUILD_SOURCE_SHA: sha }),
        (error) => error.setting === 'BUILD_SOURCE_SHA')
    }
  })
  test(`${worker}: complete maps add declared bindings and preserve validated personal input`, () => {
    const spec = workerSecretSpec(worker)
    const complete = Object.fromEntries(spec.required.map((name) => [name, privateValue]))
    const before = wrapper.generateSecrets(environment)
    const after = wrapper.generateSecrets({ ...environment, [spec.github_secret]: JSON.stringify(complete), REQUIRE_COMPLETE_WORKER_SECRETS: 'true' })
    for (const [name, value] of Object.entries(before)) assert.equal(after[name], value)
    for (const name of spec.required) assert.ok(after[name])
    assert.throws(() => wrapper.generateSecrets({ ...environment, REQUIRE_COMPLETE_WORKER_SECRETS: 'true' }),
      (error) => error.setting === spec.github_secret)
    for (const input of ['[1]', 'null', privateValue, JSON.stringify({ UNKNOWN: privateValue }), JSON.stringify({ [spec.required[0]]: 7 })]) {
      assert.throws(() => wrapper.generateSecrets({ ...environment, [spec.github_secret]: input }),
        (error) => error.setting === spec.github_secret && !error.message.includes(privateValue))
    }
  })
}

test('manual upstream keys are mandatory for a supplied Todofy core or Mail Hero map', () => {
  for (const worker of ['todofy-core', 'mail-hero']) {
    const spec = workerSecretSpec(worker)
    assert.throws(() => mergeWorkerSecrets(worker, { [spec.github_secret]: '{}' }, {}, SettingError),
      (error) => error.setting === spec.github_secret)
  }
})

test('the relay cutover strips exactly the three retired inputs and preserves its dispatch token', async () => {
  const wrapper = await import('../../../website/relay/deploy/deploy-vars.mjs')
  const legacy = {
    GITHUB_DISPATCH_TOKEN: privateValue,
    NOTION_TOKEN: 'synthetic-retired-token',
    NOTION_DATA_SOURCE_ID: 'synthetic-retired-source',
    NOTION_WEBHOOK_SECRET: 'synthetic-retired-webhook',
  }
  const env = { WEBSITE_RELAY_WORKER_SECRETS: JSON.stringify(legacy), REQUIRE_COMPLETE_WORKER_SECRETS: 'true' }
  assert.deepEqual(wrapper.generateSecrets(env), { GITHUB_DISPATCH_TOKEN: privateValue })
  assert.deepEqual(JSON.parse(env.WEBSITE_RELAY_WORKER_SECRETS), legacy)
  for (const input of [
    { ...legacy, NOTION_TOKEN_EXTRA: privateValue },
    { ...legacy, notion_token: privateValue },
    { ...legacy, GITHUB_DISPATCH_TOKEN: '' },
    { ...legacy, GITHUB_DISPATCH_TOKEN: 7 },
    { NOTION_TOKEN: privateValue },
  ]) {
    assert.throws(() => wrapper.generateSecrets({ ...env, WEBSITE_RELAY_WORKER_SECRETS: JSON.stringify(input) }),
      error => error.setting === 'WEBSITE_RELAY_WORKER_SECRETS' && !error.message.includes(privateValue))
  }
})

test('the relay CLI writes a complete private file without printing values or replacing an existing file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'worker-secret-test-'))
  try {
    const worker = 'ziyixi-notion-publish'
    const spec = workerSecretSpec(worker)
    const path = join(directory, 'secrets.json')
    const complete = Object.fromEntries(spec.required.map((name) => [name, privateValue]))
    const cli = fileURLToPath(new URL('../worker-secrets.mjs', import.meta.url))
    const invoke = () => spawnSync(process.execPath, [cli, 'secrets', worker, path], {
      env: { [spec.github_secret]: JSON.stringify(complete), REQUIRE_COMPLETE_WORKER_SECRETS: 'true' }, encoding: 'utf8',
    })
    const first = invoke()
    assert.equal(first.status, 0, first.stderr)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), complete)
    const again = invoke()
    assert.equal(again.status, 1)
    assert.match(again.stderr, /already exists/)
    for (const result of [first, again]) assert.ok(!(result.stdout + result.stderr).includes(privateValue))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})


test('the relay wrapper uploads one complete map and propagates the deployed source SHA', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-deploy-test-'))
  try {
    const spec = workerSecretSpec('ziyixi-notion-publish')
    const path = join(directory, 'secrets.json')
    const output = join(directory, 'args.json')
    const stub = join(directory, 'stub.mjs')
    const complete = Object.fromEntries(spec.required.map((name) => [name, privateValue]))
    const cli = fileURLToPath(new URL('../../../website/relay/deploy/deploy-vars.mjs', import.meta.url))
    const config = fileURLToPath(new URL('../../../website/relay/wrangler.toml', import.meta.url))
    const legacy = { ...complete, NOTION_TOKEN: privateValue, NOTION_DATA_SOURCE_ID: privateValue, NOTION_WEBHOOK_SECRET: privateValue }
    const env = { [spec.github_secret]: JSON.stringify(legacy), REQUIRE_COMPLETE_WORKER_SECRETS: 'true',
      GITHUB_SHA: 'a'.repeat(40), BUILD_SOURCE_SHA: 'b'.repeat(40) }
    const prepare = spawnSync(process.execPath, [cli, 'secrets', path], { env, encoding: 'utf8' })
    assert.equal(prepare.status, 0, prepare.stderr)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), complete)
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))\n`)
    const deploy = spawnSync(process.execPath,
      [cli, 'exec', '--', process.execPath, stub, 'deploy', '--config', config, '--secrets-file', path], { env, encoding: 'utf8' })
    assert.equal(deploy.status, 0, deploy.stderr)
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).slice(-2), ['--var', `BUILD_SHA:${'b'.repeat(40)}`])
    const refused = spawnSync(process.execPath,
      [cli, 'exec', '--', process.execPath, stub, 'deploy', '--config', config, '--env', 'preview'], { env, encoding: 'utf8' })
    assert.equal(refused.status, 2)
    for (const result of [prepare, deploy, refused]) assert.ok(!(result.stdout + result.stderr).includes(privateValue))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
