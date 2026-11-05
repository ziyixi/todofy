import test from 'node:test'
import assert from 'node:assert/strict'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createAccessVerifier } from '@ziyixi/edge-auth'
import { handleAPI } from '../src/native/api.ts'
import { fetchHandler } from '../src/native/index.ts'
import { reasonOf } from './owner-api.mjs'
import { environment, session } from './native-env.mjs'
import { authenticate, csrfResponse, HttpError, privateResponse, requireCSRF } from '../src/native/security.ts'

test('native API defaults are archive with the storage-v1 retention, maintenance blocks mutations only', async () => {
  const env = environment(), api = await session(env)
  const initial = await api('GET', '/settings')
  assert.equal(initial.status, 200)
  assert.deepEqual(initial.data, { name: 'settings', receive_address: 'hero@in.example.org', mode: 'archive', raw_retention_days: 7,
    content_retention_days: 30, ledger_retention_days: 180, resolved_retention_days: 60, lifecycle_policy_version: 1,
    logical_limit_bytes: 5368709120, etag: '1' })
  assert.equal(initial.response.headers.get('Cache-Control'), 'no-store')
  env.MAINTENANCE_MODE = 'true'
  const refused = await api('PATCH', '/settings?update_mask=mode', { etag: '1', mode: 'archive' })
  assert.equal(refused.status, 503)
  assert.equal(reasonOf(refused.data), 'MAINTENANCE')
  assert.equal((await api('GET', '/settings')).status, 200)
  const overview = await api('GET', '/overview')
  assert.ok(overview.data.warnings.some(item => item.includes('维护模式')))
})

// Test tokens are signed with jose (an independent implementation) and verified by
// packages/edge-auth through an injected certs fetch, as Access publishes them.
const ACCESS_KID = 'synthetic-kid'
async function accessKeys(options = {}) {
  const keys = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: ACCESS_KID, alg: 'RS256', use: 'sig' }
  const certs = []
  const fetch = options.fetch ?? (async (url, init) => { certs.push({ url, init }); return Response.json({ keys: [jwk] }) })
  return { privateKey: keys.privateKey, jwk, certs, verifier: createAccessVerifier({ fetch }) }
}
function accessToken(env, privateKey, claims = {}, header = { alg: 'RS256', kid: ACCESS_KID }) {
  let jwt = new SignJWT({ email: env.ACCESS_OWNER, ...claims }).setProtectedHeader(header).setIssuer(env.ACCESS_ISSUER)
    .setAudience(env.ACCESS_AUDIENCE).setExpirationTime('10m')
  if (!('iat' in claims)) jwt = jwt.setIssuedAt()
  if (!('sub' in claims)) jwt = jwt.setSubject('synthetic-user')
  return jwt.sign(privateKey)
}
const unauthorized = message => error => error instanceof HttpError && error.status === 401 && error.code === 'unauthorized' && error.message === message

test('Access validates signature, audience and owner; fake header and remote dev bypass fail closed', async () => {
  const env = environment(); delete env.DEV_AUTH_BYPASS
  const keys = await accessKeys()
  const request = async claims => new Request('https://mail.example.org/api/v2/settings', { headers: { 'Cf-Access-Jwt-Assertion': await accessToken(env, keys.privateKey, claims) } })
  assert.equal(await authenticate(await request(), env, keys.verifier), env.ACCESS_OWNER)
  // The certs come from the pinned issuer as a string URL, with redirects refused.
  assert.equal(keys.certs[0].url, 'https://test.cloudflareaccess.com/cdn-cgi/access/certs')
  assert.equal(keys.certs[0].init.redirect, 'manual')
  await assert.rejects(authenticate(await request(), { ...env, ACCESS_AUDIENCE: 'different-audience' }, keys.verifier), error => error instanceof HttpError && error.status === 401)
  await assert.rejects(authenticate(await request({ email: 'other@example.org' }), env, keys.verifier), error => error instanceof HttpError && error.status === 401)
  await assert.rejects(authenticate(new Request('https://mail.example.org', { headers: { 'Cf-Access-Jwt-Assertion': 'present-but-not-a-token' } }), env, keys.verifier), /Access/)
  env.DEV_AUTH_BYPASS = 'true'
  const refused = await handleAPI(new Request('https://mail.example.org/api/v2/settings'), env)
  assert.equal(refused.status, 503)
  assert.equal(reasonOf(await refused.json()), 'ACCESS_NOT_CONFIGURED')
})

