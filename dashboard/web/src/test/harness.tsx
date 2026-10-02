import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { Code, RpcError, statusBody } from '@ziyixi/proto/rpc-status'
import { vi } from 'vitest'
import { App } from '../App'
import { resetCsrfForTests } from '../api/client'
import { NOW, type Scenario } from './fixtures'

export interface Call {
  method: string
  path: string
  headers: Record<string, string>
  body: string | null
  init: RequestInit
}

export type Handler = (call: Call) => Response | Promise<Response>

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

/** The google.rpc.Code of an HTTP status the Worker answers (AIP-193). */
const CODES: Readonly<Record<number, Code>> = {
  400: Code.INVALID_ARGUMENT,
  401: Code.UNAUTHENTICATED,
  403: Code.PERMISSION_DENIED,
  404: Code.NOT_FOUND,
  405: Code.UNIMPLEMENTED,
  409: Code.ABORTED,
  429: Code.RESOURCE_EXHAUSTED,
  500: Code.INTERNAL,
  503: Code.UNAVAILABLE,
}

/**
 * A google.rpc.Status answer as the Worker writes it (proto/dashboard/ui/v1/errors.proto): `code` is the ErrorInfo
 * reason in lower case (`canary_limit`), `message` the LocalizedMessage.
 */
export function apiError(status: number, code: string, message = '错误', requestId = '0123456789abcdef'): Response {
  const error = new RpcError(CODES[status] ?? Code.UNKNOWN, code.toUpperCase(), 'synthetic', { httpStatus: status })
  return json(statusBody(error, { domain: 'home.ziyixi.science', requestId, localized: { locale: 'zh-CN', message } }), status)
}

/** The owner API's paths (DashboardUiService and the transport's CSRF route). */
export const PATHS = {
  registry: '/api/v1/registry',
  home: '/api/v1/homeView',
  flows: '/api/v1/flowsView',
  cloudflare: '/api/v1/cloudflareView',
  ops: '/api/v1/opsView',
  refreshHome: '/api/v1/homeView:refresh',
  refreshCloudflare: '/api/v1/cloudflareView:refresh',
  guard: '/api/v1/guard:override',
  canary: '/api/v1/canaries/mail-todofy:run',
  csrf: '/api/csrf',
} as const

/** Replaces fetch with a recorder; every call must be a same-origin path of the owner API or /api/csrf. */
export function installFetch(handler: Handler): Call[] {
  const calls: Call[] = []
  resetCsrfForTests()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!/^\/api\/v1\//.test(url) && url !== PATHS.csrf) throw new Error(`unexpected request to ${url}`)
      const headers: Record<string, string> = {}
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value
      })
      const call: Call = {
        method: init.method ?? 'GET',
        path: url,
        headers,
        body: typeof init.body === 'string' ? init.body : null,
        init,
      }
      calls.push(call)
      return handler(call)
    }),
  )
  return calls
}

/** Freezes only Date (timers stay real so React Query and user-event work). */
export function freezeClock(at: Date = NOW): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(at)
}

/**
 * Serves a scenario's GETs (registry, the four views, csrf); anything else goes to `other` (mutations, the
 * refreshes) or answers NOT_FOUND. Each view may be a function, to change between requests.
 */
export function serve(
  scenario: Scenario | ((call: Call) => Scenario),
  other: Handler = () => apiError(404, 'not_found'),
): Call[] {
  let tokens = 0
  return installFetch((call) => {
    const current = typeof scenario === 'function' ? scenario(call) : scenario
    const path = call.path.replace(/\?.*$/, '')
    if (call.method === 'GET') {
      if (path === PATHS.csrf) {
        tokens += 1
        return json({ token: `token-${tokens}` })
      }
      if (path === PATHS.registry) return json(current.registry)
      if (path === PATHS.home) return json(current.home)
      if (path === PATHS.flows) return json(current.flows)
      if (path === PATHS.cloudflare) return json(current.cloudflare)
      if (path === PATHS.ops) return json(current.ops)
    }
    // The refreshes answer their view (a test that checks the refresh itself serves it through `other`).
    if (call.method === 'POST' && path === PATHS.refreshHome) return json(current.home)
    if (call.method === 'POST' && path === PATHS.refreshCloudflare) return json(current.cloudflare)
    return other(call)
  })
}

/** Renders the page at `hash` (the router reads window.location.hash). */
export function renderApp(hash = '') {
  window.history.replaceState(null, '', hash === '' ? window.location.pathname : hash)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  )
}
