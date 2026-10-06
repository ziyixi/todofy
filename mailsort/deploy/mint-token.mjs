#!/usr/bin/env node
// Mints the owner's Gmail grant for the Worker "mailsort" ON THE OWNER'S OWN MACHINE, and puts it into the Worker as
// three secrets (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN) with `wrangler secret put`. The grant never
// goes to GitHub, a chat, a log or a file: the values travel from Google to wrangler's stdin and nowhere else. A deploy
// keeps them (deploy-vars.mjs, test/secrets-kept.test.mjs). ../docs/design.md §12 has the whole owner setup.
//
// The OAuth flow is Google's for installed apps: a "Desktop app" client of the owner's own Google Cloud project, a
// loopback redirect (http://127.0.0.1:<random port>), PKCE (S256) and a random state. The scope is one of
//   --scope readonly   https://www.googleapis.com/auth/gmail.readonly  (shadow: Google refuses every write)
//   --scope modify     https://www.googleapis.com/auth/gmail.modify    (live: labels; still no permanent delete)
// and never https://mail.google.com/ (the only scope that deletes for good): the script refuses a grant that has it.
//
// Usage (from mailsort/worker/, after `npm ci` and `npx wrangler login` with the account that owns the Worker):
//   GMAIL_CLIENT_ID=... node ../deploy/mint-token.mjs --scope readonly
//   (the client secret is asked for on the terminal, hidden; or set GMAIL_CLIENT_SECRET in the environment)
//   node ../deploy/mint-token.mjs --scope modify --dry-run     (the flow, then print which secrets it would set)
//
// Revoke at any time: https://myaccount.google.com/permissions (Google account > Security > Third-party access).
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const SCOPES = {
  readonly: 'https://www.googleapis.com/auth/gmail.readonly',
  modify: 'https://www.googleapis.com/auth/gmail.modify',
}
/** The scope mailsort never holds: full mailbox access, including permanent deletion. */
export const FORBIDDEN_SCOPE = 'https://mail.google.com/'
export const CONFIG = fileURLToPath(new URL('../wrangler.toml', import.meta.url))
export const SECRET_NAMES = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']

const base64url = (bytes) => Buffer.from(bytes).toString('base64url')

/** PKCE: a verifier and its S256 challenge. */
export function pkce(random = randomBytes) {
  const verifier = base64url(random(32))
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) }
}

/** The consent URL: offline access (a refresh token), consent every time (a new token), PKCE and state. */
export function authUrl({ clientId, redirectUri, scope, challenge, state }) {
  const url = new URL(AUTH_ENDPOINT)
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString()
  return url.toString()
}

/** The code of the loopback redirect, or an error code (never the request's text). */
export function readCallback(requestUrl, state) {
  const url = new URL(requestUrl, 'http://127.0.0.1')
  if (url.pathname !== '/') return { error: 'not_the_callback' }
  if (url.searchParams.get('state') !== state) return { error: 'state_mismatch' }
  if (url.searchParams.has('error')) return { error: 'consent_refused' }
  const code = url.searchParams.get('code')
  return code === null || code === '' ? { error: 'no_code' } : { code }
}

/** The token answer's problem, or null: a refresh token, the asked scope, and never the full-access scope. */
export function grantProblem(answer, scope) {
  if (typeof answer?.refresh_token !== 'string' || answer.refresh_token === '') return 'Google sent no refresh token (revoke the old grant and run again).'
  const granted = typeof answer.scope === 'string' ? answer.scope.split(' ') : []
  if (granted.includes(FORBIDDEN_SCOPE)) return 'The grant includes https://mail.google.com/ (full access): refused. Revoke it and use a client without that scope.'
  if (!granted.includes(scope)) return 'The grant does not include the requested Gmail scope.'
  const extra = granted.filter((item) => item !== scope && item !== SCOPES.readonly && !['openid', 'email', 'profile'].includes(item))
  if (extra.length > 0) return 'The grant includes scopes mailsort does not need: refused.'
  return null
}

