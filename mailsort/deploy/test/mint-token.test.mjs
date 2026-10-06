// The owner's token script (../mint-token.mjs) with synthetic values: the consent URL (offline access, PKCE, state, the
// one scope), the loopback callback, the grant checks (never https://mail.google.com/), the exact wrangler command, and
// main() end to end with its real loopback server, a fake browser that follows the consent URL's redirect, a fake token
// endpoint and a fake wrangler. No Google, no wrangler; the only network is 127.0.0.1.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { get } from 'node:http'
import { authUrl, CONFIG, FORBIDDEN_SCOPE, grantProblem, main, pkce, readCallback, SCOPES, SECRET_NAMES, secretPutArgs } from '../mint-token.mjs'

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

/**
 * main() with fakes around its real loopback server. The fake browser reads the consent URL main() opens and calls its
 * redirect_uri the way Google would (the state from the URL, a synthetic code, or `callback` to change the query).
 */
async function runMain(argv, { callback = (state) => `?state=${state}&code=synthetic-code`, tokenAnswer, putStatus = 0 } = {}) {
  const calls = { opened: [], token: [], puts: [], errors: [], logs: [] }
  const deps = {
    env: { GMAIL_CLIENT_ID: 'synthetic.apps.googleusercontent.com', GMAIL_CLIENT_SECRET: 'synthetic-client-secret' },
    ask: async () => assert.fail('the values come from the environment here'),
    openUrl: (url) => {
      calls.opened.push(url)
      const consent = new URL(url)
      get(`${consent.searchParams.get('redirect_uri')}/${callback(consent.searchParams.get('state'))}`, (response) => response.resume())
    },
    fetch: async (url, init) => {
      calls.token.push({ url, body: new URLSearchParams(init.body.toString()) })
      return Response.json(tokenAnswer ?? { refresh_token: 'synthetic-refresh-token', scope: SCOPES.modify, access_token: 'synthetic-access' })
    },
    spawnSync: (command, args, options) => {
      calls.puts.push({ command, args, input: options.input })
      return { status: putStatus }
    },
    log: (line) => calls.logs.push(line),
    error: (line) => calls.errors.push(line),
    timeoutMs: 10_000,
  }
  const code = await main(argv, deps)
  return { code, calls }
}

test('main() sends the token request with exactly the redirect URI of the consent URL, then puts the three secrets', async () => {
  const { code, calls } = await runMain(['--scope', 'modify'])
  assert.equal(code, 0, calls.errors.join('\n'))
  assert.equal(calls.opened.length, 1)
  const consent = new URL(calls.opened[0])
  const redirectUri = consent.searchParams.get('redirect_uri')
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/)
  assert.equal(calls.token.length, 1)
  const token = calls.token[0]
  assert.equal(token.url, 'https://oauth2.googleapis.com/token')
  assert.equal(token.body.get('redirect_uri'), redirectUri)
  assert.equal(token.body.get('code'), 'synthetic-code')
  assert.equal(token.body.get('grant_type'), 'authorization_code')
  assert.equal(createHash('sha256').update(token.body.get('code_verifier')).digest('base64url'), consent.searchParams.get('code_challenge'))
  assert.deepEqual(
    calls.puts.map((put) => [put.command, put.args, put.input]),
    [
      ['npx', secretPutArgs('GMAIL_CLIENT_ID'), 'synthetic.apps.googleusercontent.com'],
      ['npx', secretPutArgs('GMAIL_CLIENT_SECRET'), 'synthetic-client-secret'],
      ['npx', secretPutArgs('GMAIL_REFRESH_TOKEN'), 'synthetic-refresh-token'],
    ],
  )
  // No value reaches the terminal.
  for (const line of [...calls.logs, ...calls.errors]) assert.doesNotMatch(line, /synthetic-(client-secret|refresh-token|access)/)
})

test('main() --dry-run finishes the flow and puts nothing', async () => {
  const { code, calls } = await runMain(['--scope', 'modify', '--dry-run'])
  assert.equal(code, 0)
  assert.equal(calls.token.length, 1)
  assert.deepEqual(calls.puts, [])
})

test('main() stops without a token request on a forged state, and puts nothing for a wrong grant', async () => {
  await assert.rejects(runMain(['--scope', 'modify'], { callback: () => '?state=forged&code=synthetic-code' }), /state_mismatch/)
  const wrong = await runMain(['--scope', 'modify'], { tokenAnswer: { refresh_token: 'synthetic-refresh-token', scope: `${SCOPES.modify} ${FORBIDDEN_SCOPE}` } })
  assert.equal(wrong.code, 1)
  assert.deepEqual(wrong.calls.puts, [])
})

test('main() stops after the first failed wrangler secret put', async () => {
  const { code, calls } = await runMain(['--scope', 'modify'], { putStatus: 1 })
  assert.equal(code, 1)
  assert.equal(calls.puts.length, 1)
})
