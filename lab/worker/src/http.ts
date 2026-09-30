/**
 * The owner surface (docs/design.md §8): Access (edge-auth) on every path except /health, signed
 * double-submit CSRF plus Origin on mutations, private headers on every response, error envelopes. The
 * Worker validates input, reads D1 for the deck GETs and hands every mutation to LabState in one RPC.
 * Workers Free gives this handler 10 ms of CPU: bodies are at most 16 KiB, answers are bounded.
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
import { TASK_INTENT_MODES } from '../../../contracts/task-intent-v1/task-intent-v1.ts';
import { CATEGORIES_MAX, SEEDS_MAX, type ApiError, type CsrfResponse, type Decision, type SendMode, type Settings } from './api-types.ts';
import { bareId } from './arxiv.ts';
import { buildSha, isDay, publicHost } from './config.ts';
import { CATEGORY_SETTING_RE, decodeCursor, deckView, readDeck, readLiked, readSeeds, readSettings, sendRowFrom, summaryView, type SendDbRow } from './db.ts';
import type { Env } from './env.ts';
import { pollable, sendStatus } from './intent.ts';
import { TLDR_MODELS } from './models.ts';
import { settingsResponse, type DeckMutationInput, type OwnerResult } from './owner.ts';
import { LAB_OBJECT, type LabState } from './state.ts';

export const CSRF_COOKIE = 'lab_csrf';
export const MAX_BODY_BYTES = 16 * 1024;
export const JWKS_TTL_MS = 600_000;
export const JWKS_REFRESH_COOLDOWN_MS = 60_000;
export const NBF_LEEWAY_SECONDS = 60;
const IMMUTABLE = 'private, max-age=31536000, immutable';

export type ApiErrorCode =
  | 'unauthorized'
  | 'access_not_configured'
  | 'not_configured'
  | 'csrf_failed'
  | 'bad_request'
  | 'not_found'
  | 'method_not_allowed'
  | 'unavailable'
  | 'deck_not_found'
  | 'deck_changed'
  | 'already_decided'
  | 'nothing_to_undo'
  | 'deck_log_full'
  | 'not_in_deck'
  | 'nothing_to_send'
  | 'send_in_progress'
  | 'seeds_full';

export const MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  unauthorized: '未登录或凭据无效',
  access_not_configured: 'Cloudflare Access 配置不完整',
  not_configured: '服务缺少必需的密钥配置',
  csrf_failed: '页面安全令牌已失效，请刷新后重试',
  bad_request: '请求格式不正确',
  not_found: '找不到该资源',
  method_not_allowed: '不支持该请求方法',
  unavailable: '服务暂时不可用，请稍后再试',
  deck_not_found: '找不到这组卡片',
  deck_changed: '这组卡片已在其他设备上改动',
  already_decided: '这张卡片已经选过了',
  nothing_to_undo: '没有可以撤销的操作',
  deck_log_full: '这组卡片的操作次数已达上限',
  not_in_deck: '这篇论文不在这组卡片里',
  nothing_to_send: '没有需要发送的论文',
  send_in_progress: '这些论文正在发送中',
  seeds_full: `种子最多 ${String(SEEDS_MAX)} 篇`,
};

export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly headers: Readonly<Record<string, string>>;
  readonly extra: Readonly<Record<string, unknown>>;

  constructor(status: number, code: ApiErrorCode, headers: Readonly<Record<string, string>> = {}, extra: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.extra = extra;
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
  const body: ApiError & Record<string, unknown> = { ...error.extra, error: { code: error.code, message: MESSAGES[error.code], request_id: requestId } };
  const response = jsonResponse(body, error.status);
  for (const [name, value] of Object.entries(error.headers)) response.headers.set(name, value);
  return response;
}

// ---- Access and CSRF (packages/edge-auth SPEC §5.4, the dashboard's policy) ------------------------------

const verifier = createAccessVerifier();

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
    devBypass: {
      enabled: env.DEV_AUTH_BYPASS === 'true',
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

async function csrfKey(env: Env): Promise<CryptoKey> {
  const key = await importHmacKeyHex((env.CSRF_SIGNING_KEY ?? '').trim());
  if (key === null) throw new HttpError(503, 'not_configured');
  return key;
}

function allowedOrigins(ctx: Context, bypassed: boolean): string[] {
  const host = publicHost(ctx.env);
  const origins = host === null ? [] : [`https://${host}`];
  if (bypassed) origins.push(ctx.url.origin.toLowerCase());
  return origins;
}

async function checkCsrf(ctx: Context, owner: string, bypassed: boolean): Promise<void> {
  const key = await csrfKey(ctx.env);
  const result = await verifyCsrf(ctx.request, owner, { cookieName: CSRF_COOKIE, key, allowedOrigins: allowedOrigins(ctx, bypassed) });
  if (!result.ok) throw new HttpError(403, 'csrf_failed');
}

/** The body's bytes, at most `limit` (a larger declared or streamed body is refused). */
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

