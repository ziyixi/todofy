import { createAccessVerifier, deriveHmacKeyHkdf, issueCsrf, verifyCsrf, withPrivateHeaders,
  type AccessPolicy, type AccessVerifier, type CsrfPolicy } from '@ziyixi/edge-auth';
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
  // Domain separation: confirmation/CSRF tokens use a derived HMAC key. The
  // salt and info are fixed: CSRF cookies and preview tokens already issued stay valid.
  return deriveHmacKeyHkdf(master(env), 'mail-hero', 'tokens-v1');
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

/** Workers fetch does not pin destination DNS. Destinations must be explicitly
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

// Access JWT and CSRF are the shared packages/edge-auth, with Mail Hero's own
// parameters (packages/edge-auth/SPEC.md §4, §5.4). Statuses, codes and messages stay here.
const access = createAccessVerifier(); // module scope: one JWKS cache per isolate
function accessPolicy(env: Env): AccessPolicy {
  return {
    issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUDIENCE, owner: env.ACCESS_OWNER, aliases: env.ACCESS_OWNER_ALIASES,
    // Alternate login emails are the same owner, not separate users: exact match, one
    // canonical principal for CSRF tokens and durable action-idempotency records.
    emailMatch: 'exact', nbfLeewaySeconds: 0,
    tokenSource: { emptyHeader: 'missing', cookie: 'first' },
    jwks: { ttlMs: 600_000, refreshCooldownMs: 30_000 },
    devBypass: { enabled: env.DEV_AUTH_BYPASS === 'true', hosts: 'loopback-http', principal: 'local-development', whenNotLocal: 'refuse' },
  };
}
export async function authenticate(request: Request, env: Env, verifier: AccessVerifier = access): Promise<string> {
  const result = await verifier.verify(request, accessPolicy(env));
  if (result.ok) return result.owner;
  switch (result.failure) {
    case 'dev_bypass_refused': throw new HttpError(503, 'invalid_auth_configuration', '开发认证模式仅限本机');
    case 'not_configured': throw new HttpError(503, 'access_not_configured', '请先配置 Cloudflare Access');
    case 'missing_token': throw new HttpError(401, 'unauthorized', '需要通过 Cloudflare Access 登录');
    default: throw new HttpError(401, 'unauthorized', 'Access 登录无效或无权限'); // invalid_token, keys_unavailable
  }
}
function csrfPolicy(request: Request, env: Env): CsrfPolicy {
  // The key is lazy: a missing CREDENTIAL_KEY fails issue (503) and verify (403) as before.
  return { cookieName: 'mail_hero_csrf', key: () => signingKey(env), nonce: () => crypto.randomUUID(),
    ttlSeconds: 43200, allowedOrigins: [new URL(request.url).origin] };
}
export async function csrfResponse(request: Request, env: Env, owner: string): Promise<Response> {
  const { token, setCookie } = await issueCsrf(request, owner, csrfPolicy(request, env));
  const response = json({ token });
  response.headers.set('Set-Cookie', setCookie);
  return response;
}
export async function requireCSRF(request: Request, env: Env, owner: string): Promise<void> {
  if (!(await verifyCsrf(request, owner, csrfPolicy(request, env))).ok) throw new HttpError(403, 'csrf_failed', '请刷新页面后再试');
}

const MAIL_HERO_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export function privateResponse(response: Response): Response {
  return withPrivateHeaders(response, { csp: MAIL_HERO_CSP });
}
