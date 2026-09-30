/**
 * The owner surface (docs/design.md §6): Access (edge-auth) on every path except /health, signed
 * double-submit CSRF plus Origin on mutations, private headers on every response, error envelopes.
 * No business logic: every API call is one RPC to HomeState. Workers Free gives this handler 10 ms of
 * CPU, so it never reads or parses more than a 1 KiB body (a chunked upload is cut off after 1 KiB).
 */
import {
  STRICT_CSP,
  asciiLowerCase,
  createAccessVerifier,
  importHmacKeyHex,
  issueCsrf,
  verifyCsrf,
  withPrivateHeaders,
  type AccessPolicy,
} from '@ziyixi/edge-auth';
import { GUARD_LEVELS, type GuardLevel } from '../../../contracts/ops-v1/ops-v1.ts';
import type { ApiError, ApiErrorCode, CsrfResponse, GuardRequest, HealthResponse, OverviewResponse } from './api-types.ts';
import { buildSha, publicHost } from './config.ts';
import type { Env } from './env.ts';
import { HOME_OBJECT, type GuardOverrideOutcome, type HomeState, type StartCanaryOutcome } from './state.ts';

export const CSRF_COOKIE = 'home_csrf';
export const MAX_BODY_BYTES = 1024;
/** Access signing keys are cached for 10 minutes (the SPEC's stricter default; Todofy uses 1 h). */
export const JWKS_TTL_MS = 600_000;
export const JWKS_REFRESH_COOLDOWN_MS = 60_000;
export const NBF_LEEWAY_SECONDS = 60;
const IMMUTABLE = 'private, max-age=31536000, immutable';

export const MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  unauthorized: '未登录或凭据无效',
  access_not_configured: 'Cloudflare Access 配置不完整',
  not_configured: '服务缺少必需的密钥配置',
  csrf_failed: '页面安全令牌已失效，请刷新后重试',
  bad_request: '请求格式不正确',
  not_found: '找不到该资源',
  method_not_allowed: '不支持该请求方法',
  canary_active: '已有金丝雀运行正在进行',
  canary_limit: '今天的手动金丝雀次数已用完',
  unavailable: '依赖服务暂时不可用，请稍后再试',
};

export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, code: ApiErrorCode, headers: Readonly<Record<string, string>> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

interface Context {
  readonly request: Request;
  readonly env: Env;
  readonly url: URL;
  readonly requestId: string;
}

export function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** The error envelope; one log line with the request ID, status and code only. */
export function errorResponse(requestId: string, error: HttpError): Response {
  console.log(JSON.stringify({ request_id: requestId, status: error.status, code: error.code }));
  const body: ApiError = { error: { code: error.code, message: MESSAGES[error.code], request_id: requestId } };
  const response = jsonResponse(body, error.status);
  for (const [name, value] of Object.entries(error.headers)) response.headers.set(name, value);
  return response;
}

// ---- Access ---------------------------------------------------------------------------------------

/** One verifier per isolate: it owns the per-issuer key cache. */
const verifier = createAccessVerifier();

function localBypass(env: Env): boolean {
  return env.DEV_AUTH_BYPASS === 'true';
}

export function accessPolicy(env: Env): AccessPolicy {
  return {
    issuer: env.ACCESS_ISSUER,
    audience: env.ACCESS_AUDIENCE,
    owner: env.ACCESS_OWNER,
    aliases: env.ACCESS_OWNER_ALIASES,
    emailMatch: 'case-insensitive',
    nbfLeewaySeconds: NBF_LEEWAY_SECONDS,
    tokenSource: { emptyHeader: 'use-cookie', cookie: 'last' },
    jwks: { ttlMs: JWKS_TTL_MS, refreshCooldownMs: JWKS_REFRESH_COOLDOWN_MS },
    // Local development only: http://localhost|127.0.0.1|[::1] without cf-ray. Anywhere else an enabled
    // bypass refuses every request (503) instead of silently verifying.
    devBypass: {
      enabled: localBypass(env),
      hosts: 'loopback-http',
      principal: asciiLowerCase((env.ACCESS_OWNER ?? '').trim()),
      whenNotLocal: 'refuse',
    },
  };
}

async function authenticate(ctx: Context): Promise<{ owner: string; bypassed: boolean }> {
  const result = await verifier.verify(ctx.request, accessPolicy(ctx.env));
  if (result.ok) return { owner: result.owner, bypassed: result.bypassed };
  switch (result.failure) {
    case 'not_configured':
    case 'dev_bypass_refused':
      throw new HttpError(503, 'access_not_configured');
    case 'keys_unavailable':
      throw new HttpError(503, 'unavailable');
    case 'missing_token':
    case 'invalid_token':
      throw new HttpError(401, 'unauthorized');
  }
}

// ---- CSRF -----------------------------------------------------------------------------------------

async function csrfKey(env: Env): Promise<CryptoKey> {
  const key = await importHmacKeyHex((env.CSRF_SIGNING_KEY ?? '').trim());
  if (key === null) throw new HttpError(503, 'not_configured');
  return key;
}

function allowedOrigins(ctx: Context, bypassed: boolean): string[] {
  const host = publicHost(ctx.env);
  const origins = host === null ? [] : [`https://${host}`];
  // The loopback dev server is plain HTTP on its own port.
  if (bypassed) origins.push(ctx.url.origin.toLowerCase());
  return origins;
}