type Body = Record<string, unknown>;

async function readBody(request: Request): Promise<Body> {
  const bytes = await readLimited(request, MAX_BODY_BYTES);
  if (bytes === null) throw new HttpError(400, 'bad_request');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new HttpError(400, 'bad_request');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'bad_request');
  return value as Body;
}

// ---- input validation --------------------------------------------------------------------------------------

const OP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function bad(): never {
  throw new HttpError(400, 'bad_request');
}

/** The body has exactly these keys (op_id always). */
function keys(body: Body, allowed: readonly string[]): void {
  const names = Object.keys(body);
  if (names.length !== allowed.length || !names.every((name) => allowed.includes(name))) bad();
}

function opId(body: Body): string {
  const value = body['op_id'];
  return typeof value === 'string' && OP_ID.test(value.toLowerCase()) ? value.toLowerCase() : bad();
}

function version(body: Body): number {
  const value = body['base_version'];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : bad();
}

function paperId(value: unknown): string {
  return typeof value === 'string' && bareId(value) !== null ? value : bad();
}

function decision(value: unknown): Decision {
  return value === 'like' || value === 'dislike' ? value : bad();
}

function sendMode(value: unknown): SendMode {
  return (TASK_INTENT_MODES as readonly unknown[]).includes(value) ? (value as SendMode) : bad();
}

export function parseSettings(body: Body): Settings {
  keys(body, ['op_id', 'categories', 'lambda', 'neuron_cap', 'tldr_model', 'ingest_paused', 'send_mode']);
  const categories = body['categories'];
  if (
    !Array.isArray(categories) ||
    categories.length < 1 ||
    categories.length > CATEGORIES_MAX ||
    !categories.every((c) => typeof c === 'string' && CATEGORY_SETTING_RE.test(c)) ||
    new Set(categories).size !== categories.length
  ) {
    bad();
  }
  const lambda = body['lambda'];
  const cap = body['neuron_cap'];
  const model = body['tldr_model'];
  const paused = body['ingest_paused'];
  if (typeof lambda !== 'number' || !(lambda >= 0 && lambda <= 1)) bad();
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0) bad();
  if (!(TLDR_MODELS as readonly unknown[]).includes(model)) bad();
  if (typeof paused !== 'boolean') bad();
  return {
    categories: categories as string[],
    lambda,
    neuron_cap: cap,
    tldr_model: model as Settings['tldr_model'],
    ingest_paused: paused,
    send_mode: sendMode(body['send_mode']),
  };
}

// ---- routes ----------------------------------------------------------------------------------------------------

function lab(env: Env): DurableObjectStub<LabState> {
  return env.LAB.get(env.LAB.idFromName(LAB_OBJECT));
}

/** Any failure of the Durable Object call is 503 `unavailable`. */
async function callLab<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'unavailable');
  }
}

