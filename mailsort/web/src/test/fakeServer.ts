/**
 * An in-memory stand-in for the Worker's owner API (proto/mailsort/ui/v2), served by the same shared transcoder the
 * Worker uses, so every request is routed, decoded strictly and answered in the wire JSON profile as in production. It
 * keeps a few labels, examples, review items, ledger entries, the flow, the label report, the status and the settings;
 * a method it does not model (the replay evaluation, which the UI does not call) answers UNIMPLEMENTED. UpdateLabel
 * changes only the masked fields and refuses a stale etag, as the Worker does. Every request must be a same-origin /api
 * path, and a mutation must carry the CSRF header.
 */
import { vi } from 'vitest'
import { updatePaths } from '@ziyixi/proto/field-mask'
import { HttpTranscoder, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder'
import { create } from '@ziyixi/proto/protobuf'
import { EmptySchema, timestampFromMs, timestampMs } from '@ziyixi/proto/protobuf/wkt'
import { Code, RpcError } from '@ziyixi/proto/rpc-status'
import { Label_GmailState, LabelSchema, type Label } from '@ziyixi/proto/mailsort/ui/v2/label_pb'
import { MailFlow_CountSchema, MailFlowSchema, type MailFlow_Count } from '@ziyixi/proto/mailsort/ui/v2/flow_pb'
import {
  ListExamplesResponseSchema,
  ListLabelsResponseSchema,
  ListLedgerEntriesResponseSchema,
  ListReviewItemsResponseSchema,
  MailsortUiService,
  SyncLabelsResponseSchema,
  UndoLedgerEntriesResponseSchema,
} from '@ziyixi/proto/mailsort/ui/v2/mailsort_ui_service_pb'
import { ExampleSchema, LedgerEntry_State, LedgerEntrySchema, ReviewItem_State, ReviewItemSchema, type Example, type LedgerEntry, type ReviewItem } from '@ziyixi/proto/mailsort/ui/v2/review_pb'
import {
  LabelCountSchema,
  LabelReportSchema,
  Mode,
  ServiceStatus_AuthState,
  ServiceStatusSchema,
  SettingsSchema,
  type LabelCount,
  type ServiceStatus,
  type Settings,
} from '@ziyixi/proto/mailsort/ui/v2/status_pb'
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
    state: ReviewItem_State.PENDING,
    subject: `主题 ${id}`,
    sender: 'Sender <example.com>',
    candidates: [{ label: 'labels/newsletter', probability: 0.6 }, { label: '', probability: 0.3 }, { label: 'labels/receipt', probability: 0.1 }],
    reason: 'low_confidence',
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

/** UpdateLabel's mask paths and the Label fields they name. */
const LABEL_FIELDS: Readonly<Record<string, keyof Label>> = {
  display_name: 'displayName',
  description: 'description',
  enabled: 'enabled',
  trust_implying: 'trustImplying',
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
  examples: Example[] = []
  ledgerEntries: LedgerEntry[] = []
  /** GetMailFlow's counters, whatever the range. */
  flow: MailFlow_Count[] = []
  /** GetLabelReport's rows; null: every label with 10 automatic labels and 1 uncertain mail. */
  report: LabelCount[] | null = null
  /** Fields of GetServiceStatus that a test sets (the rest as below; review_count counts the pending items). */
  status: Partial<ServiceStatus> = {}
  settings: Settings = create(SettingsSchema, { name: 'settings', mode: Mode.SHADOW, effectiveMode: Mode.SHADOW, runWriteLimit: 10, dailyWriteLimit: 150, dailyNeuronBudget: 7000, etag: 's1' })
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
        return Promise.resolve(create(EmptySchema, {}))
      },
      removeTrustedDomain: (request) => {
        const index = this.labels.findIndex((item) => item.name === request.name)
        const before = this.labels[index]
        if (before === undefined || !before.trustedDomains.includes(request.domain)) throw new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'no such domain')
        if (request.etag !== '' && request.etag !== before.etag) throw new RpcError(Code.ABORTED, 'ETAG_MISMATCH', 'stale etag')
        const updated = Object.assign(create(LabelSchema), before, { etag: `${before.etag}+`, trustedDomains: before.trustedDomains.filter((domain) => domain !== request.domain) })
        this.labels[index] = updated
        return Promise.resolve(updated)
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
      resolveReviewItem: (request) => Promise.resolve(this.resolve(request.name, ReviewItem_State.RESOLVED, request.label)),
      skipReviewItem: (request) => Promise.resolve(this.resolve(request.name, ReviewItem_State.SKIPPED, '')),
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
      getMailFlow: (request) => Promise.resolve(create(MailFlowSchema, { name: request.name, startTime: timestampFromMs(NOW - 3_600_000), endTime: timestampFromMs(NOW), counts: this.flow })),
      getLabelReport: () =>
        Promise.resolve(
          create(LabelReportSchema, {
            name: 'labelReport',
            labels: this.report ?? this.labels.map((item) => create(LabelCountSchema, { label: item.name, autoCount: 10, unsureCount: 1 })),
            decidedCount: 50,
            autoCount: 40,
            noLabelCount: 5,
            unsureCount: 5,
            shownCount: 2,
          }),
        ),
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

  private resolve(name: string, state: ReviewItem_State, chosen: string): ReviewItem {
    const item = this.reviewItems.find((candidate) => candidate.name === name)
    if (item === undefined) throw new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'no such item')
    if (item.state !== ReviewItem_State.PENDING) throw new RpcError(Code.FAILED_PRECONDITION, 'ALREADY_RESOLVED', 'resolved')
    item.state = state
    item.resolvedLabel = chosen
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
