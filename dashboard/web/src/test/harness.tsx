import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import { App } from '../App'
import { resetCsrfForTests } from '../api/client'
import { NOW } from './fixtures'

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

/** Replaces fetch with a recorder; every call must be a same-origin /api/v1 path. */
export function installFetch(handler: Handler): Call[] {
  const calls: Call[] = []
  resetCsrfForTests()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith('/api/v1/')) throw new Error(`unexpected request to ${url}`)
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

export function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  )
}
