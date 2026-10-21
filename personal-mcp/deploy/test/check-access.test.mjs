import assert from 'node:assert/strict'
import test from 'node:test'
import { checkAccessChallenge } from '../check-access.mjs'

const host = 'mcp.example.com'
const challenge = 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"'
const reply = (status, header = challenge) => new Response(null, { status, headers: { 'WWW-Authenticate': header } })

test('accepts the managed OAuth challenge without following redirects or logging tokens', async () => {
  await checkAccessChallenge(host, async (url, options) => {
    assert.equal(url, 'https://mcp.example.com/mcp')
    assert.equal(options.redirect, 'manual')
    assert.equal(options.headers.Accept, 'application/json')
    return reply(401)
  })
})

test('rejects interactive redirects and unprotected or failed responses', async () => {
  for (const status of [200, 302, 403, 500]) {
    await assert.rejects(checkAccessChallenge(host, async () => reply(status)), /MANAGED_OAUTH_CHALLENGE_MISSING/)
  }
})

test('rejects missing metadata and another origin in the challenge', async () => {
  for (const header of ['Bearer', 'Basic realm="owner"', challenge.replace('mcp.example.com', 'elsewhere.example.com')]) {
    await assert.rejects(checkAccessChallenge(host, async () => reply(401, header)))
  }
})
