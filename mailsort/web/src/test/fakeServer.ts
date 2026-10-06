/**
 * An in-memory stand-in for the Worker's owner API (proto/mailsort/ui/v1), served by the same shared transcoder the
 * Worker uses, so every request is routed, decoded strictly and answered in the wire JSON profile as in production. It
 * keeps a few labels, review items, rules and the settings; a method it does not model answers UNIMPLEMENTED. Every
 * request must be a same-origin /api path, and a mutation must carry the CSRF header.
 */
import { vi } from 'vitest'
import { HttpTranscoder, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder'
import { create } from '@ziyixi/proto/protobuf'
import { EmptySchema, timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { Code, RpcError } from '@ziyixi/proto/rpc-status'
import { Label_GmailState, LabelSchema, type Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import {
  ListExamplesResponseSchema,
  ListLabelsResponseSchema,
  ListLedgerEntriesResponseSchema,
  ListReviewItemsResponseSchema,
  ListRulesResponseSchema,
  MailsortUiService,
} from '@ziyixi/proto/mailsort/ui/v1/mailsort_ui_service_pb'
import { ReviewItem_Kind, ReviewItem_State, ReviewItemSchema, type ReviewItem } from '@ziyixi/proto/mailsort/ui/v1/review_pb'
import { Rule_State, RuleSchema, type Rule } from '@ziyixi/proto/mailsort/ui/v1/rule_pb'
import { AccuracyReportSchema, Mode, ServiceStatus_AuthState, ServiceStatusSchema, SettingsSchema, type Settings } from '@ziyixi/proto/mailsort/ui/v1/status_pb'
import { resetClientForTests } from '../api.ts'

export const NOW = Date.parse('2026-10-01T08:00:00Z')

export interface Call {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Record<string, unknown> | null
}

export function label(id: string, displayName: string): Label {
  return create(LabelSchema, { name: `labels/${id}`, displayName, description: `${displayName} 的说明`, enabled: true, gmailState: Label_GmailState.LINKED, descriptionVersion: 1, etag: `etag-${id}` })
}

export function reviewItem(id: string, init: Partial<ReviewItem> = {}): ReviewItem {
  return Object.assign(create(ReviewItemSchema, {
    name: `reviewItems/${id}`,
    kind: ReviewItem_Kind.SUGGESTION,
    state: ReviewItem_State.PENDING,
    subject: `主题 ${id}`,
    sender: 'Sender <example.com>',
    suggestedLabel: 'labels/newsletter',
    candidates: [{ label: 'labels/newsletter', probability: 0.9 }],
    decider: 'clef',
    receiveTime: timestampFromMs(NOW - 3_600_000),
  }), init)
}

function unimplemented(): never {
  throw new RpcError(Code.UNIMPLEMENTED, 'METHOD_NOT_ALLOWED', 'not modelled by the fake server')
}

export class FakeServer {
  readonly calls: Call[] = []
  labels: Label[] = [label('newsletter', '订阅'), label('receipt', '收据')]
  reviewItems: ReviewItem[] = []
  rules: Rule[] = []
  settings: Settings = create(SettingsSchema, { name: 'settings', mode: Mode.SHADOW, effectiveMode: Mode.SHADOW, runWriteLimit: 10, dailyWriteLimit: 150, dailyNeuronBudget: 7000, defaultThreshold: 0.8, precisionTarget: 0.9, etag: 's1' })
  private readonly transcoder: HttpTranscoder<ShapeOf<typeof MailsortUiService>, null>

  constructor() {
    const handlers: Partial<ServiceHandlers<ShapeOf<typeof MailsortUiService>, null>> = {
      listLabels: () => Promise.resolve(create(ListLabelsResponseSchema, { labels: this.labels })),
      createLabel: (request) => {
        const created = Object.assign(create(LabelSchema), request.label, { name: `labels/${request.labelId === '' ? `l${String(this.labels.length)}` : request.labelId}`, gmailState: Label_GmailState.PENDING, etag: 'new' })
        this.labels.push(created)
        return Promise.resolve(created)
      },
      updateLabel: (request) => {
        const index = this.labels.findIndex((item) => item.name === request.label?.name)
        if (index < 0) throw new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'no such label')
        const updated = Object.assign(create(LabelSchema), this.labels[index], request.label, { etag: 'updated' })
        this.labels[index] = updated
        return Promise.resolve(updated)
      },
      deleteLabel: (request) => {
        this.labels = this.labels.filter((item) => item.name !== request.name)
        return Promise.resolve(create(EmptySchema, {}))
      },
      listReviewItems: () => Promise.resolve(create(ListReviewItemsResponseSchema, { reviewItems: this.reviewItems.filter((item) => item.state === ReviewItem_State.PENDING) })),
      confirmReviewItem: (request) => Promise.resolve(this.resolve(request.name, ReviewItem_State.CONFIRMED, null)),
      correctReviewItem: (request) => Promise.resolve(this.resolve(request.name, ReviewItem_State.CORRECTED, request.label)),
      skipReviewItem: (request) => Promise.resolve(this.resolve(request.name, ReviewItem_State.SKIPPED, null)),
      listRules: () => Promise.resolve(create(ListRulesResponseSchema, { rules: this.rules })),
      approveRule: (request) => {
        const rule = this.rules.find((item) => item.name === request.name)
        if (rule === undefined) throw new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'no such rule')
        rule.state = Rule_State.ACTIVE
        return Promise.resolve(rule)
      },
      createRule: (request) => {
        const rule = Object.assign(create(RuleSchema), request.rule, { name: `rules/r${String(this.rules.length)}`, state: Rule_State.ACTIVE })
        this.rules.push(rule)
        return Promise.resolve(rule)
      },
      listExamples: () => Promise.resolve(create(ListExamplesResponseSchema, {})),
      listLedgerEntries: () => Promise.resolve(create(ListLedgerEntriesResponseSchema, {})),
      getAccuracyReport: () => Promise.resolve(create(AccuracyReportSchema, { name: 'accuracyReport', labels: this.labels.map((item) => ({ label: item.name, confirmedCount: 40, precisionLowerBound: 0.92 })), decidedCount: 50, unsureCount: 5, coverage: 0.9, precisionTarget: 0.9 })),
      getServiceStatus: () =>
        Promise.resolve(
          create(ServiceStatusSchema, {
            name: 'serviceStatus',
            effectiveMode: this.settings.effectiveMode,
            authState: ServiceStatus_AuthState.OK,
            writeScope: false,
            lastSyncTime: timestampFromMs(NOW - 120_000),
            pendingCount: 2,
            decidedTodayCount: 12,
            neuronsToday: 523.4,
            dailyNeuronBudget: 7000,
            decisionModel: 'clef',
            recentErrorCodes: ['gmail_429'],
            build: 'test',
          }),
        ),
      getSettings: () => Promise.resolve(this.settings),
      updateSettings: (request) => {
        if (request.settings === undefined) throw new RpcError(Code.INVALID_ARGUMENT, 'BAD_REQUEST', 'settings')
        this.settings = Object.assign(create(SettingsSchema), this.settings, request.settings, { effectiveMode: request.settings.mode, etag: 's2' })
        return Promise.resolve(this.settings)
      },
    }
    const all = new Proxy(handlers, { get: (target, key: string) => (target as Record<string, unknown>)[key] ?? unimplemented }) as ServiceHandlers<ShapeOf<typeof MailsortUiService>, null>
    this.transcoder = new HttpTranscoder(MailsortUiService, all, { domain: 'sort.ziyixi.science', maxBodyBytes: 65536, authorize: () => undefined })
  }

  private resolve(name: string, state: ReviewItem_State, chosen: string | null): ReviewItem {
    const item = this.reviewItems.find((candidate) => candidate.name === name)
    if (item === undefined) throw new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'no such item')
    if (item.state !== ReviewItem_State.PENDING) throw new RpcError(Code.FAILED_PRECONDITION, 'ALREADY_RESOLVED', 'resolved')
    item.state = state
    item.resolvedLabel = chosen ?? item.suggestedLabel
    return item
  }

  /** Installs this server as the page's fetch. */
  install(): void {
    resetClientForTests()
    vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
      if (!input.startsWith('/api/')) throw new Error(`a request outside the page's API: ${input}`)
      const headers = Object.fromEntries(new Headers(init.headers).entries())
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
      this.calls.push({ method: init.method ?? 'GET', path: input, headers, body })
      if (input === '/api/csrf') return Response.json({ token: 'csrf-token' })
      if ((init.method ?? 'GET') !== 'GET' && headers['x-csrf-token'] !== 'csrf-token') return new Response('{}', { status: 403 })
      const request = new Request(`https://sort.ziyixi.science${input}`, { method: init.method ?? 'GET', headers, ...(typeof init.body === 'string' ? { body: init.body } : {}) })
      const result = await this.transcoder.handle(request, null, 'req-1')
      return result?.response ?? new Response('{}', { status: 404 })
    })
  }
}

/** Waits until the page's pending promises settle. */
export async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