test('Access keeps every jose check and the stricter shared ones: RS256 only, kid, iat, nbf, sub, key size', async () => {
  const env = environment(); delete env.DEV_AUTH_BYPASS
  const keys = await accessKeys(), now = Math.floor(Date.now() / 1000)
  const check = token => authenticate(new Request('https://mail.example.org/api/v2/settings', { headers: { 'Cf-Access-Jwt-Assertion': token } }), env, keys.verifier)
  const invalid = unauthorized('Access 登录无效或无权限')
  assert.equal(await check(await accessToken(env, keys.privateKey, { nbf: now })), 'owner@example.org')
  const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
  const claims = { iss: env.ACCESS_ISSUER, aud: env.ACCESS_AUDIENCE, sub: 'synthetic-user', email: env.ACCESS_OWNER, iat: now, exp: now + 600 }
  // Algorithm confusion: an HMAC token keyed with the public JWK, and alg "none".
  const hmacSecret = new TextEncoder().encode(JSON.stringify(keys.jwk))
  const small = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  const smallKid = 'small-kid', smallJwk = { ...(await crypto.subtle.exportKey('jwk', small.publicKey)), kid: smallKid, alg: 'RS256', use: 'sig' }
  const smallVerifier = createAccessVerifier({ fetch: async () => Response.json({ keys: [smallJwk] }) })
  const raw = async (header, privateKey) => {
    const head = b64(header) + '.' + b64(claims)
    return head + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(head))).toString('base64url')
  }
  assert.equal(await check(await raw({ alg: 'RS256', kid: ACCESS_KID }, keys.privateKey)), 'owner@example.org')
  const smallToken = await raw({ alg: 'RS256', kid: smallKid }, small.privateKey)
  for (const token of [
    await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: ACCESS_KID }).sign(hmacSecret),
    `${b64({ alg: 'none', kid: ACCESS_KID })}.${b64(claims)}.`,
    await accessToken(env, keys.privateKey, {}, { alg: 'RS256' }),                         // no kid
    await accessToken(env, keys.privateKey, {}, { alg: 'RS256', kid: 'unknown-kid' }),
    await raw({ alg: 'RS256', kid: ACCESS_KID, crit: ['exp'], exp: 1 }, keys.privateKey),   // jose also refused unknown crit
    await accessToken(env, keys.privateKey, { iat: now + 3600 }),                           // jose accepted a future iat
    await accessToken(env, keys.privateKey, { nbf: now + 5 }),                              // 0 s nbf leeway, as before
    await accessToken(env, keys.privateKey, { sub: '' }),                                   // jose accepted an empty sub
    await accessToken(env, keys.privateKey, { sub: undefined }),
    await new SignJWT({ email: env.ACCESS_OWNER }).setProtectedHeader({ alg: 'RS256', kid: ACCESS_KID }).setIssuer(env.ACCESS_ISSUER)
      .setAudience(env.ACCESS_AUDIENCE).setSubject('synthetic-user').setExpirationTime('10m').sign(keys.privateKey),  // no iat
  ]) await assert.rejects(check(token), invalid)
  await assert.rejects(authenticate(new Request('https://mail.example.org/', { headers: { 'Cf-Access-Jwt-Assertion': smallToken } }), env, smallVerifier), invalid)
})

