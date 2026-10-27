import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CONFIG, generateSecrets, injectedVars, placeholderIn, refusal } from '../deploy-vars.mjs'

const secrets = { ACCESS_OWNER: 'owner@example.test', CSRF_SIGNING_KEY: 'ab'.repeat(32) }

test('release requires its complete owner map and leaves owner-machine provider secrets out', () => {
  assert.deepEqual(generateSecrets({ MODEL_ROUTER_WORKER_SECRETS: JSON.stringify(secrets) }), { ...secrets, ACCESS_OWNER_ALIASES: ' ' })
  assert.throws(() => generateSecrets({}), /MODEL_ROUTER_WORKER_SECRETS/)
  assert.throws(() => generateSecrets({ MODEL_ROUTER_WORKER_SECRETS: JSON.stringify({ ...secrets, ANTHROPIC_API_KEY_BRIEF: 'synthetic' }) }), /MODEL_ROUTER_WORKER_SECRETS/)
})

test('release identity uses the selected source SHA and refuses caller overrides', () => {
  assert.deepEqual(injectedVars({ GITHUB_SHA: 'a'.repeat(40), BUILD_SOURCE_SHA: 'b'.repeat(40) }), { BUILD_SHA: 'b'.repeat(40) })
  assert.match(refusal(['wrangler', 'deploy', '--env', 'other']), /--env/)
  assert.match(refusal(['wrangler', 'deploy', '--keep-vars']), /--keep-vars/)
  assert.match(refusal(['wrangler', 'deploy', '--var', 'BUILD_SHA:other']), /--var/)
})

test('actual resource identities are required before any real release', () => {
  assert.equal(placeholderIn('database_id = ""'), 'database_id')
  assert.equal(placeholderIn('database_id = "00000000-0000-0000-0000-000000000000"'), 'database_id')
  const database = 'database_id = "11111111-1111-4111-8111-111111111111"\n'
  assert.equal(placeholderIn(database), 'ACCESS_AUDIENCE')
  assert.equal(placeholderIn(database + `ACCESS_AUDIENCE = "${'a'.repeat(64)}"`), null)
})

test('production has one private domain and private storage without previews', () => {
  const config = readFileSync(CONFIG, 'utf8')
  assert.match(config, /workers_dev = false/)
  assert.match(config, /preview_urls = false/)
  assert.match(config, /run_worker_first = true/)
  assert.match(config, /binding = "REQUEST_BODIES"/)
  assert.match(config, /new_sqlite_classes = \["RouterEngine"\]/)
  assert.doesNotMatch(config, /\[env\.|keep_vars|DEV_AUTH_BYPASS/)
})
