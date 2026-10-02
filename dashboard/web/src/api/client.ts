/**
 * The owner API client (proto/dashboard/ui/v1, docs/design-v2.md §5): DashboardUiService through the shared typed
 * client (proto/ts/http-client.ts), built from the same descriptors the Worker's transcoder routes with. Same-origin
 * only: every request goes to /api/v1/* or /api/csrf with the Access cookie; nothing else leaves the page.
 *
 * This file adds the transport and turns each answer into the wire JSON the pages render:
 *
 * - mutations (every POST, the refreshes included) carry the signed double-submit CSRF token (header X-CSRF-Token,
 *   cookie home_csrf, from GET /api/csrf); a refused token is renewed once (same body, so the same request_id);
 * - the views are `no-store`, so the transport keeps each view's last body and ETag itself: a repeat GET sends
 *   If-None-Match and a 304 returns the kept body; a refresh's answer replaces the kept view;
 * - the client reads every answer leniently (proto/README.md, HTTP APIs) and this file writes it back as the
 *   generated wire type (`toWire`), the JSON HomeState serialized, which the pages read;
 * - every failure becomes an ApiError with the copy the owner reads: the server's LocalizedMessage, else
 *   API_ERRORS, keyed by the ErrorInfo reason in lower case (`canary_active`).
 */
import type { CommonReason } from '@ziyixi/proto/common/errors/v1/errors_pb'
import { CloudflareViewSchema } from '@ziyixi/proto/dashboard/ui/v1/cloudflare_view_pb'
import { DashboardUiService, OverrideGuardResponseSchema, RunCanaryResponseSchema } from '@ziyixi/proto/dashboard/ui/v1/dashboard_ui_service_pb'
import type { ErrorReason } from '@ziyixi/proto/dashboard/ui/v1/errors_pb'
import { FlowsViewSchema } from '@ziyixi/proto/dashboard/ui/v1/flows_view_pb'
import { HomeViewSchema } from '@ziyixi/proto/dashboard/ui/v1/home_view_pb'
import { OpsViewSchema } from '@ziyixi/proto/dashboard/ui/v1/ops_view_pb'
import { RegistrySchema } from '@ziyixi/proto/dashboard/ui/v1/registry_pb'
import { createHttpClient, HttpEncodeError, HttpResponseError, RpcStatusError, type HttpCall } from '@ziyixi/proto/http-client'
import { GuardLevel as GuardLevelValue } from '@ziyixi/proto/ops/v1/ops_pb'
import type { DescMessage, MessageShape } from '@ziyixi/proto/protobuf'
import { parseStatus } from '@ziyixi/proto/rpc-status'
import { toWire, WireJsonError, type WireOf } from '@ziyixi/proto/wire-json'
import type {
  CloudflareView,
  CsrfResponse,
  FlowsView,
  GuardLevel,
  HomeView,
  OpsView,
  OverrideGuardResponse,
  Registry,
  RunCanaryResponse,
} from '../../../worker/src/api-types.ts'
import { API_ERRORS } from '../lib/labels'

export const CSRF_HEADER = 'X-CSRF-Token'

/** An ErrorInfo reason the dashboard answers (dashboard.ui.v1's own or a CommonReason), in lower case. */
export type ApiErrorCode = Lowercase<Exclude<keyof typeof ErrorReason | keyof typeof CommonReason, 'UNSPECIFIED'>>
/** Codes the browser produces itself when no google.rpc.Status is available. */
export type ClientErrorCode = 'network_error' | 'bad_response'

export class ApiError extends Error {
  readonly status: number
  /** The reason in lower case; a reason this build does not know stays as sent (lower-cased). */
  readonly code: ApiErrorCode | ClientErrorCode | (string & {})
  readonly requestId: string | null

