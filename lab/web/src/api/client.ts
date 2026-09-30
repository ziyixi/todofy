/**
 * The owner API client (docs/design.md §8). Same-origin only: every request goes to /api/* with the Access
 * cookie; nothing else leaves the page. Mutations carry the signed double-submit CSRF token (header
 * X-CSRF-Token, cookie lab_csrf) and an op_id chosen by the caller, so a retried request is answered with
 * the first response.
 */
import {
  API_PREFIX,
  CSRF_HEADER,
  type AddSeedsRequest,
  type CsrfResponse,
  type Day,
  type DecideRequest,
  type Deck,
  type DeckMutationResponse,
  type DeckState,
  type DeckSummary,
  type ExcludeRequest,
  type FeedbackRequest,
  type FeedbackResponse,
  type LaterRequest,
  type LikedResponse,
  type RemoveSeedRequest,
  type RestartRequest,
  type SeedsResponse,
  type SendRequest,
  type SendStatus,
  type SettingsResponse,
  type SettingsUpdateRequest,
  type StatusResponse,
  type TodayResponse,
  type UndoRequest,
} from '../../../worker/src/api-types.ts'

/** Codes the browser produces itself when no API error envelope is available. */
export type ClientErrorCode = 'network_error' | 'bad_response'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string | null
  /** 409 deck_changed carries the deck's current state. */
  readonly state: DeckState | null

  constructor(status: number, code: string, message: string, requestId: string | null = null, state: DeckState | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
    this.state = state
  }

  /** Worth repeating with the same op_id: the request may never have arrived, or the server hiccupped. */
  get transient(): boolean {
    return this.status === 0 || this.status >= 500 || this.code === 'bad_response'
  }
}

/** Shown when fetch itself fails: no network, or Access redirected an expired session (redirect: 'error'). */
export const NETWORK_MESSAGE = '网络异常，或登录已过期，请稍后重试或刷新页面'

const MESSAGES: Readonly<Record<string, string>> = {
  deck_not_found: '找不到这组卡片',
  deck_changed: '已同步其他设备上的选择',
  already_decided: '这张卡片已经在别处选过了',
  nothing_to_undo: '没有可以撤销的操作',
  deck_log_full: '这组卡片的操作次数已达上限',
  not_in_deck: '这篇论文不在这组卡片里',
  nothing_to_send: '没有需要发送的论文',
  send_in_progress: '正在发送中，请稍候',
  csrf_failed: '页面安全令牌已过期，请刷新页面',
  forbidden: '没有权限',
  invalid_input: '输入有误',
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return '出了点问题，请稍后重试'
}

let csrfToken: string | null = null

function isDeckState(value: unknown): value is DeckState {
  return typeof value === 'object' && value !== null && typeof (value as { version?: unknown }).version === 'number'
}

async function readError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown; request_id?: unknown }; state?: unknown }
    const error = body.error
    if (error && typeof error.code === 'string') {
      const known = MESSAGES[error.code]
      const message = known ?? (typeof error.message === 'string' && error.message ? error.message : `请求失败（${error.code}）`)
      const requestId = typeof error.request_id === 'string' ? error.request_id : null
      return new ApiError(response.status, error.code, message, requestId, isDeckState(body.state) ? body.state : null)
    }
  } catch {
    // The Access edge or a proxy may answer with HTML instead of the JSON envelope.
  }
  return new ApiError(response.status, 'bad_response', `服务返回了无法识别的响应（HTTP ${response.status}）`)
}

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

async function get<T>(path: string): Promise<T> {
  const response = await send(`${API_PREFIX}${path}`, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw await readError(response)
  return readJson<T>(response)
}

async function csrf(): Promise<string> {
  if (csrfToken) return csrfToken
  const body = await get<Partial<CsrfResponse>>('/csrf')
  if (typeof body.token !== 'string' || !body.token) throw new ApiError(200, 'bad_response', '无法取得页面安全令牌')
  csrfToken = body.token
  return csrfToken
}

/**
 * A mutation with the CSRF token. A 403 `csrf_failed` (expired token, lost cookie) drops the token and
 * retries exactly once with a fresh one (same body, so the same op_id); any other error is final here.
 */
async function mutate<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json', [CSRF_HEADER]: await csrf() }
    const response = await send(`${API_PREFIX}${path}`, { method, headers, body: JSON.stringify(body) })
    if (response.ok) return readJson<T>(response)
    const error = await readError(response)
    if (response.status === 403) csrfToken = null
    if (error.code === 'csrf_failed' && attempt === 0) continue
    throw error
  }
}

const deckPath = (day: Day) => `/decks/${encodeURIComponent(day)}`

export const api = {
  today: () => get<TodayResponse>('/today'),
  deck: (day: Day) => get<Deck>(deckPath(day)),
  decide: (day: Day, body: DecideRequest) => mutate<DeckMutationResponse>('POST', `${deckPath(day)}/decide`, body),
  undo: (day: Day, body: UndoRequest) => mutate<DeckMutationResponse>('POST', `${deckPath(day)}/undo`, body),
  restart: (day: Day, body: RestartRequest) => mutate<DeckMutationResponse>('POST', `${deckPath(day)}/restart`, body),
  summary: (day: Day) => get<DeckSummary>(`${deckPath(day)}/summary`),
  exclude: (day: Day, body: ExcludeRequest) => mutate<DeckSummary>('POST', `${deckPath(day)}/exclude`, body),
  send: (day: Day, body: SendRequest) => mutate<SendStatus>('POST', `${deckPath(day)}/send`, body),
  sendStatus: (day: Day) => get<SendStatus>(`${deckPath(day)}/send`),
  later: (day: Day, body: LaterRequest) => mutate<unknown>('POST', `${deckPath(day)}/later`, body),
  liked: (query: { cursor?: string | null; q?: string }) => {
    const params = new URLSearchParams()
    if (query.cursor) params.set('cursor', query.cursor)
    if (query.q) params.set('q', query.q)
    const search = params.toString()
    return get<LikedResponse>(`/liked${search ? `?${search}` : ''}`)
  },
  feedback: (body: FeedbackRequest) => mutate<FeedbackResponse>('POST', '/feedback', body),
  seeds: () => get<SeedsResponse>('/seeds'),
  addSeeds: (body: AddSeedsRequest) => mutate<SeedsResponse>('POST', '/seeds', body),
  removeSeed: (body: RemoveSeedRequest) => mutate<SeedsResponse>('DELETE', '/seeds', body),
  settings: () => get<SettingsResponse>('/settings'),
  saveSettings: (body: SettingsUpdateRequest) => mutate<SettingsResponse>('PUT', '/settings', body),
  status: () => get<StatusResponse>('/status'),
}

/**
 * Runs a mutation, repeating it once after a short pause when the failure was transient. The caller passes
 * the same body (same op_id), so a request whose response was lost is answered from the server's op log.
 */
export async function withRetry<T>(run: () => Promise<T>, pauseMs = 800): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof ApiError) || !error.transient) throw error
    await new Promise((resolve) => setTimeout(resolve, pauseMs))
    return run()
  }
}

/** Test hook: forget the cached CSRF token. */
export function resetClientForTests(): void {
  csrfToken = null
}
