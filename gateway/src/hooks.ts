/** Machine endpoints on every TODOFY_HOOKS_HOSTS name: health, the Mail Hero webhook, newsletter reports. */
import { forward } from './coordinator.ts';
import { base64DecodeStrict, matchesAny, sha256Hex, utf8 } from './crypto.ts';
import { csv, flag, variable } from './env.ts';
import { errorResponse, jsonResponse, mediaType, nowSeconds, partition, type Context } from './http.ts';

const MAX_EVENT_BYTES = 1024 * 1024;
// Mail Hero backs off on 503 and honours Retry-After; one cron interval.
const MAINTENANCE_RETRY_AFTER_S = '600';
const HOUR_S = 3600;

/**
 * The UTC hour (YYYY-MM-DDTHH) in which the core last answered a failed Basic login with 429.
 * Later failures in that hour get 429 from here, so a guessing flood does not spend DO requests.
 */
let lockedHour: string | null = null;

export async function handleHooks(ctx: Context): Promise<Response> {
  const { method } = ctx.request;
  const path = ctx.url.pathname;
  if (method === 'POST' && path === '/hooks/mail') return mail(ctx);
  if (method === 'GET' && path === '/api/summary') return report(ctx, 'summary');
  if (method === 'GET' && path === '/api/recommendation') return report(ctx, 'recommendation');
  if (method === 'GET' && path === '/health') return health(ctx);
  return errorResponse(ctx.requestId, 404, 'not_found');
}

/**
 * service/status/timestamp are the Go service's shape: the newsletter's startup preflight refuses
 * to start unless service == "todofy" and status == "healthy". Never calls the core.
 */
function health(ctx: Context): Response {
  return jsonResponse({
    build: variable(ctx.env, 'BUILD_SHA', 'unknown'),
    service: 'todofy',
    status: 'healthy',
    timestamp: `${new Date().toISOString().slice(0, 19)}Z`,
  });
}

async function bearerOk(header: string, digests: readonly string[]): Promise<boolean> {
  const [scheme, token] = partition(header, ' ');
  if (scheme !== 'Bearer' || !token || token.includes(' ')) return false;
  return matchesAny(await sha256Hex(utf8(token)), digests);
}

async function mail(ctx: Context): Promise<Response> {
  const { env, request, requestId } = ctx;
  const digests = (['MAIL_WEBHOOK_TOKEN_SHA256', 'MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS'] as const)
    .map((name) => variable(env, name).toLowerCase())
    .filter(Boolean);
  if (digests.length === 0) return errorResponse(requestId, 503, 'not_configured');
  if (!(await bearerOk(request.headers.get('authorization') ?? '', digests))) {
    return errorResponse(requestId, 401, 'unauthorized');
  }
  if (flag(env, 'MAINTENANCE_MODE')) {
    return errorResponse(requestId, 503, 'maintenance', { 'retry-after': MAINTENANCE_RETRY_AFTER_S });
  }
  if (mediaType(request.headers) !== 'application/json') {
    return errorResponse(requestId, 415, 'unsupported_media_type');
  }
  // A declared length is checked here; the core caps a chunked body while reading it.
  const length = request.headers.get('content-length') ?? '';
  if (/^\d+$/.test(length) && Number(length) > MAX_EVENT_BYTES) {
    return errorResponse(requestId, 413, 'payload_too_large');
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = request.headers.get('idempotency-key');
  if (key !== null) headers['idempotency-key'] = key;
  // The body is streamed unread: parsing, hashing and D1 writes run in the object (30 s of CPU).
  return forward(ctx, '/ingest', { method: 'POST', headers, body: request.body });
}

async function basicOk(header: string, digests: readonly string[]): Promise<boolean> {
  const [scheme, encoded] = partition(header, ' ');
  if (scheme.toLowerCase() !== 'basic') return false;
  const credentials = base64DecodeStrict(encoded.trim());
  return credentials !== null && matchesAny(await sha256Hex(credentials), digests);
}

/**
 * A correct credential goes straight to the report and never reads the failure counter, so
 * failures cannot lock the newsletter out. A failure is counted by the core (D1, per UTC hour):
 * 401 until 20, then 429 without further writes.
 */
async function report(ctx: Context, kind: 'summary' | 'recommendation'): Promise<Response> {
  const digests = csv(ctx.env, 'REPORT_BASIC_AUTH_SHA256');
  if (digests.length === 0) return errorResponse(ctx.requestId, 503, 'not_configured');
  if (await basicOk(ctx.request.headers.get('authorization') ?? '', digests)) {
    return forward(ctx, `/newsletter/${kind}${ctx.url.search}`, { method: 'GET' });
  }
  const now = nowSeconds();
  const hour = new Date(now * 1000).toISOString().slice(0, 13);
  if (hour === lockedHour) {
    return errorResponse(ctx.requestId, 429, 'rate_limited', {
      'retry-after': String(HOUR_S - (now % HOUR_S)),
    });
  }
  const response = await forward(ctx, '/newsletter/auth-failure', { method: 'POST' });
  if (response.status === 429) lockedHour = hour;
  return response;
}
