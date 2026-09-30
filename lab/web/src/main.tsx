import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/tokens.css'
import './styles/app.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

// One owner, one small database: no background retries of failing reads, and a deck re-read on focus
// picks up choices made on another device.
const client = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 10_000 }, mutations: { retry: false } } })

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
