import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { CASES, FIXTURES, buildFixture, fixtureFiles } from './contract-fixtures.mjs'

const UPDATE = 'If the change is intended, run `npm run contract:update` in mail-hero/cloudflare and commit the fixtures; ' +
  "Todofy's contract tests then check that its consumer still accepts them."

// Legacy fixtures are frozen bytes of older builders: retries resend those exact bytes, so they must
// never be edited, reformatted or "upgraded". Adding one means adding its SHA-256 here on purpose.
// Todofy's tests/unit/test_mail_hero_compat.py pins the same hashes.
const LEGACY_SHA256 = {
  'pre_storage_v1.json': '9618c81d70e7275c8f324f76cb8989b58e14dd6d1f211fbe61f9dbe9d1b8b48f',
}

test('every contract case has a unique name and event number', () => {
  assert.equal(new Set(CASES.map(testCase => testCase.name)).size, CASES.length)
  assert.equal(new Set(CASES.map(testCase => testCase.number)).size, CASES.length)
})

test('the checked-in fixtures are exactly the contract cases', () => {
  assert.deepEqual(fixtureFiles(), CASES.map(testCase => `${testCase.name}.json`).sort(), UPDATE)
})

for (const testCase of CASES) {
  test(`buildPayload still emits the golden ${testCase.name} fixture byte for byte`, async () => {
    const built = await buildFixture(testCase)
    const golden = readFileSync(new URL(`${testCase.name}.json`, FIXTURES), 'utf8')
    assert.ok(built === golden, `${testCase.name}.json differs from Mail Hero's current payload. ${UPDATE}`)
    const payload = JSON.parse(built)
    assert.equal(payload.type, 'mail.received.v1')
    assert.ok(Buffer.byteLength(built) <= 1024 * 1024)
    assert.doesNotMatch(built, /r2_key|parsed\//, 'private storage keys never leave Mail Hero')
  })
}

test('no two fixtures, current or legacy, share an event or message ID', () => {
  // Consumers deduplicate by event_id: Todofy's runtime suite posts every fixture to one Worker, and a
  // reused ID would be answered 409 event_conflict instead of being parsed.
  const legacy = new URL('legacy/', FIXTURES)
  const documents = [
    ...fixtureFiles().map(name => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'))),
    ...readdirSync(legacy).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(new URL(name, legacy), 'utf8'))),
  ]
  for (const key of ['event_id', 'message']) {
    const ids = documents.map(document => key === 'message' ? document.message.id : document.event_id)
    assert.equal(new Set(ids).size, ids.length, `two fixtures share a ${key === 'message' ? 'message.id' : 'event_id'}`)
  }
})

test('legacy fixtures stay frozen byte for byte, valid JSON of the same event type', () => {
  const legacy = new URL('legacy/', FIXTURES)
  const names = readdirSync(legacy).filter(name => name.endsWith('.json'))
  assert.deepEqual(names.sort(), Object.keys(LEGACY_SHA256).sort(), 'every legacy fixture must be pinned in LEGACY_SHA256')
  for (const name of names) {
    const bytes = readFileSync(new URL(name, legacy))
    const digest = createHash('sha256').update(bytes).digest('hex')
    assert.equal(digest, LEGACY_SHA256[name], `legacy/${name} changed: legacy bytes are frozen (retries resend them) and must never be edited`)
    assert.equal(JSON.parse(bytes.toString('utf8')).type, 'mail.received.v1')
  }
})
