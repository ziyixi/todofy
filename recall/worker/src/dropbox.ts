/**
 * The Dropbox API v2 as recall uses it (../../docs/design.md §7.2): OAuth 2 with PKCE for an App-folder app (no app
 * secret), refresh tokens, `files/upload` (with Dropbox's content hash, which Dropbox checks), `files/download` (only
 * the archive's state.json, to see whose archive a folder holds), `users/get_current_account` (the display name) and
 * `auth/token/revoke`. Nothing here deletes a file. Every call has a timeout; every failure becomes a DropboxError
 * with a code the status shows (backup.ts) and, for 429, Dropbox's Retry-After. No token, path or body is logged.
 */
import { hex } from './blobs.ts';
import { DROPBOX_TIMEOUT_MS } from './limits.ts';

/** Dropbox's three hosts: the browser's authorization page, the RPC endpoints, the content endpoints. */
export interface DropboxEndpoints {
  readonly authorize: string;
  readonly api: string;
  readonly content: string;
}

export const DROPBOX: DropboxEndpoints = { authorize: 'https://www.dropbox.com', api: 'https://api.dropboxapi.com', content: 'https://content.dropboxapi.com' };

const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/;

/** Dropbox, or the smoke run's loopback fake (DEV_DROPBOX_ORIGIN, only with the loopback login bypass on). */
export function dropboxEndpoints(env: { readonly DEV_DROPBOX_ORIGIN?: string; readonly DEV_AUTH_BYPASS?: string }): DropboxEndpoints {
  const origin = (env.DEV_DROPBOX_ORIGIN ?? '').trim();
  if (env.DEV_AUTH_BYPASS === 'true' && LOOPBACK_ORIGIN.test(origin)) return { authorize: origin, api: origin, content: origin };
  return DROPBOX;
}

/** Why a Dropbox call failed, as the status names it, and how long Dropbox asked to wait (429). */
export class DropboxError extends Error {
  readonly code: string;
  readonly retryAfterMs: number | null;

  constructor(code: string, retryAfterMs: number | null = null) {
    super(code);
    this.name = 'DropboxError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A random string of `bytes` random bytes, base64url (a state, a code verifier). */
export function randomText(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The PKCE challenge of a verifier (S256): base64url of its SHA-256. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** The authorization page the owner's browser goes to (an offline token: a refresh token comes back). */
export function authorizeUrl(endpoints: DropboxEndpoints, input: { readonly appKey: string; readonly challenge: string; readonly redirectUri: string; readonly state: string }): string {
  const query = new URLSearchParams({
    client_id: input.appKey,
    response_type: 'code',
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `${endpoints.authorize}/oauth2/authorize?${query.toString()}`;
}

/**
 * Dropbox's content hash of bytes (its /developers/reference/content-hash): the SHA-256 of the concatenated SHA-256s
 * of each 4 MiB block, hex.
 */
export async function contentHash(bytes: Uint8Array): Promise<string> {
  const block = 4 * 1024 * 1024;
  const digests: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += block) digests.push(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.subarray(at, at + block))));
  const joined = new Uint8Array(digests.length * 32);
  digests.forEach((digest, index) => {
    joined.set(digest, index * 32);
  });
  return hex(await crypto.subtle.digest('SHA-256', joined));
}

/** A JSON value as Dropbox-API-Arg carries it: ASCII only, other characters escaped. */
export function apiArg(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Seconds of a Retry-After header (or Dropbox's error.retry_after), as milliseconds; null when absent. */
function retryAfter(response: Response, body: unknown): number | null {
  const header = Number(response.headers.get('retry-after') ?? '');
  if (Number.isFinite(header) && header >= 0 && (response.headers.get('retry-after') ?? '') !== '') return header * 1000;
  const fromBody = (body as { error?: { retry_after?: unknown } } | null)?.error?.retry_after;
  return typeof fromBody === 'number' && fromBody >= 0 ? fromBody * 1000 : null;
}

/** The failure a Dropbox answer means (status, then error_summary). */
export function failureOf(response: Response, body: unknown, summary: string): DropboxError {
  const status = response.status;
  if (status === 429 || summary.includes('too_many_write_operations') || summary.includes('too_many_requests')) return new DropboxError('dropbox_rate_limited', retryAfter(response, body));
  // A token without a scope the call needs (the app's permissions changed after the connection) is 401 missing_scope:
  // refreshing gives the same scopes, so the owner must tick the permission and connect again.
  if (status === 403 || summary.includes('missing_scope')) return new DropboxError('dropbox_permission');
  if (status === 401) return new DropboxError('dropbox_token');
  if (status >= 500) return new DropboxError('dropbox_unavailable', retryAfter(response, body));
  if (summary.includes('insufficient_space')) return new DropboxError('dropbox_full');
  if (summary.includes('not_found')) return new DropboxError('not_found');
  if (summary.includes('conflict')) return new DropboxError('dropbox_conflict');
  return new DropboxError('dropbox_bad_request');
}

/** One call: a network failure or a timeout is `dropbox_unavailable`; a refusal its failureOf. */
async function call(fetcher: Fetcher, url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(DROPBOX_TIMEOUT_MS) });
  } catch {
    throw new DropboxError('dropbox_unavailable');
  }
  if (response.ok) return response;
  const text = await response.text().catch(() => '');
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the status alone says what failed.
  }
  const summary = typeof (body as { error_summary?: unknown } | null)?.error_summary === 'string' ? (body as { error_summary: string }).error_summary : '';
  // The OAuth endpoint answers 400 invalid_grant for a refresh token or code it no longer accepts.
  if (response.status === 400 && (body as { error?: unknown } | null)?.error === 'invalid_grant') throw new DropboxError('dropbox_refused');
  throw failureOf(response, body, summary);
}