/** An OwnerResult as a response (409 deck_changed carries the current state). */
async function owned(fn: () => Promise<unknown>): Promise<Response> {
  const result = (await callLab(fn)) as OwnerResult<unknown>;
  if (result.ok) return jsonResponse(result.body, result.status);
  const code = (result.code in MESSAGES ? result.code : 'unavailable') as ApiErrorCode;
  throw new HttpError(result.status, code, {}, result.state === undefined ? {} : { state: result.state });
}

function methodNotAllowed(allow: string): HttpError {
  return new HttpError(405, 'method_not_allowed', { allow });
}

async function csrfResponse(ctx: Context, owner: string): Promise<Response> {
  const key = await csrfKey(ctx.env);
  const issued = await issueCsrf(ctx.request, owner, { cookieName: CSRF_COOKIE, key });
  const body: CsrfResponse = { token: issued.token };
  const response = jsonResponse(body);
  response.headers.set('set-cookie', issued.setCookie);
  return response;
}

const DECK_ROUTE = /^\/api\/decks\/([0-9]{4}-[0-9]{2}-[0-9]{2})(?:\/(decide|undo|restart|summary|exclude|send|later))?$/;

async function deckRoute(ctx: Context, day: string, action: string | undefined, mutate: () => Promise<Body>): Promise<Response> {
  const { env, request } = ctx;
  if (!isDay(day)) throw new HttpError(404, 'deck_not_found');
  const stub = () => lab(env);
  switch (action) {
    case undefined: {
      if (request.method !== 'GET') throw methodNotAllowed('GET');
      const bundle = await readDeck(env.DB, day);
      if (bundle === null || bundle.deck.ready_at === null) throw new HttpError(404, 'deck_not_found');
      return jsonResponse(deckView(bundle));
    }
    case 'summary': {
      if (request.method !== 'GET') throw methodNotAllowed('GET');
      const [bundle, settings] = await Promise.all([readDeck(env.DB, day), readSettings(env.DB)]);
      if (bundle === null || bundle.deck.ready_at === null) throw new HttpError(404, 'deck_not_found');
      return jsonResponse(summaryView(bundle, settings.send_mode));
    }
    case 'decide':
    case 'undo':
    case 'restart': {
      if (request.method !== 'POST') throw methodNotAllowed('POST');
      const body = await mutate();
      let input: DeckMutationInput;
      if (action === 'decide') {
        keys(body, ['op_id', 'base_version', 'paper_id', 'decision']);
        input = { kind: 'decide', op_id: opId(body), base_version: version(body), paper_id: paperId(body['paper_id']), decision: decision(body['decision']) };
      } else {
        keys(body, ['op_id', 'base_version']);
        input = { kind: action, op_id: opId(body), base_version: version(body) };
      }
      return owned(() => stub().mutateDeck(day, input));
    }
    case 'exclude': {
      if (request.method !== 'POST') throw methodNotAllowed('POST');
      const body = await mutate();
      keys(body, ['op_id', 'paper_id', 'excluded']);
      const excluded = body['excluded'];
      if (typeof excluded !== 'boolean') bad();
      const op = opId(body);
      const paper = paperId(body['paper_id']);
      return owned(() => stub().exclude(day, op, paper, excluded));
    }
    case 'later': {
      if (request.method !== 'POST') throw methodNotAllowed('POST');
      const body = await mutate();
      keys(body, ['op_id']);
      const op = opId(body);
      return owned(() => stub().later(day, op));
    }
    case 'send': {
      if (request.method === 'POST') {
        const body = await mutate();
        keys(body, ['op_id', 'mode']);
        const op = opId(body);
        const mode = sendMode(body['mode']);
        return owned(() => stub().send(day, op, mode));
      }
      if (request.method !== 'GET') throw methodNotAllowed('GET, POST');
      const row = await env.DB.prepare('SELECT * FROM sends WHERE deck_id = ? ORDER BY generation DESC LIMIT 1').bind(day).first<SendDbRow>();
      if (row === null) throw new HttpError(404, 'not_found');
      const send = sendRowFrom(row);
      if (pollable(send) && (send.next_poll_at === null || send.next_poll_at <= Date.now())) {
        const result = await callLab(() => stub().pollSend(day) as unknown as Promise<OwnerResult<unknown>>);
        if (result.ok && result.body !== null) return jsonResponse(result.body);
      }
      return jsonResponse(sendStatus(send));
    }
    default:
      throw new HttpError(404, 'not_found');
  }
}

