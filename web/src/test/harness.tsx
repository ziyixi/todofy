import { QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { vi } from 'vitest'
import { resetCsrfForTests } from '../api/client'
import { createQueryClient } from '../queryClient'
import { routes } from '../routes'
import { overview } from './fixtures'

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

export function apiError(status: number, code: string, requestId = 'req-test-1') {
  return { status, body: { error: { code, message: '测试错误', request_id: requestId } } }
}

function isReply(value: unknown): value is { status: number; body?: unknown } {
  return typeof value === 'object' && value !== null && 'status' in value && typeof value.status === 'number'
}

/**
 * Stubs fetch with handlers keyed by "METHOD /api/v1/path". Unmatched requests fail the test
 * loudly. GET /api/v1/csrf and GET /api/v1/overview have defaults so every page can render.
 */
export function mockApi(handlers: Record<string, Handler>) {
  const calls: Call[] = []
  const table: Record<string, Handler> = {
    'GET /api/v1/csrf': { token: 'csrf-token-1' },
    'GET /api/v1/overview': overview(),
    ...handlers,
  }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'https://todofy.example.test')
    const method = init.method ?? 'GET'
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const call: Call = { method, path: url.pathname, search: url.search, headers, body: init.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(call)
    const handler = table[`${method} ${url.pathname}`]
    if (handler === undefined) throw new Error(`Unexpected request ${method} ${url.pathname}`)
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