/** The wrangler command that puts one secret (its value on stdin). */
export function secretPutArgs(name) {
  if (!SECRET_NAMES.includes(name)) throw new Error('not a mailsort Gmail secret')
  return ['--no-install', 'wrangler', 'secret', 'put', name, '--config', CONFIG]
}

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (hidden) rl._writeToOutput = () => {}
    process.stdout.write(question)
    rl.question('', (answer) => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

/** What main() touches outside itself; a test replaces each of these with a fake (test/mint-token.test.mjs). */
export const realDeps = {
  env: process.env,
  ask,
  fetch: (...args) => fetch(...args),
  spawnSync,
  /** Shows the consent page: the browser on macOS, otherwise the owner copies the printed URL. */
  openUrl: (url) => {
    if (process.platform === 'darwin') spawnSync('open', [url], { stdio: 'ignore' })
  },
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  timeoutMs: 5 * 60_000,
}

/**
 * Waits for Google's redirect to a one-shot loopback server and answers its code and the exact redirect URI the consent
 * URL used. The URI is fixed once, in the listen callback: Google requires the token request to repeat it byte for byte,
 * and after server.close() Node no longer reports the port (server.address() is null).
 */
function awaitCallback({ clientId, scope, scopeName, challenge, state, deps }) {
  return new Promise((resolve, reject) => {
    let redirectUri = ''
    const server = createServer((request, response) => {
      const result = readCallback(request.url ?? '/', state)
      if (result.error === 'not_the_callback') {
        response.writeHead(404).end()
        return
      }
      // connection: close lets server.close() finish now instead of waiting for the browser's keep-alive socket.
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(result.code === undefined ? `授权未完成（${result.error}），可以关闭此页。\n` : '授权完成，可以关闭此页，回到终端。\n')
      clearTimeout(timer)
      server.close()
      if (result.code === undefined) reject(new Error(result.error))
      else resolve({ code: result.code, redirectUri })
    })
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('timeout'))
    }, deps.timeoutMs)
    timer.unref()
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`
      const url = authUrl({ clientId, redirectUri, scope, challenge, state })
      deps.log(`Open this page, sign in as the mailbox owner and allow ${scopeName} access:\n\n  ${url}\n`)
      deps.openUrl(url)
    })
  })
}

export async function main(argv, deps = realDeps) {
  const scopeName = argv[argv.indexOf('--scope') + 1]
  const dryRun = argv.includes('--dry-run')
  if (!argv.includes('--scope') || !(scopeName in SCOPES)) {
    deps.error('Usage: mint-token.mjs --scope readonly|modify [--dry-run]')
    return 2
  }
  const scope = SCOPES[scopeName]
  const clientId = deps.env.GMAIL_CLIENT_ID || (await deps.ask('Desktop OAuth client ID: ', false))
  const clientSecret = deps.env.GMAIL_CLIENT_SECRET || (await deps.ask('Client secret (hidden): ', true))
  if (!/^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$/.test(clientId) || clientSecret === '') {
    deps.error('A Desktop client ID (…apps.googleusercontent.com) and its secret are needed.')
    return 2
  }
  const { verifier, challenge } = pkce()
  const state = base64url(randomBytes(16))
  const callback = await awaitCallback({ clientId, scope, scopeName, challenge, state, deps })
  const response = await deps.fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: callback.code, client_id: clientId, client_secret: clientSecret, redirect_uri: callback.redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
  })
  const answer = await response.json().catch(() => null)
  if (!response.ok) {
    deps.error(`Google refused the code (HTTP ${response.status}${typeof answer?.error === 'string' ? `, ${answer.error}` : ''}).`)
    return 1
  }
  const problem = grantProblem(answer, scope)
  if (problem !== null) {
    deps.error(problem)
    return 1
  }
  const values = { GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: clientSecret, GMAIL_REFRESH_TOKEN: answer.refresh_token }
  for (const name of SECRET_NAMES) {
    if (dryRun) {
      deps.log(`Would put the Worker secret ${name} (value not printed).`)
      continue
    }
    const put = deps.spawnSync('npx', secretPutArgs(name), { input: values[name], stdio: ['pipe', 'inherit', 'inherit'] })
    if (put.status !== 0) {
      deps.error(`wrangler secret put ${name} failed; nothing else was changed after it.`)
      return 1
    }
  }
  deps.log(`Done: the Worker mailsort now holds a ${scopeName} Gmail grant. Revoke it at https://myaccount.google.com/permissions.`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`Authorization did not finish (${error instanceof Error ? error.message : 'error'}).`)
      process.exitCode = 1
    },
  )
}