test('Access token source, certs failures and dev bypass keep their former statuses and messages', async () => {
  const env = environment(); delete env.DEV_AUTH_BYPASS
  const keys = await accessKeys(), token = await accessToken(env, keys.privateKey)
  const at = (headers, url = 'https://mail.example.org/api/v2/settings') => authenticate(new Request(url, { headers }), env, keys.verifier)
  const missing = unauthorized('需要通过 Cloudflare Access 登录')
  await assert.rejects(at({}), missing)
  await assert.rejects(at({ 'Cf-Access-Jwt-Assertion': '', Cookie: `CF_Authorization=${token}` }), missing)  // an empty header is missing
  await assert.rejects(at({ 'Cf-Access-Jwt-Assertion': 'x'.repeat(16001) }), missing)
  assert.equal(await at({ Cookie: `other=1; CF_Authorization=${token}; CF_Authorization=stale` }), 'owner@example.org')  // first cookie
  await assert.rejects(at({ Cookie: `CF_Authorization=stale; CF_Authorization=${token}` }), unauthorized('Access 登录无效或无权限'))
  for (const fetch of [async () => new Response('down', { status: 500 }), async () => { throw new Error('offline') },
    async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.org/certs' } }), async () => new Response('not json')]) {
    const failing = createAccessVerifier({ fetch })
    await assert.rejects(authenticate(new Request('https://mail.example.org/', { headers: { 'Cf-Access-Jwt-Assertion': token } }), env, failing), unauthorized('Access 登录无效或无权限'))
  }
  const local = { ...env, DEV_AUTH_BYPASS: 'true' }
  for (const url of ['http://127.0.0.1:8787/api/v2/settings', 'http://localhost/', 'http://[::1]:8787/'])
    assert.equal(await authenticate(new Request(url), local, keys.verifier), 'local-development')
  for (const [url, headers] of [['https://localhost/', {}], ['http://mail.example.org/', {}], ['http://127.0.0.1:8787/', { 'CF-Ray': 'abc' }], ['http://app.localhost/', {}]]) {
    await assert.rejects(authenticate(new Request(url, { headers }), local, keys.verifier),
      error => error instanceof HttpError && error.status === 503 && error.code === 'invalid_auth_configuration' && error.message === '开发认证模式仅限本机')
  }
  for (const bad of [{ ACCESS_ISSUER: 'https://evil.example.org' }, { ACCESS_AUDIENCE: '' }, { ACCESS_OWNER_ALIASES: 'a'.repeat(2049) }]) {
    await assert.rejects(authenticate(new Request('https://mail.example.org/', { headers: { 'Cf-Access-Jwt-Assertion': token } }), { ...env, ...bad }, keys.verifier),
      error => error instanceof HttpError && error.status === 503 && error.code === 'access_not_configured' && error.message === '请先配置 Cloudflare Access')
  }
})

test('Access aliases preserve one canonical owner and still require every JWT check', async () => {
  const env = environment(); delete env.DEV_AUTH_BYPASS
  env.ACCESS_OWNER = '  owner@example.org  '
  env.ACCESS_OWNER_ALIASES = ' github-owner@example.org, , second-login@example.org '
  const keys = await accessKeys(), unrelatedKeys = await generateKeyPair('RS256')
  const sign = (email, overrides = {}, privateKey = keys.privateKey) => new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: ACCESS_KID }).setIssuer(overrides.issuer ?? env.ACCESS_ISSUER)
    .setAudience(overrides.audience ?? env.ACCESS_AUDIENCE).setSubject('synthetic-user')
    .setIssuedAt().setExpirationTime(overrides.expires ?? '10m').sign(privateKey)
  const request = token => new Request('https://mail.example.org/api/v2/settings', { headers: { 'Cf-Access-Jwt-Assertion': token } })
  const authenticateToken = token => authenticate(request(token), env, keys.verifier)
  for (const email of ['owner@example.org', 'github-owner@example.org', 'second-login@example.org']) {
    assert.equal(await authenticateToken(await sign(email)), 'owner@example.org')
  }
  for (const email of ['unlisted@example.org', 'GITHUB-owner@example.org', ' github-owner@example.org ']) {
    await assert.rejects(authenticateToken(await sign(email)), error => error instanceof HttpError && error.status === 401)
  }
  for (const token of [
    await sign('github-owner@example.org', { issuer: 'https://other.cloudflareaccess.com' }),
    await sign('github-owner@example.org', { audience: 'wrong-audience' }),
    await sign('github-owner@example.org', { expires: '1 second ago' }),
    await sign('github-owner@example.org', {}, unrelatedKeys.privateKey),
    'present-but-not-a-token',
  ]) await assert.rejects(authenticateToken(token), error => error instanceof HttpError && error.status === 401)
})

test('Access aliases cannot replace a missing canonical owner or exceed the personal alias limit', async () => {
  const env = environment(); delete env.DEV_AUTH_BYPASS
  env.ACCESS_OWNER_ALIASES = 'github-owner@example.org'
  const keys = await accessKeys()
  const token = await accessToken(env, keys.privateKey, { email: 'github-owner@example.org' })
  const request = new Request('https://mail.example.org/api/v2/settings', { headers: { 'Cf-Access-Jwt-Assertion': token } })
  for (const owner of [undefined, '', '   ']) {
    await assert.rejects(authenticate(request, { ...env, ACCESS_OWNER: owner }, keys.verifier), error => error instanceof HttpError && error.status === 503)
  }
  const aliases = Array.from({ length: 9 }, (_, i) => `login-${i}@example.org`).join(',')
  await assert.rejects(authenticate(request, { ...env, ACCESS_OWNER_ALIASES: aliases }, keys.verifier), error => error instanceof HttpError && error.status === 503)
})

