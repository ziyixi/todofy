import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONFIG, generateSecrets, injectedVars, placeholderIn, refusal, writeSecrets,
} from '../deploy-vars.mjs'

const environment = {
  GITHUB_SHA: 'a'.repeat(40),
  PERSONAL_MCP_ACCESS_OWNER: 'owner@example.com',
  PERSONAL_MCP_ACCESS_OWNER_ALIASES: '',
}

test('deploy pins the checked source, including the selected repair source', () => {
  assert.deepEqual(injectedVars(environment), { BUILD_SHA: 'a'.repeat(40) })
  assert.deepEqual(injectedVars({ ...environment, BUILD_SOURCE_SHA: 'b'.repeat(40) }), { BUILD_SHA: 'b'.repeat(40) })
  assert.throws(() => injectedVars({ ...environment, BUILD_SOURCE_SHA: 'invalid' }))
})

test('secrets contain only owner identities and clear removed aliases', () => {
  assert.deepEqual(generateSecrets(environment), { ACCESS_OWNER: 'owner@example.com', ACCESS_OWNER_ALIASES: ' ' })
  assert.equal(generateSecrets({ ...environment, PERSONAL_MCP_ACCESS_OWNER_ALIASES: 'other@example.com' }).ACCESS_OWNER_ALIASES,
    'other@example.com')
  for (const aliases of ['duplicate@example.com,duplicate@example.com', 'invalid', '姓名@example.com']) {
    assert.throws(() => generateSecrets({ ...environment, PERSONAL_MCP_ACCESS_OWNER_ALIASES: aliases }))
  }
})

test('missing or malformed owner cannot reach release', () => {
  for (const owner of ['', 'invalid', 'owner@example.com\nother@example.com']) {
    assert.throws(() => generateSecrets({ ...environment, PERSONAL_MCP_ACCESS_OWNER: owner }))
  }
})

test('placeholder audience is refused and a concrete audience is accepted', () => {
  assert.equal(placeholderIn(''), 'ACCESS_AUDIENCE')
  assert.equal(placeholderIn(`ACCESS_AUDIENCE = "${'0'.repeat(64)}"`), 'ACCESS_AUDIENCE')
  assert.equal(placeholderIn(`ACCESS_AUDIENCE = "${'a'.repeat(64)}"`), null)
})

test('only the committed production config and wrapper-injected vars may deploy', () => {
  const command = ['wrangler', 'deploy', '--config', CONFIG]
  for (const flags of [['--env', 'production'], ['--keep-vars'], ['--var', 'ACCESS_AUDIENCE:other']]) {
    assert.notEqual(refusal([...command, ...flags]), null)
  }
  assert.notEqual(refusal(['wrangler', 'deploy', '--config', '/tmp/another-config.toml']), null)
  const audienceMissing = !/^ACCESS_AUDIENCE\s*=/m.test(readFileSync(CONFIG, 'utf8'))
  if (audienceMissing) {
    assert.notEqual(refusal(command), null)
    assert.equal(refusal([...command, '--dry-run']), null)
  }
})

test('secrets file is owner-only and never overwrites an existing file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-mcp-deploy-'))
  const target = join(directory, 'secrets.json')
  try {
    writeSecrets(target, environment)
    assert.equal(statSync(target).mode & 0o777, 0o600)
    assert.throws(() => writeSecrets(target, environment), { code: 'EEXIST' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
