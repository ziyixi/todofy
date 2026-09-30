import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
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

export function apiError(status: number, code: string, message = '错误', requestId = '0123456789abcdef'): Response {
  return json({ error: { code, message, request_id: requestId } }, status)
}

/** Replaces fetch with a recorder; every call must be a same-origin /api/v2 path. */
export function installFetch(handler: Handler): Call[] {
  const calls: Call[] = []
  resetCsrfForTests()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!/^\/api\/v2\//.test(url)) throw new Error(`unexpected request to ${url}`)
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
 * Serves a scenario's v2 GETs (registry, the four views, csrf); anything else goes to `other`
 * (mutations) or answers 404. Each view may be a function, to change between requests.
 */
export function serve(
  scenario: Scenario | (() => Scenario),
  other: Handler = () => apiError(404, 'not_found'),
): Call[] {
  let tokens = 0
  return installFetch((call) => {
    const current = typeof scenario === 'function' ? scenario() : scenario
    const path = call.path.replace(/\?.*$/, '')
    if (call.method === 'GET') {
      if (path === '/api/v2/csrf') {
        tokens += 1
        return json({ token: `token-${tokens}` })
      }
      if (path === '/api/v2/registry') return json(current.registry)
      if (path === '/api/v2/home') return json(current.home)
      if (path === '/api/v2/flows') return json(current.flows)
      if (path === '/api/v2/cloudflare') return json(current.cloudflare)
      if (path === '/api/v2/ops') return json(current.ops)
    }
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
