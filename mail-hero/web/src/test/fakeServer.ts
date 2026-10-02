/**
 * An in-memory stand-in for the Worker's owner API (proto/mailhero/ui/v2), served by the same shared transcoder the
 * Worker uses: every request the UI makes is routed, decoded strictly and answered in the wire JSON profile exactly as
 * in production, so a request the Worker would refuse (an unknown field or query parameter, a missing request_id, a
 * malformed name) fails here too. The answers come from `state`, which a test sets up with the fixtures
 * (test/fixtures.ts); `answer` overrides one method, `fail` makes one throw a google.rpc.Status, and `calls` lists every
 * decoded request in order; an error's localized copy is `服务端拒绝：<reason>`. Mutations need the CSRF header the UI's transport sends (GET /api/csrf issues it).
 */
import { vi } from 'vitest'
import { create, type Message as ProtoMessage } from '@ziyixi/proto/protobuf'
import { HttpTranscoder, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder'
import { Code, RpcError } from '@ziyixi/proto/rpc-status'
import { DeliveryPayloadSchema, DeliverySchema, type Delivery, type DeliveryAttempt, type DeliveryPayload } from '@ziyixi/proto/mailhero/ui/v2/delivery_pb'
import { EndpointSchema, type Endpoint } from '@ziyixi/proto/mailhero/ui/v2/endpoint_pb'
import {
  CheckEndpointResponse_CheckResult, CheckEndpointResponseSchema, ListDeliveriesResponseSchema, ListDeliveryAttemptsResponseSchema, ListEndpointsResponseSchema,
  ListMessagesResponseSchema, MailHeroUiService, PreviewRetentionPolicyResponseSchema, RotateEndpointCredentialResponseSchema, SendMessageResponseSchema,
  ResendDeliveryResponseSchema, SummarizeDeliveryAttemptsResponseSchema, TestEndpointResponseSchema, UnblockEndpointResponseSchema,
} from '@ziyixi/proto/mailhero/ui/v2/mail_hero_ui_service_pb'
import { MessageContentSchema, type Message, type MessageContent } from '@ziyixi/proto/mailhero/ui/v2/message_pb'
import { OverviewSchema, SettingsSchema, SetupStatusSchema, type Overview, type Settings, type SetupStatus } from '@ziyixi/proto/mailhero/ui/v2/settings_pb'
import { resetClientForTests } from '../api/client'

/** One decoded request: the rpc's name (`listMessages`) and its request message. */
export interface Call { readonly method: string; readonly request: Record<string, unknown> }

/** What the fake answers from. Lists are answered whole (a test pages with `answer`). */
export interface FakeState {
  settings: Settings
  overview: Overview
  setup: SetupStatus
  messages: Message[]
  contents: Map<string, MessageContent>
  deliveries: Delivery[]
  attempts: Map<string, DeliveryAttempt[]>
  payloads: Map<string, DeliveryPayload>
  endpoints: Endpoint[]
}

type Handlers = ServiceHandlers<ShapeOf<typeof MailHeroUiService>, unknown>
type Method = keyof Handlers

export interface FakeServer {
  readonly state: FakeState
  readonly calls: Call[]
  /** Overrides one rpc's answer (its request in, its response message out). */
  readonly answer: Partial<{ [K in Method]: Handlers[K] }>
  /** Makes one rpc answer this error. */
  readonly fail: Partial<Record<Method, RpcError>>
  /** The decoded requests of one rpc. */
  callsOf(method: Method): Record<string, unknown>[]
}

/** A google.rpc.Status error as the Worker answers it (errors.proto). */
export function rpcError(code: Code, reason: string, metadata: Record<string, string> = {}): RpcError {
  return new RpcError(code, reason, reason, { metadata })
}

function notFound(): never {
  throw rpcError(Code.NOT_FOUND, 'NOT_FOUND')
}

/** Installs a fake owner API as `fetch` (vi.stubGlobal) and answers it. */
export function installFakeServer(initial: Partial<FakeState> = {}): FakeServer {
  const state: FakeState = {
    settings: create(SettingsSchema, { name: 'settings', etag: '1' }), overview: create(OverviewSchema, { name: 'overview' }),
    setup: create(SetupStatusSchema, { name: 'setupStatus' }), messages: [], contents: new Map(), deliveries: [], attempts: new Map(),
    payloads: new Map(), endpoints: [], ...initial,
  }
  const calls: Call[] = []
  const answer: FakeServer['answer'] = {}
  const fail: FakeServer['fail'] = {}
  const defaults: Handlers = {
    getOverview: async () => state.overview,
    getSetupStatus: async () => state.setup,
    getSettings: async () => state.settings,
    updateSettings: async request => {
      // Only the masked fields change, as in the Worker (the etag is compared, not stored).
      const next: Record<string, unknown> = { ...state.settings }
      for (const path of request.updateMask?.paths ?? []) {
        const field = path.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
        if (field !== 'etag') next[field] = (request.settings as unknown as Record<string, unknown>)[field]
      }
      state.settings = create(SettingsSchema, { ...next, etag: String(Number(state.settings.etag) + 1) })
      return state.settings
    },
    previewRetentionPolicy: async request => create(PreviewRetentionPolicyResponseSchema, { etag: state.settings.etag, rawRetentionDays: request.rawRetentionDays,
      contentRetentionDays: request.contentRetentionDays, ledgerRetentionDays: request.ledgerRetentionDays, resolvedRetentionDays: request.resolvedRetentionDays,
      applyExisting: request.applyExisting, confirmationToken: 'synthetic-confirmation' }),
    listMessages: async () => create(ListMessagesResponseSchema, { messages: state.messages }),
    getMessage: async request => state.messages.find(item => item.name === request.name) ?? notFound(),
    updateMessage: async request => state.messages.find(item => item.name === request.message?.name) ?? notFound(),
    getMessageContent: async request => state.contents.get(request.name) ?? create(MessageContentSchema, { name: request.name }),
    sendMessage: async request => create(SendMessageResponseSchema, { delivery: create(DeliverySchema, { name: 'deliveries/sent', message: request.name, endpoint: request.endpoint }) }),
    reparseMessage: async request => state.messages.find(item => item.name === request.name) ?? notFound(),
    clearMessageContent: async request => state.messages.find(item => item.name === request.name) ?? notFound(),
    listDeliveries: async request => {
      const message = /^message = "([^"]+)"$/.exec(request.filter)?.[1]
      return create(ListDeliveriesResponseSchema, { deliveries: state.deliveries.filter(item => message === undefined || item.message === message) })
    },
    getDelivery: async request => state.deliveries.find(item => item.name === request.name) ?? notFound(),
    retryDelivery: async request => state.deliveries.find(item => item.name === request.name) ?? notFound(),
    cancelDelivery: async request => state.deliveries.find(item => item.name === request.name) ?? notFound(),
    resendDelivery: async request => create(ResendDeliveryResponseSchema, { delivery: { name: 'deliveries/resent', endpoint: request.endpoint, sourceDelivery: request.name } }),
    listDeliveryAttempts: async request => create(ListDeliveryAttemptsResponseSchema, { deliveryAttempts: state.attempts.get(request.parent) ?? [] }),
    getDeliveryAttempt: async () => notFound(),
    getDeliveryPayload: async request => state.payloads.get(request.name) ?? create(DeliveryPayloadSchema, { name: request.name }),
    summarizeDeliveryAttempts: async request => create(SummarizeDeliveryAttemptsResponseSchema, { startTime: request.startTime, endTime: request.endTime,
      granularity: request.granularity, timeZone: request.timeZone || 'UTC' }),
    listEndpoints: async () => create(ListEndpointsResponseSchema, { endpoints: state.endpoints }),
    getEndpoint: async request => state.endpoints.find(item => item.name === request.name) ?? notFound(),
    createEndpoint: async ({ endpoint }) => create(EndpointSchema, { displayName: endpoint?.displayName, uri: endpoint?.uri, authType: endpoint?.authType,
      ratePerMinute: endpoint?.ratePerMinute, timeoutSeconds: endpoint?.timeoutSeconds, name: 'endpoints/created', credentialConfigured: true, etag: '1' }),
    updateEndpoint: async request => state.endpoints.find(item => item.name === request.endpoint?.name) ?? notFound(),
    rotateEndpointCredential: async request => create(RotateEndpointCredentialResponseSchema, { endpoint: state.endpoints.find(item => item.name === request.name) ?? notFound(), affectedRevisionCount: 1 }),
    unblockEndpoint: async request => create(UnblockEndpointResponseSchema, { endpoint: state.endpoints.find(item => item.name === request.name) ?? notFound() }),
    checkEndpoint: async () => create(CheckEndpointResponseSchema, { uriAllowed: true, dns: CheckEndpointResponse_CheckResult.NOT_CHECKED, tls: CheckEndpointResponse_CheckResult.NOT_CHECKED, consumer: CheckEndpointResponse_CheckResult.NOT_CHECKED }),
    testEndpoint: async request => create(TestEndpointResponseSchema, { delivery: { name: 'deliveries/test-event', endpoint: request.name } }),
  }
  const handlers = Object.fromEntries((Object.keys(defaults) as Method[]).map(method => [method, async (request: ProtoMessage) => {
    calls.push({ method, request: request as unknown as Record<string, unknown> })
    const failure = fail[method]
    if (failure !== undefined) throw failure
    const override = answer[method] as ((request: ProtoMessage, context: unknown) => Promise<ProtoMessage>) | undefined
    return (override ?? (defaults[method] as unknown as (request: ProtoMessage, context: unknown) => Promise<ProtoMessage>))(request, undefined)
  }])) as unknown as Handlers
  const transcoder = new HttpTranscoder(MailHeroUiService, handlers, {
    domain: 'mail-hero.ziyixi.science', maxBodyBytes: 64 * 1024,
    // The Worker localizes every reason in Chinese; here the copy names the reason so a test can see which one arrived.
    localize: reason => ({ locale: 'zh-CN', message: `服务端拒绝：${reason}` }),
    authorize: request => {
      if (request.method !== 'GET' && request.headers.get('X-CSRF-Token') !== 'synthetic-csrf') throw rpcError(Code.PERMISSION_DENIED, 'CSRF_FAILED')
    },
  })
  resetClientForTests()
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'https://mail-hero.example.test')
    if (url.pathname === '/api/csrf') return Response.json({ token: 'synthetic-csrf' })
    const result = await transcoder.handle(new Request(url, init), undefined)
    return result?.response ?? transcoder.errorResponse(rpcError(Code.NOT_FOUND, 'NOT_FOUND'))
  })
  return { state, calls, answer, fail, callsOf: method => calls.filter(call => call.method === method).map(call => call.request) }
}
