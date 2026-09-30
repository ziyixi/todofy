/**
 * The owner API client (docs/design.md §6, §8; v2: docs/design-v2.md §5). Same-origin only: every
 * request goes to /api/v1/* or /api/v2/* with the Access cookie; nothing else leaves the page.
 */
import type {
  ApiErrorCode,
  CanaryStartResponse,
  CsrfResponse,
  GuardLevel,
  GuardResponse,
  OverviewResponse,
} from '../../../worker/src/api-types.ts'
import type {
  CanaryStartRequestV2,
  CloudflareResponse,
  FlowsResponse,
  GuardResponseV2,
  HomeResponse,
  OpsResponse,
  RegistryResponse,
} from '../../../worker/src/api-v2-types.ts'
import { API_ERRORS } from '../lib/labels'

const PREFIX = '/api/v1'
const PREFIX_V2 = '/api/v2'

/** Codes the browser produces itself when no API error envelope is available. */
export type ClientErrorCode = 'network_error' | 'bad_response'

export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode | ClientErrorCode
  readonly requestId: string | null

  constructor(status: number, code: ApiErrorCode | ClientErrorCode, message: string, requestId: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

/** Shown when fetch itself fails: no network, or Access redirected an expired session (redirect: 'error'). */
export const NETWORK_MESSAGE = '无法连接运维面板，或登录已过期，请刷新页面'

let csrfToken: string | null = null

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && Object.hasOwn(API_ERRORS, value)
}

async function readError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown; request_id?: unknown } }
    const error = body.error
    if (error && isApiErrorCode(error.code)) {
      const message = typeof error.message === 'string' && error.message ? error.message : API_ERRORS[error.code]
      const requestId = typeof error.request_id === 'string' ? error.request_id : null
      return new ApiError(response.status, error.code, message, requestId)
    }
  } catch {
    // The Access edge or a proxy may answer with HTML instead of the JSON envelope.
  }
  return new ApiError(response.status, 'bad_response', `服务返回了无法识别的响应（HTTP ${response.status}）`)
}

/** `path` is the full same-origin path (/api/v1/... or /api/v2/...). */
async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    // redirect: 'error' so an expired Access session surfaces as an error, not as the login page's HTML.
    return await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  } catch {
    throw new ApiError(0, 'network_error', NETWORK_MESSAGE)
  }
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T
  } catch {
    throw new ApiError(response.status, 'bad_response', `服务返回了无法识别的响应（HTTP ${response.status}）`)
  }
}

async function csrf(): Promise<string> {
  if (csrfToken) return csrfToken
  const response = await send(`${PREFIX}/csrf`, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw await readError(response)
  const body = await readJson<Partial<CsrfResponse>>(response)
  if (typeof body.token !== 'string' || !body.token) throw new ApiError(response.status, 'bad_response', '无法取得页面安全令牌')
  csrfToken = body.token
  return csrfToken
}

async function get<T>(path: string): Promise<T> {
  const response = await send(`${PREFIX}${path}`, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw await readError(response)
  return readJson<T>(response)
}

/**
 * A mutation with the signed double-submit token. A 403 `csrf_failed` (expired token, lost cookie)
 * drops the token and retries exactly once with a fresh one; any other error is final.
 */
async function post<T>(path: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': await csrf() }
    const response = await send(path, { method: 'POST', headers, body: JSON.stringify(body) })
    if (response.ok) return readJson<T>(response)
    const error = await readError(response)
    if (response.status === 403) csrfToken = null
    if (error.code === 'csrf_failed' && attempt === 0) continue
    throw error
  }
}

export const api = {
  overview: (refresh = false) => get<OverviewResponse>(refresh ? '/overview?refresh=1' : '/overview'),
  startCanary: () => post<CanaryStartResponse>(`${PREFIX}/canary`, {}),
  setGuard: (level: GuardLevel) => post<GuardResponse>(`${PREFIX}/guard`, { level }),
}

/**
 * The last body and ETag of each v2 GET (the responses are `no-store`, so the browser cache never
 * revalidates them): a repeat request sends If-None-Match and a 304 returns the kept body.
 */
const v2Cache = new Map<string, { etag: string; data: unknown }>()

async function getV2<T>(name: string, refresh = false): Promise<T> {
  const cached = v2Cache.get(name)
  const headers: Record<string, string> = { Accept: 'application/json' }
  // A refresh always wants the fresh body (its `refresh.refreshed` flag differs even when rev does not).
  if (cached && !refresh) headers['If-None-Match'] = cached.etag
  const response = await send(`${PREFIX_V2}/${name}${refresh ? '?refresh=1' : ''}`, { headers })
  if (response.status === 304 && cached) return cached.data as T
  if (!response.ok) throw await readError(response)
  const data = await readJson<T>(response)
  const etag = response.headers.get('ETag')
  if (etag) v2Cache.set(name, { etag, data })
  return data
}

/** API v2 (docs/design-v2.md §5). The registry is fetched once per page load (staleTime Infinity). */
export const apiV2 = {
  registry: () => getV2<RegistryResponse>('registry'),
  home: (refresh = false) => getV2<HomeResponse>('home', refresh),
  flows: () => getV2<FlowsResponse>('flows'),
  cloudflare: (refresh = false) => getV2<CloudflareResponse>('cloudflare', refresh),
  ops: () => getV2<OpsResponse>('ops'),
  startCanary: (canaryId: CanaryStartRequestV2['canary_id']) =>
    post<CanaryStartResponse>(`${PREFIX_V2}/canary`, { canary_id: canaryId } satisfies CanaryStartRequestV2),
  setGuard: (level: GuardLevel) => post<GuardResponseV2>(`${PREFIX_V2}/guard`, { level }),
}

/** Test hook: forget the cached CSRF token and the v2 ETags. */
export function resetCsrfForTests(): void {
  csrfToken = null
  v2Cache.clear()
}
