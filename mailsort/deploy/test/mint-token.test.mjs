// The owner's token script (../mint-token.mjs), its pure parts with synthetic values: the consent URL (offline access,
// PKCE, state, the one scope), the loopback callback, the grant checks (never https://mail.google.com/) and the exact
// wrangler command. No network, no Google, no wrangler.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { authUrl, CONFIG, FORBIDDEN_SCOPE, grantProblem, pkce, readCallback, SCOPES, SECRET_NAMES, secretPutArgs } from '../mint-token.mjs'

test('the consent URL asks for one Gmail scope, offline access, PKCE S256 and a state', () => {
  const { verifier, challenge } = pkce(() => Buffer.alloc(32, 7))
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
  const url = new URL(authUrl({ clientId: 'synthetic.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:5555', scope: SCOPES.readonly, challenge, state: 's1' }))
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly')
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5555')
  assert.equal(url.searchParams.get('state'), 's1')
})

test('the loopback callback needs the state and a code', () => {
  assert.deepEqual(readCallback('/?state=s1&code=abc', 's1'), { code: 'abc' })
  assert.deepEqual(readCallback('/?state=other&code=abc', 's1'), { error: 'state_mismatch' })
  assert.deepEqual(readCallback('/?state=s1&error=access_denied', 's1'), { error: 'consent_refused' })
  assert.deepEqual(readCallback('/favicon.ico', 's1'), { error: 'not_the_callback' })
})

test('a grant needs a refresh token and the asked scope, and never full access or extra scopes', () => {
  assert.equal(grantProblem({ refresh_token: 'r', scope: SCOPES.modify }, SCOPES.modify), null)
  assert.equal(grantProblem({ refresh_token: 'r', scope: `${SCOPES.readonly} ${SCOPES.modify}` }, SCOPES.modify), null)
  assert.match(grantProblem({ refresh_token: 'r', scope: `${SCOPES.modify} ${FORBIDDEN_SCOPE}` }, SCOPES.modify), /full access/)
  assert.match(grantProblem({ refresh_token: 'r', scope: SCOPES.readonly }, SCOPES.modify), /does not include/)
  assert.match(grantProblem({ refresh_token: 'r', scope: `${SCOPES.modify} https://www.googleapis.com/auth/gmail.send` }, SCOPES.modify), /does not need/)
  assert.match(grantProblem({ scope: SCOPES.modify }, SCOPES.modify), /no refresh token/)
})

test('it puts exactly the three Gmail secrets, through wrangler with the committed config', () => {
  assert.deepEqual(SECRET_NAMES, ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'])
  assert.deepEqual(secretPutArgs('GMAIL_REFRESH_TOKEN'), ['--no-install', 'wrangler', 'secret', 'put', 'GMAIL_REFRESH_TOKEN', '--config', CONFIG])
  assert.throws(() => secretPutArgs('CSRF_SIGNING_KEY'))
  assert.ok(CONFIG.endsWith('mailsort/wrangler.toml'))
})