  constructor(status: number, code: ApiErrorCode | ClientErrorCode | (string & {}), message: string, requestId: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

/** Shown when fetch itself fails: no network, or Access redirected an expired session (redirect: 'error'). */
export const NETWORK_MESSAGE = '无法连接个人控制台，或登录已过期，请刷新页面'

function unreadable(status: number): ApiError {
  return new ApiError(status, 'bad_response', `服务返回了无法识别的响应（HTTP ${status}）`)
}

function isKnownCode(code: string): code is ApiErrorCode {
  return Object.hasOwn(API_ERRORS, code)
}

/** Any failure of a call as an ApiError. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof RpcStatusError) {
    const { status } = error
    if (status.reason === undefined) return unreadable(status.httpStatus)
    const code = status.reason.toLowerCase()
    const message = status.localizedMessage?.message || (isKnownCode(code) ? API_ERRORS[code] : `请求失败（${status.reason}）`)
    return new ApiError(status.httpStatus, code, message, status.requestId ?? null)
  }
  // Nothing was sent: the same input fails the same way, so it is a 400, never a network failure to retry.
  if (error instanceof HttpEncodeError) return new ApiError(400, 'bad_request', API_ERRORS.bad_request)
  if (error instanceof HttpResponseError) return unreadable(error.httpStatus)
  // An answer this build cannot write as its wire type (a value of a newer Worker): the page is out of date.
  if (error instanceof WireJsonError) return new ApiError(200, 'bad_response', '个人控制台已更新，请刷新页面')
  return unreadable(0)
}

let csrfToken: string | null = null

async function fetchSameOrigin(url: string, init: RequestInit): Promise<Response> {
  try {
    // redirect: 'error' so an expired Access session surfaces as an error, not as the login page's HTML.
    return await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  } catch {
    throw new ApiError(0, 'network_error', NETWORK_MESSAGE)
  }
}

async function csrf(): Promise<string> {
  if (csrfToken) return csrfToken
  const response = await fetchSameOrigin('/api/csrf', { headers: { Accept: 'application/json' } })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // Not JSON: an error page from a proxy or Access.
  }
  const token = response.ok ? (body as Partial<CsrfResponse> | undefined)?.token : undefined
  if (typeof token !== 'string' || token === '') {
    // The Worker answers a google.rpc.Status (an expired login, a missing key): its reason and copy.
    const status = response.ok ? null : parseStatus(response.status, body)
    throw status === null ? new ApiError(response.status, 'bad_response', '无法取得页面安全令牌') : toApiError(new RpcStatusError(status))
  }
  csrfToken = token
  return csrfToken
}

/**
 * The last body and ETag of each view (the answers are `no-store`, so the browser cache never revalidates them),
 * keyed by the view's GET path: a refresh's answer (`<view>:refresh`) replaces its view's.
 */
const viewCache = new Map<string, { etag: string; text: string }>()

function viewKey(url: string): string {
  return url.replace(/:refresh$/, '')
}

/** A 200 answer with the kept body, for a 304 (the client reads the body like any answer). */
function keptAnswer(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

/**
 * The transport of every call. A GET of a kept view is conditional; a mutation carries the CSRF token, and a 403
 * CSRF_FAILED (expired token, lost cookie) drops the token and sends once more with a fresh one (same body).
 */
async function send(call: HttpCall): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (call.body !== undefined) headers['Content-Type'] = 'application/json'
    const kept = call.httpMethod === 'GET' ? viewCache.get(call.url) : undefined
    if (kept !== undefined) headers['If-None-Match'] = kept.etag
    if (call.httpMethod !== 'GET') headers[CSRF_HEADER] = await csrf()
    const response = await fetchSameOrigin(call.url, { method: call.httpMethod, headers, ...(call.body === undefined ? {} : { body: call.body }) })
    if (response.status === 304 && kept !== undefined) return keptAnswer(kept.text)
    const etag = response.headers.get('ETag')
    if (response.ok && etag !== null) {
      const text = await response.text()
      viewCache.set(viewKey(call.url), { etag, text })
      return keptAnswer(text)
    }
    if (response.status !== 403 || call.httpMethod === 'GET') return response
    csrfToken = null
    if (attempt > 0) return response
    let reason: string | undefined
    try {
      reason = parseStatus(403, await response.clone().json())?.reason
    } catch {
      // Not a Status: answer it as it is.
    }
    if (reason !== 'CSRF_FAILED') return response
  }
}

const client = createHttpClient(DashboardUiService, send)

/** Runs a call and writes its answer as the wire JSON the pages render; every failure is an ApiError. */
async function wire<D extends DescMessage>(schema: D, run: () => Promise<MessageShape<D>>): Promise<WireOf<D>> {
  try {
    // lenient: a newer Worker's values this build reads as unknown are written as the profile allows.
    return toWire(schema, await run(), { lenient: true })
  } catch (error) {
    throw toApiError(error)
  }
}

const GUARD_LEVELS: Readonly<Record<GuardLevel, GuardLevelValue>> = { normal: GuardLevelValue.NORMAL, shed: GuardLevelValue.SHED }

/** A request_id (AIP-155) for one user action: a repeat of the same request is answered with the first answer. */
export function newRequestId(): string {
  return crypto.randomUUID()
}

/** DashboardUiService for the pages (docs/design-v2.md §5). The registry is fetched once per page load. */
export const api = {
  registry: (): Promise<Registry> => wire(RegistrySchema, () => client.getRegistry({ name: 'registry' })),
  home: (): Promise<HomeView> => wire(HomeViewSchema, () => client.getHomeView({ name: 'homeView' })),
  flows: (): Promise<FlowsView> => wire(FlowsViewSchema, () => client.getFlowsView({ name: 'flowsView' })),
  cloudflare: (): Promise<CloudflareView> => wire(CloudflareViewSchema, () => client.getCloudflareView({ name: 'cloudflareView' })),
  ops: (): Promise<OpsView> => wire(OpsViewSchema, () => client.getOpsView({ name: 'opsView' })),
  /** Polls the due app statuses and probes (each scope at most once a minute), then answers the home view. */
  refreshHome: (): Promise<HomeView> => wire(HomeViewSchema, () => client.refreshHomeView({ name: 'homeView' })),
  /** Reads the GraphQL usage again (at most once a minute), then answers the Cloudflare view. */
  refreshCloudflare: (): Promise<CloudflareView> => wire(CloudflareViewSchema, () => client.refreshCloudflareView({ name: 'cloudflareView' })),
  startCanary: (canaryId: string, requestId: string = newRequestId()): Promise<RunCanaryResponse> =>
    wire(RunCanaryResponseSchema, () => client.runCanary({ name: `canaries/${canaryId}`, requestId })),
  setGuard: (level: GuardLevel, requestId: string = newRequestId()): Promise<OverrideGuardResponse> =>
    wire(OverrideGuardResponseSchema, () => client.overrideGuard({ name: 'guard', level: GUARD_LEVELS[level], requestId })),
}

/** Test hook: forget the cached CSRF token and the views' ETags. */
export function resetCsrfForTests(): void {
  csrfToken = null
  viewCache.clear()
}
