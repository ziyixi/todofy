import { QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { vi } from 'vitest'
import { resetCsrfForTests } from '../api/client'
import { createQueryClient } from '../queryClient'
import { routes } from '../routes'
import { dailyMetrics, overview } from './fixtures'

export interface Call {
  method: string
  path: string
  search: string
  headers: Record<string, string>
  body: unknown
}

/** A JSON body (200), `{status, body}`, or an Error to make fetch itself fail. */
type Reply = object
type Handler = Reply | ((call: Call) => Reply)

/** The google.rpc.Status the gateway answers an error with: ErrorInfo, LocalizedMessage, RequestInfo, typed details. */
export function apiError(status: number, reason: string, requestId = 'req-test-1', details: object[] = []) {
  return {
    status,
    body: {
      error: {
        code: status,
        message: 'test error',
        status: 'TEST',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'todofy.ziyixi.science' },
          { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'zh-CN', message: '测试错误' },
          { '@type': 'type.googleapis.com/google.rpc.RequestInfo', request_id: requestId },
          ...details,
        ],
      },
    },
  }
}

function isReply(value: unknown): value is { status: number; body?: unknown } {
  return typeof value === 'object' && value !== null && 'status' in value && typeof value.status === 'number'
}

/**
 * Stubs fetch with handlers keyed by "METHOD /api/v1/path" (the decoded path: `mailEvents/<id>:reconcile`). Unmatched
 * requests fail the test loudly. GET /api/csrf, /api/v1/serviceStatus and /api/v1/metricDays have defaults so every
 * page can render.
 */
export function mockApi(handlers: Record<string, Handler>) {
  const calls: Call[] = []
  const table: Record<string, Handler> = {
    'GET /api/csrf': { token: 'csrf-token-1' },
    'GET /api/v1/serviceStatus': overview(),
    'GET /api/v1/metricDays': dailyMetrics(),
    ...handlers,
  }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'https://todofy.example.test')
    const method = init.method ?? 'GET'
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const path = decodeURIComponent(url.pathname)
    const call: Call = { method, path, search: url.search, headers, body: init.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(call)
    const handler = table[`${method} ${path}`]
    if (handler === undefined) throw new Error(`Unexpected request ${method} ${path}`)
    const reply = typeof handler === 'function' ? handler(call) : handler
    if (reply instanceof Error) throw reply
    const { status, body } = isReply(reply) ? reply : { status: 200, body: reply }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  resetCsrfForTests()
  return { calls, fetchMock }
}

export function renderApp(path: string) {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...view, router, client }
}
