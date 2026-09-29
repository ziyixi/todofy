/**
 * Signed double-submit CSRF tokens for owner writes, issued and verified by the shared
 * `@ziyixi/edge-auth` package (packages/edge-auth, SPEC.md) with Todofy's cookie and key.
 *
 * A token is `base64url(json claims) "." base64url(HMAC-SHA256)` keyed by the CSRF_SIGNING_KEY
 * secret. The browser sends it twice: as the HttpOnly `todofy_csrf` cookie and in X-CSRF-Token;
 * both must match, carry a valid signature, belong to the owner and be unexpired.
 */
import { importHmacKeyHex, issueCsrf as issue, verifyCsrf as verify } from '@ziyixi/edge-auth';
import { localDev, variable, type Env } from './env.ts';
import { HttpError, jsonResponse, type Context } from './http.ts';

const COOKIE = 'todofy_csrf';

/** The HMAC key; missing or malformed → 503 `not_configured` (reads keep working). */
async function signingKey(env: Env): Promise<CryptoKey> {
  const key = await importHmacKeyHex(variable(env, 'CSRF_SIGNING_KEY'));
  if (key === null) throw new HttpError(503, 'not_configured');
  return key;
}

function allowedOrigins(ctx: Context): string[] {
  const origins = [`https://${variable(ctx.env, 'TODOFY_PUBLIC_HOST').toLowerCase()}`];
  // wrangler dev serves plain HTTP, possibly on a port.
  if (localDev(ctx.env)) origins.push(`http://${ctx.url.host.toLowerCase()}`);
  return origins;
}

/** GET /api/v1/csrf: a fresh token in the body and in the matching cookie. */
export async function issueCsrf(ctx: Context, owner: string): Promise<Response> {
  const key = await signingKey(ctx.env);
  const { token, setCookie } = await issue(ctx.request, owner, { cookieName: COOKIE, key });
  const response = jsonResponse({ token });
  response.headers.set('set-cookie', setCookie);
  return response;
}

/** Throws HttpError(403 csrf_failed) unless Origin, header, cookie and signature all agree. */
export async function verifyCsrf(ctx: Context, owner: string): Promise<void> {
  // The key is checked first, so a missing key answers 503 whatever the request carries.
  const key = await signingKey(ctx.env);
  const result = await verify(ctx.request, owner, { cookieName: COOKIE, key, allowedOrigins: allowedOrigins(ctx) });
  if (!result.ok) throw new HttpError(403, 'csrf_failed');
}
