/**
 * The owner API client (docs/design.md §6, §8). Same-origin only: every request goes to /api/v1/* with
 * the Access cookie; nothing else leaves the page.
 */
import type {
  ApiErrorCode,
  CanaryStartResponse,
  CsrfResponse,
  GuardLevel,
  GuardResponse,
  OverviewResponse,
} from '../../../worker/src/api-types.ts'
import { API_ERRORS } from '../lib/labels'

const PREFIX = '/api/v1'

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

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    // redirect: 'error' so an expired Access session surfaces as an error, not as the login page's HTML.
    return await fetch(`${PREFIX}${path}`, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
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
  const response = await send('/csrf', { headers: { Accept: 'application/json' } })
  if (!response.ok) throw await readError(response)
  const body = await readJson<Partial<CsrfResponse>>(response)
  if (typeof body.token !== 'string' || !body.token) throw new ApiError(response.status, 'bad_response', '无法取得页面安全令牌')
  csrfToken = body.token
  return csrfToken
}

async function get<T>(path: string): Promise<T> {
  const response = await send(path, { headers: { Accept: 'application/json' } })
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
  startCanary: () => post<CanaryStartResponse>('/canary', {}),
  setGuard: (level: GuardLevel) => post<GuardResponse>('/guard', { level }),
}

/** Test hook: forget the cached CSRF token. */
export function resetCsrfForTests(): void {
  csrfToken = null
}
