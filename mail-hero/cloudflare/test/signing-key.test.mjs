// Synthetic WebCrypto only: caching must not change existing signatures, weaken
// configuration checks, retain old keys, or make a transient failure permanent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveHmacKeyHkdf } from '@ziyixi/edge-auth'

const env = key => ({ CREDENTIAL_KEY: key })
const A = 'ab'.repeat(32), B = 'cd'.repeat(32)
const input = ['send', 'synthetic-message', 'synthetic-endpoint']
const encoder = new TextEncoder()
const freshSecurity = () => import(`../src/native/security.ts?signing-key=${crypto.randomUUID()}`)

test('one current non-extractable key shares concurrent and case-equivalent derivations, with identical action bytes', async t => {
  const key = await deriveHmacKeyHkdf(Uint8Array.from(Buffer.from(A, 'hex')), 'mail-hero', 'tokens-v1')
  const expected = Buffer.from(await crypto.subtle.sign('HMAC', key, encoder.encode(`action:${JSON.stringify(input)}`))).toString('hex')
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle), derived = []
  t.mock.method(crypto.subtle, 'deriveKey', async (...args) => {
    const result = await derive(...args)
    derived.push(result)
    return result
  })
  const { actionHash } = await freshSecurity()
  const hashes = await Promise.all([actionHash(env(A), input), actionHash(env(A.toUpperCase()), input), actionHash(env(A), input)])
  assert.deepEqual(hashes, [expected, expected, expected])
  assert.equal(derived.length, 1)
  assert.equal(derived[0].extractable, false)
  assert.deepEqual(derived[0].usages, ['sign', 'verify'])
})

test('rotation replaces the single key, invalidates old tokens, and still validates every cached use', async t => {
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle)
  const calls = t.mock.method(crypto.subtle, 'deriveKey', derive)
  const { signToken, verifyToken, actionHash } = await freshSecurity()
  const value = { kind: 'synthetic', exp: 4102444800 }
  const token = await signToken(env(A), value)
  assert.deepEqual(await verifyToken(env(A.toUpperCase()), token), value)
  for (const invalid of ['', undefined, 'z'.repeat(64), A + '0', A + '\n']) {
    await assert.rejects(actionHash(env(invalid), input), /credential_key_not_configured/)
    assert.equal(await verifyToken(env(invalid), token), null)
  }
  assert.equal(calls.mock.callCount(), 1)
  assert.equal(await verifyToken(env(B), token), null)
  assert.equal(calls.mock.callCount(), 2)
  assert.deepEqual(await verifyToken(env(A), token), value)
  assert.equal(calls.mock.callCount(), 3, 'the cache keeps no historical keys')
})

test('a failed derivation can retry the same current key', async t => {
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle)
  let calls = 0
  t.mock.method(crypto.subtle, 'deriveKey', (...args) => ++calls === 1 ? Promise.reject(new Error('synthetic derivation failure')) : derive(...args))
  const { actionHash } = await freshSecurity()
  await assert.rejects(actionHash(env(A), input), /synthetic derivation failure/)
  assert.match(await actionHash(env(A), input), /^[0-9a-f]{64}$/)
  assert.equal(calls, 2)
})

test('a delayed failure of an old key cannot evict a newer successful key', async t => {
  const derive = crypto.subtle.deriveKey.bind(crypto.subtle)
  let failOld, calls = 0
  const pending = new Promise((_, reject) => { failOld = reject })
  t.mock.method(crypto.subtle, 'deriveKey', (...args) => ++calls === 1 ? pending : derive(...args))
  const { actionHash } = await freshSecurity()
  const old = assert.rejects(actionHash(env(A), input), /synthetic old-key failure/)
  // importKey is asynchronous; wait until the old derivation is actually pending.
  while (calls === 0) await new Promise(resolve => setImmediate(resolve))
  const newer = await actionHash(env(B), input)
  failOld(new Error('synthetic old-key failure'))
  await old
  assert.equal(await actionHash(env(B), input), newer)
  assert.equal(calls, 2)
})
