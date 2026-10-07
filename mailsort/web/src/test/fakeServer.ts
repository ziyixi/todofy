/**
 * An in-memory stand-in for the Worker's owner API (proto/mailsort/ui/v1), served by the same shared transcoder the
 * Worker uses, so every request is routed, decoded strictly and answered in the wire JSON profile as in production. It
 * keeps a few labels, rules, examples, review items, ledger entries, the flow, the status and the settings, and
 * applies the template of ImportRules; a method it does not model (ExportRules, an import of the owner's own file, the
 * single undo, which the UI no longer offers) answers UNIMPLEMENTED. UpdateLabel changes only the masked fields and
 * refuses a stale etag, as the Worker does. Every request must be a same-origin /api path, and a mutation must carry
 * the CSRF header.
 */
import { vi } from 'vitest'
import { updatePaths } from '@ziyixi/proto/field-mask'
import { HttpTranscoder, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder'
import { create } from '@ziyixi/proto/protobuf'
import { EmptySchema, timestampFromMs, timestampMs } from '@ziyixi/proto/protobuf/wkt'
import { Code, RpcError } from '@ziyixi/proto/rpc-status'
import { Label_GmailState, LabelSchema, type Label } from '@ziyixi/proto/mailsort/ui/v1/label_pb'
import { MailFlow_CountSchema, MailFlowSchema, type MailFlow_Count } from '@ziyixi/proto/mailsort/ui/v1/flow_pb'
import {
  ExportGmailFiltersResponseSchema,
  ImportRulesResponseSchema,
  LabelImportSchema,
  ListExamplesResponseSchema,
  ListLabelsResponseSchema,
  ListLedgerEntriesResponseSchema,
  ListReviewItemsResponseSchema,
  ListRulesResponseSchema,
  MailsortUiService,
  SyncLabelsResponseSchema,
  UndoLedgerEntriesResponseSchema,
} from '@ziyixi/proto/mailsort/ui/v1/mailsort_ui_service_pb'
import {
  ExampleSchema,
  LedgerEntry_State,
  LedgerEntrySchema,
  ReviewItem_Kind,
  ReviewItem_State,
  ReviewItemSchema,
  type Example,
  type LedgerEntry,
  type ReviewItem,
} from '@ziyixi/proto/mailsort/ui/v1/review_pb'
import { Rule_State, RuleSchema, type Rule } from '@ziyixi/proto/mailsort/ui/v1/rule_pb'
import {
  AccuracyReportSchema,
  LabelAccuracySchema,
  Mode,
  ServiceStatus_AuthState,
  ServiceStatusSchema,
  SettingsSchema,
  type LabelAccuracy,
  type ServiceStatus,
  type Settings,
} from '@ziyixi/proto/mailsort/ui/v1/status_pb'
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

export function ledgerEntry(id: string, init: Partial<LedgerEntry> = {}): LedgerEntry {
  return Object.assign(create(LedgerEntrySchema, {
    name: `ledgerEntries/${id}`,
    messageId: `m${id}`,
    label: 'labels/newsletter',
    archived: true,
    origin: 'auto',
    state: LedgerEntry_State.APPLIED,
    undoable: true,
    subject: `主题 ${id}`,
    sender: 'Sender <example.com>',
    createTime: timestampFromMs(NOW - 3_600_000),
  }), init)
}

export function example(id: string, labelId: string, summary = `例子 ${id} 的摘要`): Example {
  return create(ExampleSchema, { name: `examples/${id}`, label: `labels/${labelId}`, summary, embedded: true, createTime: timestampFromMs(NOW - 86_400_000) })
}

/** The template's 15 labels (worker/src/template.ts), by path: what ImportRules' use_template adds. */
export const TEMPLATE_PATHS = ['开发/CI通知', '开发/平台工具', '金融/投资', '金融/银行支付', '账号安全', '政府法律', '购物/订单物流', '购物/促销', '订阅收据', '出行', '生活/账单住房', '生活/汽车', '生活/医疗', '求职', '学校与社群']

/** UpdateLabel's mask paths and the Label fields they name. */
const LABEL_FIELDS: Readonly<Record<string, keyof Label>> = {
  display_name: 'displayName',
  description: 'description',
  enabled: 'enabled',
  live: 'live',
  trust_implying: 'trustImplying',
  threshold: 'threshold',
  keep_in_inbox: 'keepInInbox',
  sensitive: 'sensitive',
}

/** One flow counter. */
export function flowCount(stage: MailFlow_Count['stage'], outcome: MailFlow_Count['outcome'], label: string, mailCount: number): MailFlow_Count {
  return create(MailFlow_CountSchema, { stage, outcome, label, mailCount })
}

/** One page of `items` after the item named by `token` (the fake's page token is the last item's index). */
function page<T>(items: readonly T[], size: number, token: string): { items: T[]; next: string } {
  const start = token === '' ? 0 : Number(token)
  const end = start + (size === 0 ? 50 : size)
  return { items: items.slice(start, end), next: end < items.length ? String(end) : '' }
}

function unimplemented(): never {
  throw new RpcError(Code.UNIMPLEMENTED, 'METHOD_NOT_ALLOWED', 'not modelled by the fake server')
}

export class FakeServer {
  readonly calls: Call[] = []
  labels: Label[] = [label('newsletter', '订阅'), label('receipt', '收据')]
  reviewItems: ReviewItem[] = []
  rules: Rule[] = []
  examples: Example[] = []
  ledgerEntries: LedgerEntry[] = []
  /** Rules the export leaves out (trust rules). */
  exportSkipped = 0
  /** GetMailFlow's counters, whatever the range. */
  flow: MailFlow_Count[] = []
  /** GetAccuracyReport's rows; null: every label with 40 confirmations and a bound of 0.92. */
  accuracy: LabelAccuracy[] | null = null
  /** GetAccuracyReport answers UNAVAILABLE. */
  accuracyFails = false
  /** Fields of GetServiceStatus that a test sets (the rest as below; review_count counts the pending items). */
  status: Partial<ServiceStatus> = {}
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
      // As the Worker: a stale etag is refused, only the masked fields change, a new etag every time, and a label
      // turned sensitive loses its examples.
      updateLabel: (request) => {
        const index = this.labels.findIndex((item) => item.name === request.label?.name)
        const before = this.labels[index]
        if (before === undefined || request.label === undefined) throw new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'no such label')
        if (request.label.etag !== '' && request.label.etag !== before.etag) throw new RpcError(Code.ABORTED, 'ETAG_MISMATCH', 'stale etag')
        const mask = updatePaths(request.updateMask)
        const updated = Object.assign(create(LabelSchema), before, { etag: `${before.etag}+` })
        for (const [path, field] of Object.entries(LABEL_FIELDS)) {
          if (mask === '*' || mask.includes(path)) Object.assign(updated, { [field]: request.label[field] })
        }
        if (updated.sensitive && !before.sensitive) {
          this.examples = this.examples.filter((item) => item.label !== before.name)
          updated.exampleCount = 0
        }
        this.labels[index] = updated
        return Promise.resolve(updated)
      },
      deleteLabel: (request) => {
        this.labels = this.labels.filter((item) => item.name !== request.name)
        this.rules = this.rules.filter((item) => item.label !== request.name)
        return Promise.resolve(create(EmptySchema, {}))
      },
      // The template only, as the Worker applies it to a store without those labels.
      importRules: (request) => {
        if (!request.useTemplate) unimplemented()
        const labels = TEMPLATE_PATHS.map((path) => create(LabelImportSchema, { path, description: `${path} 的说明` }))
        if (!request.validateOnly) {
          TEMPLATE_PATHS.forEach((path, index) => {
            this.labels.push(Object.assign(label(`t${String(index)}`, path), { gmailState: Label_GmailState.PENDING }))
          })
        }
        return Promise.resolve(create(ImportRulesResponseSchema, { applied: !request.validateOnly, createdLabelCount: labels.length, labels }))
      },
      listExamples: (request) => {
        const examples = request.label === '' ? this.examples : this.examples.filter((item) => item.label === request.label)
        const { items, next } = page(examples, request.pageSize, request.pageToken)
        return Promise.resolve(create(ListExamplesResponseSchema, { examples: items, nextPageToken: next }))
      },
      deleteExample: (request) => {
        const found = this.examples.find((item) => item.name === request.name)
        if (found === undefined) throw new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'no such example')
        this.examples = this.examples.filter((item) => item !== found)
        const owner = this.labels.find((item) => item.name === found.label)
        if (owner !== undefined) owner.exampleCount -= 1
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
      disableRule: (request) => {
        const rule = this.rules.find((item) => item.name === request.name)
        if (rule === undefined) throw new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'no such rule')
        rule.state = Rule_State.DISABLED
        return Promise.resolve(rule)
      },
      deleteRule: (request) => {
        this.rules = this.rules.filter((item) => item.name !== request.name)
        return Promise.resolve(create(EmptySchema, {}))
      },
      createRule: (request) => {
        const rule = Object.assign(create(RuleSchema), request.rule, { name: `rules/r${String(this.rules.length)}`, state: Rule_State.ACTIVE })
        this.rules.push(rule)
        return Promise.resolve(rule)
      },
      listLedgerEntries: (request) => {
        const entries = request.label === '' ? this.ledgerEntries : this.ledgerEntries.filter((item) => item.label === request.label)
        const { items, next } = page(entries, request.pageSize, request.pageToken)
        return Promise.resolve(create(ListLedgerEntriesResponseSchema, { ledgerEntries: items, nextPageToken: next }))
      },
      undoLedgerEntry: (request) => {
        const found = this.ledgerEntries.find((item) => item.name === request.name)
        if (found === undefined || !found.undoable) throw new RpcError(Code.FAILED_PRECONDITION, 'NOT_UNDOABLE', 'not undoable')
        Object.assign(found, { state: LedgerEntry_State.UNDONE, undoable: false })
        return Promise.resolve(found)
      },
      // As the Worker: the range's entries (of the label when set), at most 20 per call, newest first, and how many
      // undoable entries are left.
      undoLedgerEntries: (request) => {
        const from = request.startTime === undefined ? 0 : timestampMs(request.startTime)
        const to = request.endTime === undefined ? 0 : timestampMs(request.endTime)
        const inRange = (item: LedgerEntry) => item.createTime !== undefined && timestampMs(item.createTime) >= from && timestampMs(item.createTime) < to
        const open = this.ledgerEntries.filter((item) => item.undoable && inRange(item) && (request.label === '' || item.label === request.label))
        const batch = open.slice(0, 20)
        for (const item of batch) Object.assign(item, { state: LedgerEntry_State.UNDONE, undoable: false })
        return Promise.resolve(create(UndoLedgerEntriesResponseSchema, { undoneCount: batch.length, failedCount: 0, remainingCount: open.length - batch.length }))
      },
      // As the Worker: the first label adopts the owner's Gmail label of its path; nothing is imported.
      syncLabels: () => {
        const first = this.labels[0]
        if (first !== undefined) first.gmailState = Label_GmailState.ADOPTED
        return Promise.resolve(create(SyncLabelsResponseSchema, { labels: this.labels, linkedCount: 1, renamedCount: 0, missingCount: 0 }))
      },
      exportGmailFilters: () => {
        const active = this.rules.filter((rule) => rule.state === Rule_State.ACTIVE)
        return Promise.resolve(create(ExportGmailFiltersResponseSchema, { xml: '<feed/>', ruleCount: active.length, skippedCount: this.exportSkipped }))
      },
      getMailFlow: (request) => Promise.resolve(create(MailFlowSchema, { name: request.name, startTime: timestampFromMs(NOW - 3_600_000), endTime: timestampFromMs(NOW), counts: this.flow })),
      getAccuracyReport: () => {
        if (this.accuracyFails) throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'try later')
        return Promise.resolve(
          create(AccuracyReportSchema, {
            name: 'accuracyReport',
            labels: this.accuracy ?? this.labels.map((item) => create(LabelAccuracySchema, { label: item.name, confirmedCount: 40, precisionLowerBound: 0.92 })),
            decidedCount: 50,
            unsureCount: 5,
            coverage: 0.9,
            precisionTarget: 0.9,
          }),
        )
      },
      getServiceStatus: () =>
        Promise.resolve(
          Object.assign(create(ServiceStatusSchema, {
            name: 'serviceStatus',
            effectiveMode: this.settings.effectiveMode,
            authState: ServiceStatus_AuthState.OK,
            writeScope: false,
            lastSyncTime: timestampFromMs(NOW - 120_000),
            nextAlarmTime: timestampFromMs(NOW + 300_000),
            pendingCount: 2,
            reviewCount: this.reviewItems.filter((item) => item.state === ReviewItem_State.PENDING).length,
            decidedTodayCount: 12,
            neuronsToday: 523.4,
            dailyNeuronBudget: 7000,
            decisionModel: 'clef',
            recentErrorCodes: ['gmail_429'],
            build: 'test',
          }), this.status),
        ),
      getSettings: () => Promise.resolve(this.settings),
      updateSettings: (request) => {
        if (request.settings === undefined) throw new RpcError(Code.INVALID_ARGUMENT, 'BAD_REQUEST', 'settings')
        // As the Worker: only the masked fields change, and naming `mode` clears the breaker.
        const mask = updatePaths(request.updateMask)
        const paths = mask === '*' ? [] : mask
        const next = Object.assign(create(SettingsSchema), this.settings, { etag: 's2' })
        if (paths.includes('mode')) Object.assign(next, { mode: request.settings.mode, breakerTripped: false, breakerReason: '' })
        if (paths.includes('daily_neuron_budget')) next.dailyNeuronBudget = request.settings.dailyNeuronBudget
        if (paths.includes('run_write_limit')) next.runWriteLimit = request.settings.runWriteLimit
        next.effectiveMode = next.breakerTripped ? Mode.SHADOW : next.mode
        this.settings = next
        return Promise.resolve(this.settings)
      },
    }
    const all = new Proxy(handlers, { get: (target, key: string) => (target as Record<string, unknown>)[key] ?? unimplemented }) as ServiceHandlers<ShapeOf<typeof MailsortUiService>, null>
    this.transcoder = new HttpTranscoder(MailsortUiService, all, { domain: 'sort.ziyixi.science', maxBodyBytes: 262144, authorize: () => undefined })
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
