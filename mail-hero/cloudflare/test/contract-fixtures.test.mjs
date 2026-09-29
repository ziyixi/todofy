import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { CASES, FIXTURES, buildFixture, fixtureFiles } from './contract-fixtures.mjs'

const UPDATE = 'If the change is intended, run `npm run contract:update` in mail-hero/cloudflare and commit the fixtures; ' +
  "Todofy's contract tests then check that its consumer still accepts them."

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

test('legacy fixtures stay frozen, valid JSON of the same event type', () => {
  const legacy = new URL('legacy/', FIXTURES)
  const names = readdirSync(legacy).filter(name => name.endsWith('.json'))
  assert.ok(names.length > 0)
  for (const name of names) assert.equal(JSON.parse(readFileSync(new URL(name, legacy), 'utf8')).type, 'mail.received.v1')
})