async function api(ctx: Context, owner: string, bypassed: boolean): Promise<Response> {
  const { request, url, env } = ctx;
  const mutate = async (): Promise<Body> => {
    await checkCsrf(ctx, owner, bypassed);
    return readBody(request);
  };
  const deck = DECK_ROUTE.exec(url.pathname);
  if (deck) return deckRoute(ctx, deck[1] ?? '', deck[2], mutate);
  switch (url.pathname) {
    case '/api/csrf':
      if (request.method !== 'GET') throw methodNotAllowed('GET');
      return csrfResponse(ctx, owner);
    case '/api/today':
      if (request.method !== 'GET') throw methodNotAllowed('GET');
      return jsonResponse(await callLab(() => lab(env).today()));
    case '/api/status':
      if (request.method !== 'GET') throw methodNotAllowed('GET');
      return jsonResponse(await callLab(() => lab(env).statusView()));
    case '/api/liked': {
      if (request.method !== 'GET') throw methodNotAllowed('GET');
      const cursorText = url.searchParams.get('cursor');
      const cursor = decodeCursor(cursorText);
      if (cursorText !== null && cursorText !== '' && cursor === null) bad();
      const q = url.searchParams.get('q');
      return jsonResponse(await readLiked(env.DB, cursor, q === null || q.length > 200 ? null : q));
    }
    case '/api/feedback': {
      if (request.method !== 'POST') throw methodNotAllowed('POST');
      const body = await mutate();
      keys(body, ['op_id', 'paper_id', 'label']);
      const op = opId(body);
      const paper = paperId(body['paper_id']);
      const label = body['label'] === null ? null : decision(body['label']);
      return owned(() => lab(env).feedback(op, paper, label));
    }
    case '/api/seeds': {
      if (request.method === 'GET') return jsonResponse({ seeds: await readSeeds(env.DB) });
      if (request.method === 'POST') {
        const body = await mutate();
        keys(body, ['op_id', 'ids']);
        const op = opId(body);
        const ids = body['ids'];
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > SEEDS_MAX || !ids.every((id) => typeof id === 'string' && id.length <= 200)) bad();
        return owned(() => lab(env).addSeeds(op, ids as string[]));
      }
      if (request.method === 'DELETE') {
        const body = await mutate();
        keys(body, ['op_id', 'paper_id']);
        const op = opId(body);
        const paper = paperId(body['paper_id']);
        return owned(() => lab(env).removeSeed(op, paper));
      }
      throw methodNotAllowed('GET, POST, DELETE');
    }
    case '/api/settings': {
      if (request.method === 'GET') return jsonResponse(await settingsResponse({ db: env.DB, env }));
      if (request.method === 'PUT') {
        const body = await mutate();
        const settings = parseSettings(body);
        const op = opId(body);
        return owned(() => lab(env).putSettings(op, settings));
      }
      throw methodNotAllowed('GET, PUT');
    }
    default:
      throw new HttpError(404, 'not_found');
  }
}

async function route(ctx: Context): Promise<{ response: Response; asset: boolean }> {
  const { request, url, env } = ctx;
  if (url.pathname === '/health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw methodNotAllowed('GET, HEAD');
    return { response: jsonResponse({ service: 'lab', status: 'ok', build: buildSha(env) }), asset: false };
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
  if (request.body !== null && !request.body.locked) await request.body.cancel();
  return finalize(result.response, result.asset);
}
