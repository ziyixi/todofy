import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'

export function renderApp(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
  return {
    ...view,
    client,
    rerender: (next: ReactNode) => view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>),
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((success, failure) => {
    resolve = success
    reject = failure
  })
  return { promise, resolve, reject }
}
