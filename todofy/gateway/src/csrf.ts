/**
 * Signed double-submit CSRF tokens for owner writes (same rules as Mail Hero's security.ts).
 *
 * A token is `base64url(json claims) "." base64url(HMAC-SHA256)` keyed by the CSRF_SIGNING_KEY
 * secret. The browser sends it twice: as the HttpOnly `todofy_csrf` cookie and in X-CSRF-Token;
 * both must match, carry a valid signature, belong to the owner and be unexpired.
 */
import { base64UrlEncode, decodeJsonSegment, isJsonObject, timingSafeEqual, utf8 } from './crypto.ts';
import { localDev, variable, type Env } from './env.ts';
import { cookieValues, HttpError, jsonResponse, nowSeconds, partition, type Context } from './http.ts';

const COOKIE = 'todofy_csrf';
const HEADER = 'x-csrf-token';
const TTL_S = 12 * 3600;
const MAX_TOKEN_CHARS = 1024;
const SIGNING_KEY = /^[0-9a-fA-F]{64}$/;

function failed(): HttpError {
  return new HttpError(403, 'csrf_failed');
}

/** The HMAC key; missing or malformed → 503 `not_configured` (reads keep working). */
async function signingKey(env: Env): Promise<CryptoKey> {
  const hex = variable(env, 'CSRF_SIGNING_KEY');
  if (!SIGNING_KEY.test(hex)) throw new HttpError(503, 'not_configured');
  const raw = Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function sign(key: CryptoKey, payload: string): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(payload))));
}

function allowedOrigins(ctx: Context): Set<string> {
  const origins = new Set([`https://${variable(ctx.env, 'TODOFY_PUBLIC_HOST').toLowerCase()}`]);
  // wrangler dev serves plain HTTP, possibly on a port.
  if (localDev(ctx.env)) origins.add(`http://${ctx.url.host.toLowerCase()}`);
  return origins;
}

/** GET /api/v1/csrf: a fresh token in the body and in the matching cookie. */
export async function issueCsrf(ctx: Context, owner: string): Promise<Response> {
  const key = await signingKey(ctx.env);
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const claims = { kind: 'csrf', owner, nonce, exp: nowSeconds() + TTL_S };
  const payload = base64UrlEncode(utf8(JSON.stringify(claims)));
  const token = `${payload}.${await sign(key, payload)}`;
  const secure = ctx.url.protocol === 'https:' ? '; Secure' : '';
  const response = jsonResponse({ token });
  response.headers.set(
    'set-cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(TTL_S)}${secure}`,
  );
  return response;
}

/** Throws HttpError(403 csrf_failed) unless Origin, header, cookie and signature all agree. */
export async function verifyCsrf(ctx: Context, owner: string): Promise<void> {
  const key = await signingKey(ctx.env);
  const { headers } = ctx.request;
  const provided = headers.get(HEADER) ?? '';
  const cookie = cookieValues(ctx.request, COOKIE)[0] ?? '';
  if (
    !allowedOrigins(ctx).has((headers.get('origin') ?? '').toLowerCase()) ||
    !provided ||
    provided.length > MAX_TOKEN_CHARS ||
    !timingSafeEqual(provided, cookie)
  ) {
    throw failed();
  }
  const [payload, signature] = partition(provided, '.');
  if (!timingSafeEqual(signature, await sign(key, payload))) throw failed();
  const claims = decodeJsonSegment(payload);
  if (
    !isJsonObject(claims) ||
    claims.kind !== 'csrf' ||
    claims.owner !== owner ||
    typeof claims.exp !== 'number' ||
    !Number.isInteger(claims.exp) ||
    claims.exp <= nowSeconds()
  ) {
    throw failed();
  }
}
