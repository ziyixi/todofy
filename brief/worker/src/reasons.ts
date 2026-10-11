/**
 * The error reasons of the owner API (proto/brief/ui/v1/errors.proto and common/errors/v1): each reason's
 * google.rpc.Code, its developer message and its user-facing copy (the LocalizedMessage). Shared by the Worker's front
 * (authentication, CSRF: http.ts) and BriefState's transcoder (api.ts). Exhaustive: a new ErrorReason fails the
 * typecheck until it is mapped here.
 */
import type { ErrorReason } from '@ziyixi/proto/brief/ui/v1/errors_pb';
import type { CommonReason } from '@ziyixi/proto/common/errors/v1/errors_pb';
import { Code, RpcError, statusBody } from '@ziyixi/proto/rpc-status';

/** ErrorInfo.domain: the API's name (BriefUiService's default_host). */
export const API_DOMAIN = 'brief.ziyixi.science';

export type Reason = Exclude<keyof typeof ErrorReason | keyof typeof CommonReason, 'UNSPECIFIED'>;

export const REASONS: Readonly<Record<Reason, { readonly code: Code; readonly message: string; readonly zh: string }>> = {
  UNAUTHORIZED: { code: Code.UNAUTHENTICATED, message: 'no valid Cloudflare Access login for the owner', zh: '未登录或凭据无效' },
  ACCESS_NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'the Access settings are incomplete', zh: 'Cloudflare Access 配置不完整' },
  NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'a required secret is missing', zh: '服务缺少必需的密钥配置' },
  CSRF_FAILED: { code: Code.PERMISSION_DENIED, message: 'the CSRF token or Origin is not valid', zh: '页面安全令牌已失效，请刷新后重试' },
  BAD_REQUEST: { code: Code.INVALID_ARGUMENT, message: 'the request is not valid', zh: '请求内容不正确' },
  NOT_FOUND: { code: Code.NOT_FOUND, message: 'no such resource', zh: '找不到这一项' },
  METHOD_NOT_ALLOWED: { code: Code.UNIMPLEMENTED, message: 'this method is not allowed on this path', zh: '不支持该请求方法' },
  UNAVAILABLE: { code: Code.UNAVAILABLE, message: 'the service is unavailable; repeat the request', zh: '服务暂时不可用，请稍后再试' },
  INTERNAL: { code: Code.INTERNAL, message: 'internal error', zh: '服务出错了，请稍后刷新页面' },
  ETAG_MISMATCH: { code: Code.ABORTED, message: 'the resource changed since the etag', zh: '设置已在别处修改，已载入最新内容' },
  INVALID_SETTINGS: { code: Code.INVALID_ARGUMENT, message: 'a setting is outside its range', zh: '每月预算须在 5 到 100 美元之间' },
};

export function isReason(value: string): value is Reason {
  return Object.hasOwn(REASONS, value);
}

/** An RpcError of `reason`, with typed details (the current resource of an ETAG_MISMATCH). */
export function briefError(reason: Reason, details: RpcError['details'] = [], message?: string): RpcError {
  const entry = REASONS[reason];
  return new RpcError(entry.code, reason, message ?? entry.message, { details });
}

/** The LocalizedMessage of a reason. */
export function localize(reason: string): { locale: string; message: string } | undefined {
  return isReason(reason) ? { locale: 'zh-CN', message: REASONS[reason].zh } : undefined;
}

/** A Status response for the Worker's own refusals (before BriefState's transcoder). */
export function errorResponse(error: RpcError, requestId: string, head = false): Response {
  const body = statusBody(error, { domain: API_DOMAIN, requestId, localized: localize(error.reason) });
  const response = new Response(head ? null : JSON.stringify(body), {
    status: error.httpStatus,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
  for (const [name, value] of Object.entries(error.headers)) response.headers.set(name, value);
  return response;
}
