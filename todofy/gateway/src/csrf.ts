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
import { jsonResponse } from './http.ts';
import { uiError } from './ui.ts';

const COOKIE = 'todofy_csrf';

/** The HMAC key; missing or malformed → NOT_CONFIGURED (reads keep working). */
async function signingKey(env: Env): Promise<CryptoKey> {
  const key = await importHmacKeyHex(variable(env, 'CSRF_SIGNING_KEY'));
  if (key === null) throw uiError('NOT_CONFIGURED');
  return key;
}

function allowedOrigins(env: Env, url: URL): string[] {
  const origins = [`https://${variable(env, 'TODOFY_PUBLIC_HOST').toLowerCase()}`];
  // wrangler dev serves plain HTTP, possibly on a port.
  if (localDev(env)) origins.push(`http://${url.host.toLowerCase()}`);
  return origins;
}

/** GET /api/csrf: a fresh token in the body and in the matching cookie. Throws RpcError NOT_CONFIGURED. */
export async function issueCsrf(request: Request, env: Env, owner: string): Promise<Response> {
  const key = await signingKey(env);
  const { token, setCookie } = await issue(request, owner, { cookieName: COOKIE, key });
  const response = jsonResponse({ token });
  response.headers.set('set-cookie', setCookie);
  return response;
}

/** Throws RpcError CSRF_FAILED unless Origin, header, cookie and signature all agree (NOT_CONFIGURED first). */
export async function verifyCsrf(request: Request, env: Env, owner: string): Promise<void> {
  // The key is checked first, so a missing key answers NOT_CONFIGURED whatever the request carries.
  const key = await signingKey(env);
  const result = await verify(request, owner, { cookieName: COOKIE, key, allowedOrigins: allowedOrigins(env, new URL(request.url)) });
  if (!result.ok) throw uiError('CSRF_FAILED');
}
