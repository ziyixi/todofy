/**
 * Synthetic owner-API messages for the UI tests (never real mail): each builder fills what every page reads and takes
 * the fields a test cares about, and `renderAt` renders a page with a fresh query client at a route.
 */
import type { ReactElement } from 'react'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { create, type MessageInitShape } from '@ziyixi/proto/protobuf'
import { DeliverySchema, Delivery_State } from '@ziyixi/proto/mailhero/ui/v2/delivery_pb'
import { Endpoint_AuthType, EndpointSchema } from '@ziyixi/proto/mailhero/ui/v2/endpoint_pb'
import { MessageContentSchema, MessageSchema, Message_DeliveryState, Message_ParseState, ReceiveMode } from '@ziyixi/proto/mailhero/ui/v2/message_pb'
import { OverviewSchema, SettingsSchema } from '@ziyixi/proto/mailhero/ui/v2/settings_pb'
import { timestamp } from '../api/client'

export const MESSAGE_ID = '0b6b4c3e-1111-4222-8333-444455556666'
export const EVENT_ID = '7d1c2b3a-5555-4666-8777-888899990000'
export const ENDPOINT_ID = '3a2b1c0d-9999-4888-9777-666655554444'

export const message = (fields: MessageInitShape<typeof MessageSchema> = {}) => create(MessageSchema, {
  name: `messages/${MESSAGE_ID}`, subject: 'Synthetic subject', sender: 'sender@example.test', receiveTime: timestamp('2026-09-26T00:00:00Z'),
  parseState: Message_ParseState.READY, deliveryState: Message_DeliveryState.UNARRANGED, rawDownloadUri: `/api/v2/messages/${MESSAGE_ID}/raw`, etag: '1', ...fields,
})
export const content = (fields: MessageInitShape<typeof MessageContentSchema> = {}) => create(MessageContentSchema, { name: `messages/${MESSAGE_ID}/content`, ...fields })
export const delivery = (fields: MessageInitShape<typeof DeliverySchema> = {}) => create(DeliverySchema, {
  name: `deliveries/${EVENT_ID}`, message: `messages/${MESSAGE_ID}`, endpoint: `endpoints/${ENDPOINT_ID}`, endpointDisplayName: 'Synthetic consumer',
  state: Delivery_State.DELIVERED, effectiveState: Delivery_State.DELIVERED, attemptCount: 1, createTime: timestamp('2026-09-29T00:00:00Z'), ...fields,
})
export const endpoint = (fields: MessageInitShape<typeof EndpointSchema> = {}) => create(EndpointSchema, {
  name: `endpoints/${ENDPOINT_ID}`, displayName: 'Synthetic consumer', uri: 'https://consumer.example.test/hooks/mail', authType: Endpoint_AuthType.BEARER,
  credentialConfigured: true, ratePerMinute: 2, timeoutSeconds: 20, etag: '4', ...fields,
})
export const settings = (fields: MessageInitShape<typeof SettingsSchema> = {}) => create(SettingsSchema, {
  name: 'settings', receiveAddress: 'hero@example.test', mode: ReceiveMode.FORWARD, rawRetentionDays: 7, contentRetentionDays: 30, ledgerRetentionDays: 180,
  resolvedRetentionDays: 60, logicalLimitBytes: 5 * 1024 ** 3, etag: '1', ...fields,
})
export const overview = (fields: MessageInitShape<typeof OverviewSchema> = {}) => create(OverviewSchema, { name: 'overview', logicalLimitBytes: 5 * 1024 ** 3, ...fields })

/**
 * Renders `page` at `route` (matched by `path` when the page reads route parameters), with a fresh query client;
 * `renderAgain` renders the same tree anew (the page re-reads what it reads while rendering, such as the clock's zone).
 */
export function renderAt(page: ReactElement, route: string, path?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const tree = () => <QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}>{path ? <Routes><Route path={path} element={page}/></Routes> : page}</MemoryRouter></QueryClientProvider>
  const result = render(tree())
  return { ...result, renderAgain: () => result.rerender(tree()) }
}
