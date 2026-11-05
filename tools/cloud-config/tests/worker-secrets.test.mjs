import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeWorkerSecrets, workerSecretSpec, validWorkerSecrets } from '../worker-secrets.mjs'

const NODE_EXECUTABLE = process.env.JS_BINARY__NODE_BINARY ?? process.execPath;

const applications = { dashboard: 'home', fleet: 'fleet', links: 'links', watch: 'watch', 'mail-hero': 'mail-hero', 'website/relay': 'ziyixi-notion-publish' }
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

test('Mail Hero retains required keys while old Todofy maps lose only the retired core fields', () => {
  const mail = workerSecretSpec('mail-hero')
  assert.throws(() => mergeWorkerSecrets('mail-hero', { [mail.github_secret]: '{}' }, {}, SettingError),
    (error) => error.setting === mail.github_secret)
  const core = workerSecretSpec('todofy-core')
  assert.deepEqual(mergeWorkerSecrets('todofy-core', { [core.github_secret]: '{}' }, {}, SettingError), {})
  const retired = ['GEMINI_API_KEY', 'TODOIST_API_KEY', 'TODOIST_DEFAULT_PROJECT_ID', 'TODOIST_OPS_PROJECT_ID',
    'TODOIST_REVIEW_PROJECT_ID']
  for (const name of retired) assert.equal(validWorkerSecrets('todofy-core', { [name]: privateValue }, false), false)
  for (const value of [privateValue, 7, '']) {
    const legacy = Object.fromEntries(retired.map((name) => [name, value]))
    assert.deepEqual(mergeWorkerSecrets('todofy-core', { [core.github_secret]: JSON.stringify(legacy) }, {}, SettingError), {})
  }
  for (const name of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY_EXTRA', 'gemini_api_key']) {
    assert.throws(() => mergeWorkerSecrets('todofy-core', { [core.github_secret]: JSON.stringify({ GEMINI_API_KEY: privateValue, [name]: privateValue }) }, {}, SettingError),
      error => error.setting === core.github_secret && !error.message.includes(privateValue), name)
  }
})

test('Router provider credentials cannot enter its GitHub deployment map', () => {
  const spec = workerSecretSpec('model-router')
  for (const name of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY']) {
    assert.ok(![...spec.required, ...spec.optional].includes(name))
    assert.throws(() => mergeWorkerSecrets('model-router', { [spec.github_secret]: JSON.stringify({ ACCESS_OWNER: 'owner@example.test', [name]: privateValue }) }, {}, SettingError),
      error => error.setting === spec.github_secret && !error.message.includes(privateValue), name)
  }
})

test('keyless owner maps drop only the exact retired CSRF binding and preserve strict validation', () => {
  for (const worker of ['home', 'links', 'watch', 'mailsort', 'recall', 'tasks', 'todofy', 'model-router']) {
    const spec = workerSecretSpec(worker)
    const complete = Object.fromEntries(spec.required.map(name => [name, privateValue]))
    const legacy = { ...complete, CSRF_SIGNING_KEY: 7 }
    const env = { [spec.github_secret]: JSON.stringify(legacy) }
    assert.deepEqual(mergeWorkerSecrets(worker, env, {}, SettingError), complete, worker)
    assert.deepEqual(JSON.parse(env[spec.github_secret]), legacy)
    for (const extra of ['csrf_signing_key', 'CSRF_SIGNING_KEY_EXTRA', 'UNDECLARED']) {
      assert.throws(() => mergeWorkerSecrets(worker, { [spec.github_secret]: JSON.stringify({ ...legacy, [extra]: privateValue }) }, {}, SettingError),
        error => error.setting === spec.github_secret && !error.message.includes(privateValue), `${worker}.${extra}`)
    }
    assert.throws(() => mergeWorkerSecrets(worker, { [spec.github_secret]: JSON.stringify({ ...legacy, [spec.required[0]]: 7 }) }, {}, SettingError),
      error => error.setting === spec.github_secret, worker)
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
    const invoke = () => spawnSync(NODE_EXECUTABLE, ['--preserve-symlinks-main', cli, 'secrets', worker, path], {
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
    const prepare = spawnSync(NODE_EXECUTABLE, ['--preserve-symlinks-main', cli, 'secrets', path], { env, encoding: 'utf8' })
    assert.equal(prepare.status, 0, prepare.stderr)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), complete)
    writeFileSync(stub, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))\n`)
    const deploy = spawnSync(NODE_EXECUTABLE,
      ['--preserve-symlinks-main', cli, 'exec', '--', NODE_EXECUTABLE, stub, 'deploy', '--config', config, '--secrets-file', path], { env, encoding: 'utf8' })
    assert.equal(deploy.status, 0, deploy.stderr)
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).slice(-2), ['--var', `BUILD_SHA:${'b'.repeat(40)}`])
    const refused = spawnSync(NODE_EXECUTABLE,
      ['--preserve-symlinks-main', cli, 'exec', '--', NODE_EXECUTABLE, stub, 'deploy', '--config', config, '--env', 'preview'], { env, encoding: 'utf8' })
    assert.equal(refused.status, 2)
    for (const result of [prepare, deploy, refused]) assert.ok(!(result.stdout + result.stderr).includes(privateValue))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a borrowed owner identity takes only the identity from its source map, which must be valid for the source', () => {
  const spec = workerSecretSpec('newsletter-console')
  assert.equal(spec.identity_from, 'home')
  assert.equal(spec.github_secret, workerSecretSpec('home').github_secret)
  const home = { ACCESS_OWNER: 'owner@example.test', ACCESS_OWNER_ALIASES: 'alias@example.test', CF_ANALYTICS_TOKEN: privateValue, CSRF_SIGNING_KEY: privateValue }
  const env = { [spec.github_secret]: JSON.stringify(home) }
  assert.deepEqual(mergeWorkerSecrets('newsletter-console', env, {}, SettingError),
    { ACCESS_OWNER: 'owner@example.test', ACCESS_OWNER_ALIASES: 'alias@example.test' })
  // Identity secrets win over the map, as they do for the source itself; a partial source map is fine.
  assert.deepEqual(mergeWorkerSecrets('newsletter-console', { [spec.github_secret]: JSON.stringify({ CF_ANALYTICS_TOKEN: privateValue }) },
    { ACCESS_OWNER: 'other@example.test' }, SettingError), { ACCESS_OWNER: 'other@example.test' })
  assert.deepEqual(JSON.parse(env[spec.github_secret]), home)
  for (const input of [{ ...home, UNDECLARED: privateValue }, { ...home, CF_ANALYTICS_TOKEN: 7 }, { CF_ANALYTICS_TOKEN: privateValue }]) {
    assert.throws(() => mergeWorkerSecrets('newsletter-console', { [spec.github_secret]: JSON.stringify(input) }, {}, SettingError),
      (error) => error.setting === spec.github_secret && !error.message.includes(privateValue))
  }
  assert.equal(validWorkerSecrets('newsletter-console', { CF_ANALYTICS_TOKEN: privateValue }, false), false)
})