// An opaque value a cached page may still hold from the previous signing protocol.
const LEGACY_CSRF = 'cached.synthetic.opaque-header'

test('a cached opaque header and a real Access login pass handleAPI through the default verifier', async t => {
  const env = environment(); delete env.DEV_AUTH_BYPASS
  env.ACCESS_ISSUER = 'https://golden.cloudflareaccess.com'
  const keys = await accessKeys(), certs = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { certs.push({ url, init }); return Response.json({ keys: [keys.jwk] }) })
  const jwt = await accessToken(env, keys.privateKey)
  const write = (header, origin = 'https://mail.example.org') => handleAPI(new Request('https://mail.example.org/api/v2/settings?update_mask=send_paused', {
    method: 'PATCH', body: JSON.stringify({ etag: '1', send_paused: true }),
    headers: { 'Cf-Access-Jwt-Assertion': jwt, Origin: origin, 'X-CSRF-Token': header, 'Content-Type': 'application/json' } }), env)
  const accepted = await write(LEGACY_CSRF)
  assert.equal(accepted.status, 200, await accepted.clone().text())
  assert.deepEqual(certs.map(call => [call.url, call.init.redirect]), [['https://golden.cloudflareaccess.com/cdn-cgi/access/certs', 'manual']])
  for (const origin of ['null', 'https://attacker.example', 'https://MAIL.example.org']) {
    assert.equal((await write('1', origin)).status, 403)
  }
  const rejected = await write('')
  assert.equal(rejected.status, 403)
  const status = (await rejected.json()).error
  assert.deepEqual([status.code, status.status, reasonOf({ error: status })], [403, 'PERMISSION_DENIED', 'CSRF_FAILED'])
  assert.equal(status.details.find(detail => detail['@type'].endsWith('LocalizedMessage')).message, '请刷新页面后再试')
})

test('CSRF checks are keyless and cookie-free: Origin, a nonempty header and JSON', async () => {
  const request = (value, mediaType = 'application/json') => new Request('https://mail.example.org/api/v2/settings', { method: 'PATCH',
    headers: { Origin: 'https://mail.example.org', 'X-CSRF-Token': value, 'Content-Type': mediaType } })
  await requireCSRF(request('1'))
  await requireCSRF(request(LEGACY_CSRF))
  const csrfFailed = error => error instanceof HttpError && error.status === 403 && error.code === 'csrf_failed'
  await assert.rejects(requireCSRF(request('')), csrfFailed)
  await assert.rejects(requireCSRF(request('1', 'text/plain')), csrfFailed)
})

