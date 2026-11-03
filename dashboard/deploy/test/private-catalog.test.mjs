import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The bundle the release archive ships (//dashboard:private_catalog_cli), run as the release step runs it.
const NODE_EXECUTABLE = process.env.JS_BINARY__NODE_BINARY ?? process.execPath
const CLI = fileURLToPath(new URL('../../tools/private-catalog.mjs', import.meta.url))
const FIXTURE = readFileSync(new URL('../../worker/test/fixtures/private-catalog.json', import.meta.url), 'utf8')
// Synthetic values only.
const SECRETS = { ACCESS_OWNER: 'owner@example.org', CF_ANALYTICS_TOKEN: 'synthetic-analytics-value' }

function attach(raw, secrets = SECRETS, catalogFile) {
  const directory = mkdtempSync(join(tmpdir(), 'private-catalog-'))
  try {
    const path = join(directory, 'home-secrets.json')
    writeFileSync(path, JSON.stringify(secrets), { mode: 0o600 })
    const args = [CLI, path]
    if (catalogFile !== undefined) {
      const catalogPath = join(directory, 'catalogue.json')
      if (catalogFile !== null) writeFileSync(catalogPath, catalogFile, { mode: 0o600 })
      args.push(catalogPath)
    }
    const result = spawnSync(NODE_EXECUTABLE, args, {
      env: raw === undefined ? {} : { PRIVATE_CATALOG: raw }, encoding: 'utf8',
    })
    return { ...result, file: JSON.parse(readFileSync(path, 'utf8')), mode: statSync(path).mode & 0o777 }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function edited(edit) {
  const value = JSON.parse(FIXTURE)
  edit(value)
  return JSON.stringify(value)
}

test('a valid registration is added to the owner-only secrets file without printing any value', () => {
  const result = attach(FIXTURE)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.file, { ...SECRETS, PRIVATE_CATALOG: FIXTURE })
  assert.equal(result.mode, 0o600)
  for (const value of [...Object.values(SECRETS), 'demo-edge-one', 'demo-one.ziyixi.science']) {
    assert.ok(!(result.stdout + result.stderr).includes(value))
  }
})

test('the selected source file replaces older environment and map registrations', () => {
  const secrets = { ...SECRETS, PRIVATE_CATALOG: '{"invalid":"synthetic-private-value"}' }
  const result = attach('synthetic-invalid-environment', secrets, FIXTURE)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.file, { ...SECRETS, PRIVATE_CATALOG: FIXTURE })
  assert.equal(result.mode, 0o600)
  for (const value of ['synthetic', 'demo-edge-one', 'demo-one.ziyixi.science']) {
    assert.ok(!(result.stdout + result.stderr).includes(value))
  }
})

test('a missing, empty or invalid source file fails without using an older registration', () => {
  const secrets = { ...SECRETS, PRIVATE_CATALOG: FIXTURE }
  for (const file of [null, '', ' ', '{"invalid":"synthetic-private-value"}']) {
    const result = attach(FIXTURE, secrets, file)
    assert.equal(result.status, 1)
    assert.equal(result.stderr.trim(), 'PRIVATE_CATALOG_INVALID')
    assert.equal(result.stdout, '')
    assert.deepEqual(result.file, secrets)
  }
})

test('no registration leaves the secrets file as it is', () => {
  for (const raw of [undefined, '']) {
    const result = attach(raw)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.file, SECRETS)
    assert.equal(result.stdout + result.stderr, '')
  }
})

test("a registration Home's parser refuses fails the release step before the deploy", () => {
  for (const raw of [
    '{"invalid":"synthetic-private-value"}',
    ' ',
    edited((value) => { value.registry.entries[0].id = 'home' }),
    edited((value) => { value.desired.zones = ['other.example'] }),
    // The removed Python check never read icons; Home's registry check refuses an unknown one.
    edited((value) => { value.registry.entries[0].icon = 'synthetic-unknown-icon' }),
  ]) {
    const result = attach(raw)
    assert.equal(result.status, 1)
    assert.equal(result.stderr.trim(), 'PRIVATE_CATALOG_INVALID')
    assert.equal(result.stdout, '')
    assert.deepEqual(result.file, SECRETS)
    assert.ok(!result.stderr.includes('synthetic'))
  }
})

test("only Home's declared secrets file is rewritten", () => {
  for (const secrets of [{ ACCESS_OWNER: 'owner@example.org' }, { ...SECRETS, OTHER: 'synthetic-value' },
    { ...SECRETS, ACCESS_OWNER: '' }, []]) {
    const result = attach(FIXTURE, secrets)
    assert.equal(result.status, 1)
    assert.equal(result.stderr.trim(), 'PRIVATE_CATALOG_INVALID')
    assert.deepEqual(result.file, secrets)
  }
})

test('a registration the Worker secrets map carried is deployed as it is, so it is checked the same way', () => {
  const kept = attach(undefined, { ...SECRETS, PRIVATE_CATALOG: FIXTURE })
  assert.equal(kept.status, 0, kept.stderr)
  assert.deepEqual(kept.file, { ...SECRETS, PRIVATE_CATALOG: FIXTURE })
  assert.equal(kept.stdout + kept.stderr, '')
  const secrets = { ...SECRETS, PRIVATE_CATALOG: '{"invalid":"synthetic-private-value"}' }
  for (const raw of [undefined, '']) {
    const result = attach(raw, secrets)
    assert.equal(result.status, 1)
    assert.equal(result.stderr.trim(), 'PRIVATE_CATALOG_INVALID')
    assert.deepEqual(result.file, secrets)
    assert.ok(!(result.stdout + result.stderr).includes('synthetic'))
  }
  // The PRIVATE_CATALOG secret replaces it.
  const replaced = attach(FIXTURE, secrets)
  assert.equal(replaced.status, 0, replaced.stderr)
  assert.deepEqual(replaced.file, { ...SECRETS, PRIVATE_CATALOG: FIXTURE })
})
