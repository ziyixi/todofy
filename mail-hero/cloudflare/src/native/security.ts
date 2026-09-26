import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Env } from './types.ts';

const encoder = new TextEncoder();
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export async function sha256(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data);
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
function hex(bytes: Uint8Array): string { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
function unhex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw new Error('invalid_ciphertext');
  return Uint8Array.from(value.match(/../g)!, s => parseInt(s, 16));
}
function master(env: Env): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{64}$/i.test(env.CREDENTIAL_KEY ?? '')) throw new Error('credential_key_not_configured');
  return unhex(env.CREDENTIAL_KEY);
}
async function encryptionKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', master(env), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function aad(revisionID: string, url: string): Uint8Array<ArrayBuffer> { return encoder.encode(`mail-hero:v1:${revisionID}:${url}`); }
export async function encryptCredential(env: Env, revisionID: string, url: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(revisionID, url) },
    await encryptionKey(env), encoder.encode(plaintext));
  return `v1.${hex(iv)}.${hex(new Uint8Array(cipher))}`;
}
export async function decryptCredential(env: Env, revisionID: string, url: string, value: string): Promise<string> {
  const [version, nonce, cipher, extra] = value.split('.');
  if (version !== 'v1' || extra || nonce?.length !== 24 || !cipher) throw new Error('invalid_ciphertext');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(nonce), additionalData: aad(revisionID, url) },
    await encryptionKey(env), unhex(cipher));
  return new TextDecoder().decode(plaintext);
}
async function signingKey(env: Env): Promise<CryptoKey> {
  // Domain separation: confirmation/CSRF tokens use a derived HMAC key.
  const key = await crypto.subtle.importKey('raw', master(env), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('mail-hero'), info: encoder.encode('tokens-v1') },
    key, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
}
export async function actionHash(env: Env, value: unknown): Promise<string> {
  // Request deduplication can include a low-entropy password. A plain digest
  // would leak an offline password verifier to anyone with a database dump.
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(`action:${JSON.stringify(value)}`))));
}
function base64url(bytes: Uint8Array): string {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('invalid_token');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
export async function signToken(env: Env, payload: Record<string, unknown>): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(sig))}`;
}
export async function verifyToken<T extends Record<string, unknown> = Record<string, unknown>>(env: Env, token: string): Promise<T | null> {
  try {
    if (token.length > 4096) return null;
    const [body, sig, extra] = token.split('.');
    if (!body || !sig || extra || !await crypto.subtle.verify('HMAC', await signingKey(env), decode64(sig), encoder.encode(body))) return null;
    const value = JSON.parse(new TextDecoder().decode(decode64(body)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (typeof value.exp !== 'number' || value.exp <= Date.now() / 1000) return null;
    return value as T;
  } catch { return null; }
}

/** Workers fetch has no Go-style DNS pinning. Destinations must be explicitly
 * provisioned public HTTPS hostnames; never use arbitrary mail/user URL values. */
export function validateTarget(env: Env, value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, 'invalid_target', 'Webhook URL 无效'); }
  const host = url.hostname.toLowerCase();
  const allowed = (env.WEBHOOK_ALLOWED_HOSTS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') ||
      !host.includes('.') || host.endsWith('.') || /[\[\]:]/.test(host) || /^\d+(\.\d+){3}$/.test(host) ||
      host === 'localhost' || /\.(localhost|local|internal|invalid|test)$/.test(host) || !allowed.includes(host)) {
    throw new HttpError(400, 'target_not_allowed', '目标必须是部署时允许的公网 HTTPS 域名');
  }
  return url;
}

const remoteKeys = new Map<string, JWTVerifyGetKey>();
function localRequest(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  return env.DEV_AUTH_BYPASS === 'true' && url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !request.headers.has('CF-Ray');
}
function cookie(request: Request, name: string): string | null {
  const pairs = request.headers.get('Cookie')?.split(';') ?? [];
  const value = pairs.map(p => p.trim()).find(p => p.startsWith(`${name}=`));
  return value ? value.slice(name.length + 1) : null;
}
export async function authenticate(request: Request, env: Env, keyResolver?: JWTVerifyGetKey): Promise<string> {
  if (localRequest(request, env)) return 'local-development';
  if (env.DEV_AUTH_BYPASS === 'true') throw new HttpError(503, 'invalid_auth_configuration', '开发认证模式仅限本机');
  const issuer = env.ACCESS_ISSUER?.replace(/\/$/, '');
  const owner = env.ACCESS_OWNER?.trim();
  const aliasConfig = env.ACCESS_OWNER_ALIASES ?? '';
  const aliases = aliasConfig.split(',').map(value => value.trim()).filter(Boolean);
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer ?? '') || !env.ACCESS_AUDIENCE || !owner || aliasConfig.length > 2048 || aliases.length > 8) {
    throw new HttpError(503, 'access_not_configured', '请先配置 Cloudflare Access');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion') ?? cookie(request, 'CF_Authorization');
  if (!token || token.length > 16000) throw new HttpError(401, 'unauthorized', '需要通过 Cloudflare Access 登录');
  let keys = keyResolver ?? remoteKeys.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
    remoteKeys.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, { issuer, audience: env.ACCESS_AUDIENCE, algorithms: ['RS256'], requiredClaims: ['exp','iat','sub','email'] });
    // Alternate login emails are the same owner, not separate users. Preserve
    // one principal for CSRF tokens and durable action-idempotency records.
    if (payload.email !== owner && !aliases.some(alias => payload.email === alias)) throw new Error('wrong_owner');
    return owner;
  } catch { throw new HttpError(401, 'unauthorized', 'Access 登录无效或无权限'); }
}
export async function csrfResponse(request: Request, env: Env, owner: string): Promise<Response> {
  const token = await signToken(env, { kind: 'csrf', owner, nonce: crypto.randomUUID(), exp: Math.floor(Date.now()/1000) + 43200 });
  const response = json({ token });
  response.headers.set('Set-Cookie', `mail_hero_csrf=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`);
  return response;
}
export async function requireCSRF(request: Request, env: Env, owner: string): Promise<void> {
  const provided = request.headers.get('X-CSRF-Token');
  if (request.headers.get('Origin') !== new URL(request.url).origin || !provided || provided !== cookie(request, 'mail_hero_csrf')) {
    throw new HttpError(403, 'csrf_failed', '请刷新页面后再试');
  }
  const token = await verifyToken(env, provided);
  if (token?.kind !== 'csrf' || token.owner !== owner) throw new HttpError(403, 'csrf_failed', '请刷新页面后再试');
}

export function privateResponse(response: Response): Response {
  const result = new Response(response.body, response);
  result.headers.set('Cache-Control', 'no-store');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  return result;
}