async function json<T>(response: Response): Promise<T> {
  try {
    return await response.json<T>();
  } catch {
    throw new DropboxError('dropbox_bad_response');
  }
}

/** A token endpoint's answer. */
interface TokenAnswer {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
  readonly refresh_token?: unknown;
  readonly account_id?: unknown;
}

function form(fields: Record<string, string>): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() };
}

export interface AccessToken {
  readonly token: string;
  readonly expiresInMs: number;
}

function accessOf(answer: TokenAnswer): AccessToken {
  if (typeof answer.access_token !== 'string' || answer.access_token === '') throw new DropboxError('dropbox_bad_response');
  const seconds = typeof answer.expires_in === 'number' && answer.expires_in > 0 ? answer.expires_in : 3600;
  return { token: answer.access_token, expiresInMs: seconds * 1000 };
}

/** The code the browser brought back, exchanged with the PKCE verifier for a refresh token (and a first access token). */
export async function exchangeCode(
  fetcher: Fetcher,
  endpoints: DropboxEndpoints,
  input: { readonly appKey: string; readonly code: string; readonly verifier: string; readonly redirectUri: string },
): Promise<{ readonly refreshToken: string; readonly accountId: string; readonly access: AccessToken }> {
  const response = await call(
    fetcher,
    `${endpoints.api}/oauth2/token`,
    form({ grant_type: 'authorization_code', code: input.code, client_id: input.appKey, code_verifier: input.verifier, redirect_uri: input.redirectUri }),
  );
  const answer = await json<TokenAnswer>(response);
  if (typeof answer.refresh_token !== 'string' || answer.refresh_token === '') throw new DropboxError('dropbox_bad_response');
  return { refreshToken: answer.refresh_token, accountId: typeof answer.account_id === 'string' ? answer.account_id : '', access: accessOf(answer) };
}

/** A new access token for the refresh token (`dropbox_refused` once Dropbox no longer accepts it). */
export async function refreshAccess(fetcher: Fetcher, endpoints: DropboxEndpoints, input: { readonly appKey: string; readonly refreshToken: string }): Promise<AccessToken> {
  const response = await call(fetcher, `${endpoints.api}/oauth2/token`, form({ grant_type: 'refresh_token', refresh_token: input.refreshToken, client_id: input.appKey }));
  return accessOf(await json<TokenAnswer>(response));
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** The account's display name (account_info.read, which every scoped app has). */
export async function accountName(fetcher: Fetcher, endpoints: DropboxEndpoints, token: string): Promise<string> {
  const response = await call(fetcher, `${endpoints.api}/2/users/get_current_account`, { method: 'POST', headers: bearer(token) });
  const answer = await json<{ name?: { display_name?: unknown } }>(response);
  const name = answer.name?.display_name;
  return typeof name === 'string' ? name.slice(0, 200) : '';
}

/** Revokes the access token and, with it, its refresh token. */
export async function revokeToken(fetcher: Fetcher, endpoints: DropboxEndpoints, token: string): Promise<void> {
  await call(fetcher, `${endpoints.api}/2/auth/token/revoke`, { method: 'POST', headers: bearer(token) });
}

/**
 * Writes a file at `path` (in the app folder) and answers its content hash. `add` never replaces a file of other bytes
 * (`dropbox_conflict`); writing the same bytes again is no conflict. `overwrite` replaces it. Dropbox refuses bytes
 * whose content hash is not the one sent, so what it keeps is what was meant.
 */
export async function uploadFile(
  fetcher: Fetcher,
  endpoints: DropboxEndpoints,
  token: string,
  input: { readonly path: string; readonly bytes: Uint8Array; readonly mode: 'add' | 'overwrite'; readonly contentHash: string },
): Promise<void> {
  const arg = { path: input.path, mode: input.mode, autorename: false, mute: true, strict_conflict: false, content_hash: input.contentHash };
  const response = await call(fetcher, `${endpoints.content}/2/files/upload`, {
    method: 'POST',
    headers: { ...bearer(token), 'content-type': 'application/octet-stream', 'dropbox-api-arg': apiArg(arg) },
    body: input.bytes,
  });
  const answer = await json<{ content_hash?: unknown }>(response);
  if (answer.content_hash !== input.contentHash) throw new DropboxError('dropbox_bad_response');
}

/** A file's bytes, or null when the path holds none. */
export async function downloadFile(fetcher: Fetcher, endpoints: DropboxEndpoints, token: string, path: string): Promise<Uint8Array | null> {
  try {
    const response = await call(fetcher, `${endpoints.content}/2/files/download`, { method: 'POST', headers: { ...bearer(token), 'dropbox-api-arg': apiArg({ path }) } });
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof DropboxError && error.code === 'not_found') return null;
    throw error;
  }
}
