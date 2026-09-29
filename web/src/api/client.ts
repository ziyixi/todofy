import type {
  ApiErrorCode,
  EventDetail,
  EventPage,
  EventState,
  EventView,
  LegacyText,
  Overview,
  RecommendationReport,
  ReconcileRequest,
  ReminderPage,
  ReportsLatest,
  RecomputeRequest,
  Setup,
  SummaryReport,
} from './types'

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

let csrfToken: string | null = null

async function readError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: { code?: ApiErrorCode; message?: string; request_id?: string } }
    const error = body.error
    if (error?.code) {
      return new ApiError(response.status, error.code, error.message || `请求失败（HTTP ${response.status}）`, error.request_id ?? null)
    }
  } catch {
    // A proxy or the Access edge may answer with HTML instead of the JSON envelope.
  }
  return new ApiError(response.status, 'bad_response', `服务返回了无法识别的响应（HTTP ${response.status}）`)
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    // redirect: 'error' so an expired Access session surfaces as an error, not as the login page's HTML.
    return await fetch(`${PREFIX}${path}`, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  } catch {
    throw new ApiError(0, 'network_error', '无法连接 Todofy，或登录已过期；请刷新页面后重试')
  }
}

async function csrf(): Promise<string> {
  if (csrfToken) return csrfToken
  const response = await send('/csrf', { headers: { Accept: 'application/json' } })
  if (!response.ok) throw await readError(response)
  const body = (await response.json()) as { token?: string }
  if (!body.token) throw new ApiError(response.status, 'bad_response', '无法取得页面安全令牌')
  csrfToken = body.token
  return csrfToken
}

async function get<T>(path: string): Promise<T> {
  const response = await send(path, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw await readError(response)
  return (await response.json()) as T
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': await csrf() }
  const response = await send(path, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!response.ok) {
    // A 403 means the token expired or the cookie was lost; the next POST fetches a fresh pair.
    if (response.status === 403) csrfToken = null
    throw await readError(response)
  }
  return (await response.json()) as T
}

function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value))
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ''
}

/** A fresh idempotency key for one owner action; reuse it only to resend the identical request. */
export function actionId(): string {
  return crypto.randomUUID()
}

export interface EventQuery {
  view: EventView
  state?: EventState | null
  cursor?: string | null
  limit?: number
}

export const api = {
  overview: () => get<Overview>('/overview'),
  events: ({ view, state, cursor, limit }: EventQuery) =>
    get<EventPage>(`/events${query({ view, state: view === 'recent' ? state : null, cursor, limit })}`),
  event: (id: string) => get<EventDetail>(`/events/${encodeURIComponent(id)}`),
  reconcile: (id: string, body: ReconcileRequest) => post<EventDetail>(`/events/${encodeURIComponent(id)}/reconcile`, body),
  reminders: (cursor: string | null, limit?: number) => get<ReminderPage>(`/reminders${query({ cursor, limit })}`),
  reportsLatest: () => get<ReportsLatest>('/reports/latest'),
  recompute: (body: RecomputeRequest) => post<SummaryReport | RecommendationReport>('/reports/recompute', body),
  legacyText: (id: string) => get<LegacyText>(`/legacy_text/${encodeURIComponent(id)}`),
  setup: () => get<Setup>('/setup'),
}

/** Test hook: forget the cached CSRF token. */
export function resetCsrfForTests(): void {
  csrfToken = null
}
