import { STRICT_CSP, withPrivateHeaders as withHeaders } from '@ziyixi/edge-auth';
import type { Env } from './env.ts';

/** One incoming request as the handlers see it. */
export interface Context {
  readonly request: Request;
  readonly env: Env;
  readonly url: URL;
  /** 16 lowercase hex characters; used in every error envelope, the core's included. */
  readonly requestId: string;
}

/**
 * The error codes the gateway emits on its own, with the UI text from
 * `worker/todofy/core/api_errors.py` (a unit test keeps the two tables equal). The core sends the
 * message with each of its errors.
 */
export const MESSAGES = {
  unauthorized: '未登录或凭据无效',
  csrf_failed: '页面安全令牌已失效，请刷新后重试',
  not_found: '找不到该资源',
  payload_too_large: '请求体超过 1 MiB',
  unsupported_media_type: '只接受 application/json',
  rate_limited: '请求过于频繁，请稍后再试',
  maintenance: '服务维护中，请稍后再试',
  not_configured: '服务缺少必需的密钥配置',
  access_not_configured: 'Cloudflare Access 配置不完整',
  unavailable: '依赖服务暂时不可用，请稍后再试',
} as const;

type ErrorCode = keyof typeof MESSAGES;

/** A gate failure (Access, CSRF) that the owner handler turns into an error envelope. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
  ) {
    super(code);
  }
}

/** Hashed build output under /assets/ never changes, so the browser may keep it. */
const IMMUTABLE = 'private, max-age=31536000, immutable';

export function newRequestId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** JSON text that is already serialised (the core's bodies keep their bytes). */
export function jsonText(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export function jsonResponse(data: unknown, status = 200): Response {
  return jsonText(JSON.stringify(data), status);
}

/**
 * The OpenAPI error envelope for any error, the core's included, so every error is logged here
 * once; only the request ID, status and code are logged.
 */
export function errorEnvelope(
  requestId: string,
  status: number,
  code: string,
  message: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  console.log(JSON.stringify({ request_id: requestId, status, code }));
  const response = jsonResponse({ error: { code, message, request_id: requestId } }, status);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

/** An error the gateway emits on its own. */
export function errorResponse(
  requestId: string,
  status: number,
  code: ErrorCode,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return errorEnvelope(requestId, status, code, MESSAGES[code], headers);
}

/** `content-type` before any parameters, trimmed and lowercased. */
export function mediaType(headers: Headers): string {
  return (headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** Python's `str.partition`: the text before the first separator and the text after it. */
export function partition(text: string, separator: string): [string, string] {
  const index = text.indexOf(separator);
  return index < 0 ? [text, ''] : [text.slice(0, index), text.slice(index + separator.length)];
}

/**
 * Copy a (possibly immutable) response with the owner host's private headers. `asset` marks a
 * response from ASSETS for a path under /assets/: only a 200 that is not the SPA's index.html
 * fallback may be cached.
 */
export function withPrivateHeaders(response: Response, asset = false): Response {
  const cacheable = asset && response.status === 200 && mediaType(response.headers) !== 'text/html';
  return withHeaders(response, cacheable ? { csp: STRICT_CSP, cacheControl: IMMUTABLE } : { csp: STRICT_CSP });
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