test('a UI from before the keyless change still gets its static, cookie-free token until 2026-11-01', async () => {
  const issued = csrfResponse()
  assert.equal(issued.headers.get('Set-Cookie'), null)
  assert.equal(issued.headers.get('Cache-Control'), 'no-store')
  assert.equal(issued.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.deepEqual(await issued.json(), { token: '1' })
  const noKey = { ...environment(), CREDENTIAL_KEY: '' }
  const compatibility = await handleAPI(new Request('http://127.0.0.1:8787/api/csrf'), noKey)
  assert.equal(compatibility.status, 200)
  assert.deepEqual(await compatibility.json(), { token: '1' })
  assert.equal(compatibility.headers.get('set-cookie'), null)
  const post = await handleAPI(new Request('http://127.0.0.1:8787/api/csrf', { method: 'POST' }), noKey)
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET')
})

test('private responses carry the exact Mail Hero headers, including the sandboxed-HTML frame-src', async () => {
  const response = privateResponse(new Response('x', { status: 201, headers: { 'Cache-Control': 'public, max-age=60', 'X-Other': 'kept' } }))
  assert.equal(response.status, 201)
  assert.equal(await response.text(), 'x')
  assert.deepEqual(Object.fromEntries(response.headers), {
    'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'content-type': 'text/plain;charset=UTF-8', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'x-other': 'kept',
  })
})

test('mutations require exact Origin, a custom header and JSON before settings writes', async () => {
  const env = environment(), api = await session(env)
  const write = headers => api('PATCH', '/settings?update_mask=send_paused', { etag: '1', send_paused: true }, headers)
  assert.equal((await write({ Origin: 'https://attacker.example' })).status, 403)
  assert.equal((await write({ 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await write({ 'Content-Type': 'text/plain' })).status, 403)
  // A refused request never reaches settings.
  assert.equal((await api('GET', '/settings')).data.etag, '1')
  assert.equal((await write()).status, 200)
})

test('internal database failure does not echo errors or credentials to a browser', async () => {
  const env = environment(), api = await session(env)
  env.DB.prepare = () => { throw new Error('postgres://secret-user:secret-password@private-host') }
  const response = await api('GET', '/settings')
  assert.equal(response.status, 503)
  assert.equal(reasonOf(response.data), 'UNAVAILABLE')
  assert.equal(JSON.stringify(response.data).includes('secret'), false)
  // A bug is INTERNAL: never answered as a dependency the client may retry.
  // An answer the wire profile refuses to write (an int32 out of range) stands for a bug in the mapping.
  env.DB.prepare = () => ({ all: async () => ({ results: [{ version: 1, mode: 'archive', lifecycle_policy_version: 2 ** 40, ledger_retention_days: 180 }], meta: {} }) })
  const bug = await api('GET', '/settings')
  assert.deepEqual([bug.status, reasonOf(bug.data)], [500, 'INTERNAL'])
  assert.equal(JSON.stringify(bug.data).includes('secret'), false)
})

test('maintenance rejects every browser mutation route and reports effective pause truthfully', async () => {
  const env = environment(), api = await session(env)
  env.MAINTENANCE_MODE = 'true'
  for (const [method, path] of [['POST', '/endpoints'], ['PATCH', '/settings'], ['POST', `/messages/${crypto.randomUUID()}:clearContent`],
    ['POST', `/deliveries/${crypto.randomUUID()}:retry`], ['POST', `/endpoints/${crypto.randomUUID()}:test`], ['PATCH', `/messages/${crypto.randomUUID()}`]]) {
    const refused = await api(method, path, {})
    assert.deepEqual([refused.status, reasonOf(refused.data)], [503, 'MAINTENANCE'], path)
  }
  const settings = await api('GET', '/settings')
  assert.equal(settings.data.send_paused, undefined)
  assert.equal(settings.data.effective_send_paused, true)
  assert.equal(settings.data.maintenance_mode, true)
  const overview = await api('GET', '/overview')
  assert.ok(overview.data.warnings.some(item => item.includes('维护模式')))
  assert.equal(overview.data.warnings.some(item => item.includes('收信继续')), false)
})

test('fetchHandler serves health probes, rejects non-GET/HEAD asset methods and masks uncaught errors', async () => {
  const env = { ...environment(), ASSETS: { fetch: async () => new Response('<html>app</html>', { headers: { 'Content-Type': 'text/html' } }) } }
  const live = await fetchHandler(new Request('https://mail.example.org/health/live'), { ...env, DEV_AUTH_BYPASS: undefined })
  assert.equal(live.status, 204)
  assert.equal(live.headers.get('Cache-Control'), 'no-store')

  const ready = await fetchHandler(new Request('http://127.0.0.1:8787/health/ready'), env)
  assert.equal(ready.status, 204)
  assert.equal(ready.headers.get('Cache-Control'), 'no-store')

  const asset = await fetchHandler(new Request('http://127.0.0.1:8787/'), env)
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('X-Frame-Options'), 'DENY')

  const notAllowed = await fetchHandler(new Request('http://127.0.0.1:8787/app', { method: 'POST' }), env)
  assert.equal(notAllowed.status, 405)
  assert.deepEqual(await notAllowed.json(), { error: { code: 'method_not_allowed', message: '不支持此请求方法' } })

  const brokenEnv = { ...env, DB: { prepare: () => { throw new Error('d1://secret-token@internal.example.test') } } }
  const unavailable = await fetchHandler(new Request('http://127.0.0.1:8787/health/ready'), brokenEnv)
  assert.equal(unavailable.status, 503)
  const body = await unavailable.json()
  assert.deepEqual(body, { error: { code: 'service_unavailable', message: '服务暂不可用，请稍后重试' } })
  assert.equal(JSON.stringify(body).includes('secret-token'), false)
})
