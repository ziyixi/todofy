import type { Attempt, Delivery, Endpoint, MessageDetail, MessageSummary, Overview, Page, RetentionPreview, Settings, SetupStatus } from './types'

const prefix = '/api/v1'
let csrfToken: string | null = null

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) {
    super(message)
    this.name = 'ApiError'
  }
}

function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value))
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ''
}

async function readError(response: Response): Promise<ApiError> {
  let code = 'request_failed'
  let message = `请求失败（HTTP ${response.status}）`
  let requestId: string | undefined
  try {
    const body = await response.json() as { error?: { code?: string; message?: string; request_id?: string } }
    code = body.error?.code || code
    message = body.error?.message || message
    requestId = body.error?.request_id
  } catch { /* A proxy may return non-JSON. */ }
  return new ApiError(response.status, code, message, requestId)
}

async function getCSRF(): Promise<string> {
  if (csrfToken) return csrfToken
  const response = await fetch(`${prefix}/csrf`, { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) throw await readError(response)
  const body = await response.json() as { token: string }
  if (!body.token) throw new ApiError(500, 'csrf_unavailable', '无法取得表单安全令牌')
  csrfToken = body.token
  return csrfToken
}

export async function request<T>(path: string, options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {}): Promise<T> {
  const method = options.method || 'GET'
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'
    headers['X-CSRF-Token'] = await getCSRF()
  }
  let response: Response
  try {
    response = await fetch(`${prefix}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    })
  } catch {
    throw new ApiError(0, 'network_error', '无法连接 Mail Hero，请检查网络后重试')
  }
  if (!response.ok) {
    if (response.status === 403) csrfToken = null
    throw await readError(response)
  }
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

export function actionId(): string { return crypto.randomUUID() }
export function apiDownload(path: string): string { return `${prefix}${path}` }

export const api = {
  overview: async (): Promise<Overview> => {
    const raw = await request<{ receive_address?: string; counts?: { messages?: number; pending?: number; failed?: number; delivered?: number }; storage?: { logical_bytes?: number; limit_bytes?: number }; backup?: { last_at?: string | null }; warnings?: string[] }>('/overview')
    return { receive_address: raw.receive_address, message_count: raw.counts?.messages, pending_count: raw.counts?.pending, failed_count: raw.counts?.failed, delivered_count: raw.counts?.delivered, storage_bytes: raw.storage?.logical_bytes, capacity_bytes: raw.storage?.limit_bytes, last_backup_at: raw.backup?.last_at, warnings: raw.warnings }
  },
  setup: () => request<SetupStatus>('/setup/status'),
  settings: () => request<Settings>('/settings'),
  updateSettings: (body: Partial<Settings> & { version: number; retention_confirmation?: string }) => request<Settings>('/settings', { method: 'PATCH', body }),
  retentionPreview: (days: number) => request<RetentionPreview>(`/settings/retention-preview${query({ days })}`),
  messages: (params: Record<string, string | number | boolean | null | undefined>) => request<Page<MessageSummary>>(`/messages${query(params)}`),
  message: (id: string) => request<{ message: MessageDetail; deliveries: Delivery[] }>(`/messages/${encodeURIComponent(id)}`),
  markRead: (id: string, version: number, read: boolean) => request<{ read_at: string | null; version: number }>(`/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body: { read, version } }),
  sendMessage: (id: string, endpointId: string, requestId = actionId()) => request<Delivery>(`/messages/${encodeURIComponent(id)}/send`, { method: 'POST', body: { endpoint_id: endpointId, action_request_id: requestId } }),
  reparse: (id: string, requestId = actionId()) => request<void>(`/messages/${encodeURIComponent(id)}/reparse`, { method: 'POST', body: { action_request_id: requestId } }),
  deleteContent: (id: string, version: number, requestId = actionId()) => request<void>(`/messages/${encodeURIComponent(id)}/content`, { method: 'DELETE', body: { version, action_request_id: requestId } }),
  deliveries: (params: Record<string, string | number | boolean | null | undefined>) => request<Page<Delivery>>(`/deliveries${query(params)}`),
  delivery: async (id: string): Promise<{ delivery: Delivery; attempts: Attempt[] }> => {
    const raw = await request<{ delivery: Delivery; attempts: Attempt[]; payload?: unknown }>(`/deliveries/${encodeURIComponent(id)}`)
    return { delivery: { ...raw.delivery, payload: raw.payload, paused: raw.delivery.effective_state === 'paused' }, attempts: raw.attempts }
  },
  retryDelivery: (id: string, requestId = actionId()) => request<Delivery>(`/deliveries/${encodeURIComponent(id)}/retry`, { method: 'POST', body: { action_request_id: requestId } }),
  cancelDelivery: (id: string, requestId = actionId()) => request<Delivery>(`/deliveries/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { action_request_id: requestId } }),
  replayDelivery: (id: string, endpointId: string, messageVersion: number, requestId = actionId()) => request<Delivery>(`/deliveries/${encodeURIComponent(id)}/replay`, { method: 'POST', body: { endpoint_id: endpointId, message_version: messageVersion, action_request_id: requestId } }),
  endpoints: () => request<{ items: Endpoint[] }>('/endpoints'),
  createEndpoint: (body: Record<string, unknown>) => request<Endpoint>('/endpoints', { method: 'POST', body: { action_request_id: actionId(), ...body } }),
  updateEndpoint: (id: string, body: Record<string, unknown>) => request<Endpoint>(`/endpoints/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  rotateCredential: (id: string, body: { credential: string; version: number }) => request<{ affected_revisions: number; version: number }>(`/endpoints/${encodeURIComponent(id)}/rotate-credential`, { method: 'POST', body }),
  checkEndpoint: (id: string) => request<{ url_valid: boolean; dns_status: string; tls_status: string; business_contract?: string }>(`/endpoints/${encodeURIComponent(id)}/check`, { method: 'POST', body: {} }),
  testEndpoint: (id: string, requestId = actionId()) => request<{ event_id: string; synthetic_test: true; warning?: string }>(`/endpoints/${encodeURIComponent(id)}/test`, { method: 'POST', body: { action_request_id: requestId } }),
}