async function checkCsrf(ctx: Context, owner: string, bypassed: boolean): Promise<void> {
  // The key comes first, so a missing key answers 503 whatever the request carries.
  const key = await csrfKey(ctx.env);
  const result = await verifyCsrf(ctx.request, owner, { cookieName: CSRF_COOKIE, key, allowedOrigins: allowedOrigins(ctx, bypassed) });
  if (!result.ok) throw new HttpError(403, 'csrf_failed');
}

/**
 * The body's bytes, at most `limit`: a declared Content-Length above it is refused before reading, and
 * a body without one (chunked) is read only until it passes the limit, then cancelled.
 */
export async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  const header = request.headers.get('content-length');
  if (header !== null && !(/^[0-9]{1,10}$/.test(header.trim()) && Number(header.trim()) <= limit)) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** A JSON object body of at most 1 KiB; an empty body reads as `{}`. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readLimited(request, MAX_BODY_BYTES);
  if (bytes === null) throw new HttpError(400, 'bad_request');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new HttpError(400, 'bad_request');
  }
  if (text.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_request');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'bad_request');
  return value as Record<string, unknown>;
}

// ---- routes ---------------------------------------------------------------------------------------

function home(env: Env): DurableObjectStub<HomeState> {
  return env.HOME.get(env.HOME.idFromName(HOME_OBJECT));
}

function methodNotAllowed(allow: string): HttpError {
  return new HttpError(405, 'method_not_allowed', { allow });
}

/** Any failure of the Durable Object call is 503 `unavailable`. */
async function callHome<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'unavailable');
  }
}

const API_ROUTES: Readonly<Record<string, string>> = {
  '/api/v1/csrf': 'GET',
  '/api/v1/overview': 'GET',
  '/api/v1/canary': 'POST',
  '/api/v1/guard': 'POST',
};

async function api(ctx: Context, owner: string, bypassed: boolean): Promise<Response> {
  const { request, url, env } = ctx;
  const method = API_ROUTES[url.pathname];
  if (method === undefined) throw new HttpError(404, 'not_found');
  if (request.method !== method) throw methodNotAllowed(method);

  switch (url.pathname) {
    case '/api/v1/csrf': {
      const key = await csrfKey(env);
      const issued = await issueCsrf(request, owner, { cookieName: CSRF_COOKIE, key });
      const body: CsrfResponse = { token: issued.token };
      const response = jsonResponse(body);
      response.headers.set('set-cookie', issued.setCookie);
      return response;
    }
    case '/api/v1/overview': {
      const refresh = url.searchParams.get('refresh') === '1';
      return jsonResponse(await callHome(() => home(env).overview(refresh) as unknown as Promise<OverviewResponse>));
    }
    case '/api/v1/canary': {
      await checkCsrf(ctx, owner, bypassed);
      const body = await readBody(request);
      if (Object.keys(body).length > 0) throw new HttpError(400, 'bad_request');
      const result = await callHome(() => home(env).startCanary() as unknown as Promise<StartCanaryOutcome>);
      if (result.ok) return jsonResponse({ run: result.run }, 202);
      if (result.code === 'canary_active') throw new HttpError(409, 'canary_active');
      throw new HttpError(429, 'canary_limit');
    }
    default: {
      // '/api/v1/guard'
      await checkCsrf(ctx, owner, bypassed);
      const body = await readBody(request);
      const level = body.level;
      if (Object.keys(body).length !== 1 || !(GUARD_LEVELS as readonly unknown[]).includes(level)) {
        throw new HttpError(400, 'bad_request');
      }
      const input: GuardRequest = { level: level as GuardLevel };
      const result = await callHome(() => home(env).setGuardOverride(input.level) as unknown as Promise<GuardOverrideOutcome>);
      return jsonResponse({ guard: result.guard });
    }
  }
}

async function route(ctx: Context): Promise<{ response: Response; asset: boolean }> {
  const { request, url, env } = ctx;
  if (url.pathname === '/health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw methodNotAllowed('GET, HEAD');
    const body: HealthResponse = { service: 'home', status: 'ok', build: buildSha(env) };
    return { response: jsonResponse(body), asset: false };
  }
  const { owner, bypassed } = await authenticate(ctx);
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return { response: await api(ctx, owner, bypassed), asset: false };
  if (request.method !== 'GET' && request.method !== 'HEAD') throw methodNotAllowed('GET, HEAD');
  return { response: await env.ASSETS.fetch(request), asset: url.pathname.startsWith('/assets/') };
}

function finalize(response: Response, asset: boolean): Response {
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const cacheable = asset && response.status === 200 && mediaType !== 'text/html';
  return withPrivateHeaders(response, cacheable ? { csp: STRICT_CSP, cacheControl: IMMUTABLE } : { csp: STRICT_CSP });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const ctx: Context = { request, env, url: new URL(request.url), requestId: newRequestId() };
  let result: { response: Response; asset: boolean };
  try {
    result = await route(ctx);
  } catch (error) {
    const httpError = error instanceof HttpError ? error : new HttpError(503, 'unavailable');
    result = { response: errorResponse(ctx.requestId, httpError), asset: false };
  }
  // An answer given on the headers alone leaves the upload unread: discard it.
  if (request.body !== null && !request.body.locked) await request.body.cancel();
  return finalize(result.response, result.asset);
}
