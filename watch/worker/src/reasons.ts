/**
 * The error reasons of the owner API (proto/watch/ui/v1/errors.proto and common/errors/v1): each reason's
 * google.rpc.Code, its developer message and its user-facing copy (the LocalizedMessage). Shared by the Worker's
 * front (authentication, CSRF: http.ts) and WatchState's transcoder (api.ts). Exhaustive: a new ErrorReason fails the
 * typecheck until it is mapped here.
 */
import type { CommonReason } from '@ziyixi/proto/common/errors/v1/errors_pb';
import { Code, errorDetail, RpcError, statusBody } from '@ziyixi/proto/rpc-status';
import type { ErrorReason } from '@ziyixi/proto/watch/ui/v1/errors_pb';
import { WatchSchema, type Watch } from '@ziyixi/proto/watch/ui/v1/watch_pb';

/** ErrorInfo.domain: the API's name (WatchUiService's default_host). */
export const API_DOMAIN = 'watch.ziyixi.science';

export type Reason = Exclude<keyof typeof ErrorReason | keyof typeof CommonReason, 'UNSPECIFIED'>;

export const REASONS: Readonly<Record<Reason, { readonly code: Code; readonly message: string; readonly zh: string }>> = {
  UNAUTHORIZED: { code: Code.UNAUTHENTICATED, message: 'no valid Cloudflare Access login for the owner', zh: '未登录或凭据无效' },
  ACCESS_NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'the Access settings are incomplete', zh: 'Cloudflare Access 配置不完整' },
  NOT_CONFIGURED: { code: Code.UNAVAILABLE, message: 'a required secret is missing', zh: '服务缺少必需的密钥配置' },
  CSRF_FAILED: { code: Code.PERMISSION_DENIED, message: 'the CSRF token or Origin is not valid', zh: '页面安全令牌已失效，请刷新后重试' },
  BAD_REQUEST: { code: Code.INVALID_ARGUMENT, message: 'the request is not valid', zh: '请求内容不正确' },
  NOT_FOUND: { code: Code.NOT_FOUND, message: 'no such resource', zh: '找不到这个监视或变化' },
  METHOD_NOT_ALLOWED: { code: Code.UNIMPLEMENTED, message: 'this method is not allowed on this path', zh: '不支持该请求方法' },
  UNAVAILABLE: { code: Code.UNAVAILABLE, message: 'the service is unavailable; repeat the request', zh: '服务暂时不可用，请稍后再试' },
  INTERNAL: { code: Code.INTERNAL, message: 'internal error', zh: '服务出错了，请稍后刷新页面' },
  WATCH_EXISTS: { code: Code.ALREADY_EXISTS, message: 'a watch holds this ID', zh: '这个 ID 已被另一个监视使用' },
  ETAG_MISMATCH: { code: Code.ABORTED, message: 'the watch changed since the etag', zh: '这个监视已在别处修改' },
  INVALID_WATCH_ID: { code: Code.INVALID_ARGUMENT, message: 'not a valid watch ID', zh: 'ID 只能用小写字母、数字和连字符，以字母开头，最多 40 个字符' },
  INVALID_URI: { code: Code.INVALID_ARGUMENT, message: 'not a URI a watch may fetch', zh: '网址必须是 https 网址（不含用户名、密码和端口，不能是 IP 地址或本站域名）' },
  INVALID_SELECTOR: { code: Code.INVALID_ARGUMENT, message: 'a selector HTMLRewriter does not support', zh: '选择器不受支持（最多 10 个，每个最多 200 个字符）' },
  INVALID_SOURCE: { code: Code.INVALID_ARGUMENT, message: 'more than one source kind, or a JSONPath outside the subset', zh: '数据来源设置不正确（JSONPath 只支持 $.a、[0]、[*]）' },
  INVALID_TRIGGER: { code: Code.INVALID_ARGUMENT, message: 'more than one trigger kind, or a trigger value breaks its rules', zh: '触发条件设置不正确' },
  INVALID_INTERVAL: { code: Code.INVALID_ARGUMENT, message: 'check_interval_minutes is outside its range', zh: '检查间隔超出范围（网页 1 小时到 7 天，浏览器 6 小时到 7 天）' },
  WATCHES_FULL: { code: Code.FAILED_PRECONDITION, message: 'the store holds the most watches it may', zh: '监视数量已达上限（50 个）' },
  AI_NOT_AVAILABLE: { code: Code.FAILED_PRECONDITION, message: 'the AI judge is not part of v1', zh: 'AI 判断尚未开放' },
  BROWSER_NOT_AVAILABLE: { code: Code.FAILED_PRECONDITION, message: 'the deployment has no browser binding', zh: '浏览器抓取尚未开放' },
};

export function isReason(value: string): value is Reason {
  return Object.hasOwn(REASONS, value);
}

/** An RpcError of `reason`, with the current watch as a detail (ETAG_MISMATCH, WATCH_EXISTS). */
export function watchError(reason: Reason, current?: Watch): RpcError {
  const { code, message } = REASONS[reason];
  return new RpcError(code, reason, message, { details: current === undefined ? [] : [errorDetail(WatchSchema, current)] });
}

/** The LocalizedMessage of a reason. */
export function localize(reason: string): { locale: string; message: string } | undefined {
  return isReason(reason) ? { locale: 'zh-CN', message: REASONS[reason].zh } : undefined;
}

/** A Status response for the Worker's own refusals (before WatchState's transcoder). */
export function errorResponse(error: RpcError, requestId: string, head = false): Response {
  const body = statusBody(error, { domain: API_DOMAIN, requestId, localized: localize(error.reason) });
  const response = new Response(head ? null : JSON.stringify(body), {
    status: error.httpStatus,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
  for (const [name, value] of Object.entries(error.headers)) response.headers.set(name, value);
  return response;
}
