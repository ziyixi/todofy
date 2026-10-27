/**
 * An in-memory stand-in for the Worker's owner API (proto/mailsort/ui/v2), served by the same shared transcoder the
 * Worker uses, so every request is routed, decoded strictly and answered in the wire JSON profile as in production. It
 * keeps a few labels, examples, review items, ledger entries, the flow, the label report, the status and the settings;
 * a method it does not model answers UNIMPLEMENTED. Every request must be a same-origin /api
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
import { ClassificationPromptSchema, type ClassificationPrompt } from '@ziyixi/proto/mailsort/ui/v2/prompt_pb'
import {
  ListExamplesResponseSchema,
  ListLabelsResponseSchema,
  ListLedgerEntriesResponseSchema,
  ListReviewItemsResponseSchema,
  MailsortUiService,
  InitializePrioritiesResponseSchema,
  type InitializePrioritiesResponse,
  UndoLedgerEntriesResponseSchema,
} from '@ziyixi/proto/mailsort/ui/v2/mailsort_ui_service_pb'
import { ReplayEvaluation_State, ReplayEvaluationSchema, type ReplayEvaluation } from '@ziyixi/proto/mailsort/ui/v2/replay_pb'
import { ExampleSchema, LedgerEntry_State, LedgerEntrySchema, ReviewItem_State, ReviewItemSchema, type Example, type LedgerEntry, type ReviewItem } from '@ziyixi/proto/mailsort/ui/v2/review_pb'
import {
  ClaudeBudgetSchema,
  CodexUsageSchema,
  LabelCountSchema,
  LabelReportSchema,
  Mode,
  ServiceStatus_AuthState,
  ServiceStatusSchema,
  SettingsSchema,
  UnreadClassification_State,
  UnreadClassificationSchema,
  type LabelCount,
  type ServiceStatus,
  type Settings,
  type UnreadClassification,
} from '@ziyixi/proto/mailsort/ui/v2/status_pb'

export const NOW = Date.parse('2026-10-01T08:00:00Z')

export interface Call {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Record<string, unknown> | null
}

export function label(id: string, displayName: string): Label {
  return create(LabelSchema, { name: `labels/${id}`, displayName, description: `${displayName} 的说明`, enabled: true, gmailState: Label_GmailState.LINKED, descriptionVersion: 1, keepInInbox: id === 'p1', etag: `etag-${id}` })
}

export function reviewItem(id: string, init: Partial<ReviewItem> = {}): ReviewItem {
  return Object.assign(create(ReviewItemSchema, {
    name: `reviewItems/${id}`,
    state: ReviewItem_State.PENDING,
    subject: `主题 ${id}`,
    sender: 'Sender <example.com>',
    candidates: [{ label: 'labels/p2', probability: 0.6 }, { label: '', probability: 0.3 }, { label: 'labels/p3', probability: 0.1 }],
    reason: 'low_confidence',
    receiveTime: timestampFromMs(NOW - 3_600_000),
  }), init)
}

export function ledgerEntry(id: string, init: Partial<LedgerEntry> = {}): LedgerEntry {
  return Object.assign(create(LedgerEntrySchema, {
    name: `ledgerEntries/${id}`,
    messageId: `m${id}`,
    label: 'labels/p2',
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
  labels: Label[] = [label('p1', 'P1'), label('p2', 'P2'), label('p3', 'P3'), label('p4', 'P4')]
  reviewItems: ReviewItem[] = []
  examples: Example[] = []
  ledgerEntries: LedgerEntry[] = []
  /** GetMailFlow's counters, whatever the range. */
  flow: MailFlow_Count[] = []
  /** GetLabelReport's rows; null: every label with 10 automatic labels and 1 uncertain mail. */
  report: LabelCount[] | null = null
  /** The label report's decided mails of 7 days (the other totals follow the defaults). */
  reportDecidedCount = 50
  /** GetLabelReport answers UNAVAILABLE. */
  reportFails = false
  /** Fields of GetServiceStatus that a test sets (the rest as below; review_count counts the pending items). */
  status: Partial<ServiceStatus> = {}
  settings: Settings = create(SettingsSchema, { name: 'settings', mode: Mode.SHADOW, effectiveMode: Mode.SHADOW, classificationIntervalMinutes: 15, runWriteLimit: 10, dailyWriteLimit: 150, dailyNeuronBudget: 7000, etag: 's1' })
  settingsSaveFails = false
  classificationPrompt = create(ClassificationPromptSchema, { name: 'classificationPrompt', baseText: '按 P1、P2、P3、P4 判断合成邮件。', personalRules: '合成个人规则。', etag: 'initial' })
  promptReadFails = false
  promptSaveFails = false
  private readonly promptUpdates = new Map<string, ClassificationPrompt>()
  initializationCompleted = true
  initializeIncompleteRounds = 0
  initializeFails = false
  private readonly initializationRequests = new Map<string, InitializePrioritiesResponse>()
  unreadClassification: UnreadClassification | undefined
  unreadStartFails = false
  statusFails = false
  private readonly unreadStarts = new Map<string, UnreadClassification>()
  replay: ReplayEvaluation | null = null
  replayFails = false
  replayStartFails = false
  replaySamples = 0
  private readonly replayStarts = new Map<string, ReplayEvaluation>()
  private readonly transcoder: HttpTranscoder<ShapeOf<typeof MailsortUiService>, null>

  constructor() {
    const handlers: Partial<ServiceHandlers<ShapeOf<typeof MailsortUiService>, null>> = {
      listLabels: () => Promise.resolve(create(ListLabelsResponseSchema, { labels: this.labels })),
      initializePriorities: (request) => {
        if (this.initializeFails) throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', '分级设置暂不可用')
        const previous = this.initializationRequests.get(request.requestId)
        if (previous !== undefined) return Promise.resolve(previous)
        const completed = this.initializeIncompleteRounds === 0
        if (!completed) this.initializeIncompleteRounds -= 1
        const removedLabelCount = this.labels.filter((item) => !/^labels\/p[1-4]$/.test(item.name)).length
        this.labels = [label('p1', 'P1'), label('p2', 'P2'), label('p3', 'P3'), label('p4', 'P4')]
        if (!completed) this.labels[3]!.gmailState = Label_GmailState.PENDING
        this.initializationCompleted = completed
        const answer = create(InitializePrioritiesResponseSchema, { labels: completed ? this.labels : [], completed, removedLabelCount })
        this.initializationRequests.set(request.requestId, answer)
        return Promise.resolve(answer)
      },
      startUnreadClassification: (request) => {
        if (this.unreadStartFails) throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', '未读整理暂不可用')
        const previous = this.unreadStarts.get(request.requestId)
        if (previous !== undefined) return Promise.resolve(previous)
        if (this.unreadClassification?.state !== UnreadClassification_State.SCANNING && this.unreadClassification?.state !== UnreadClassification_State.RUNNING) {
          this.unreadClassification = create(UnreadClassificationSchema, { name: 'unreadClassification', state: UnreadClassification_State.SCANNING, startedTime: timestampFromMs(NOW) })
        }
        this.unreadStarts.set(request.requestId, this.unreadClassification)
        return Promise.resolve(this.unreadClassification)
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
      getMailFlow: (request) => Promise.resolve(create(MailFlowSchema, { name: request.name, startTime: timestampFromMs(NOW - 3_600_000), endTime: timestampFromMs(NOW), counts: this.flow })),
      getLabelReport: () => {
        if (this.reportFails) throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'the store is busy')
        return Promise.resolve(
          create(LabelReportSchema, {
            name: 'labelReport',
            labels: this.report ?? this.labels.map((item) => create(LabelCountSchema, { label: item.name, autoCount: 10, unsureCount: 1 })),
            decidedCount: this.reportDecidedCount,
            autoCount: 40,
            noLabelCount: 5,
            unsureCount: 5,
            shownCount: 2,
          }),
        )
      },
      getReplayEvaluation: () => {
        if (this.replayFails) throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', '回放状态暂不可用')
        if (this.replay === null) throw new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'no replay')
        return Promise.resolve(this.replay)
      },
      startReplayEvaluation: (request) => {
        if (this.replayStartFails) throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', '回放启动失败，请重试')
        const prior = this.replayStarts.get(request.requestId)
        if (prior !== undefined) return Promise.resolve(prior)
        this.replay = create(ReplayEvaluationSchema, { name: 'replayEvaluation', state: this.replaySamples === 0 ? ReplayEvaluation_State.SUCCEEDED : ReplayEvaluation_State.RUNNING, totalCount: this.replaySamples, createTime: timestampFromMs(NOW), ...(this.replaySamples === 0 ? { completeTime: timestampFromMs(NOW) } : {}) })
        this.replayStarts.set(request.requestId, this.replay)
        return Promise.resolve(this.replay)
      },
      getServiceStatus: () => {
        if (this.statusFails) throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', '状态读取失败')
        return Promise.resolve(
          Object.assign(create(ServiceStatusSchema, {
            name: 'serviceStatus',
            effectiveMode: this.settings.effectiveMode,
            authState: ServiceStatus_AuthState.OK,
            writeScope: false,
            lastSyncTime: timestampFromMs(NOW - 120_000),
            nextAlarmTime: timestampFromMs(NOW + 300_000),
            pendingCount: 2,
            reviewCount: this.reviewItems.filter((item) => item.state === ReviewItem_State.PENDING).length,
            prioritiesInitialized: this.initializationCompleted,
            unreadClassification: this.unreadClassification,
            decidedTodayCount: 12,
            neuronsToday: 523.4,
            dailyNeuronBudget: 7000,
            decisionModel: 'claude-opus-5-5',
            claudeBudget: create(ClaudeBudgetSchema, {
              model: 'claude-opus-5-5', effort: 'medium', month: '2026-10', limitUsd: 20, spentUsd: 0.5234,
              inputTokens: 24000, outputTokens: 1200,
              lastRequestTime: timestampFromMs(NOW - 600_000), nextBatchTime: timestampFromMs(NOW + 3_600_000),
            }),
            codexUsage: create(CodexUsageSchema, { model: 'gpt-6.1-sol', effort: 'medium', month: '2026-10' }),
            recentErrorCodes: ['gmail_429'],
            build: 'test',
          }), this.status),
        )
      },
      getClassificationPrompt: () => {
        if (this.promptReadFails) throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', '提示词读取失败')
        return Promise.resolve(this.classificationPrompt)
      },
      updateClassificationPrompt: (request) => {
        const prior = this.promptUpdates.get(request.requestId)
        if (prior !== undefined) return Promise.resolve(prior)
        if (this.promptSaveFails) throw new RpcError(Code.INVALID_ARGUMENT, 'BAD_REQUEST', '提示词保存失败')
        const input = request.classificationPrompt
        if (input === undefined) throw new RpcError(Code.INVALID_ARGUMENT, 'BAD_REQUEST', '缺少提示词')
        if (input.etag !== this.classificationPrompt.etag) throw new RpcError(Code.ABORTED, 'ETAG_MISMATCH', '提示词已改变')
        const mask = updatePaths(request.updateMask)
        const paths = mask === '*' ? [] : mask
        const next = create(ClassificationPromptSchema, { ...this.classificationPrompt, etag: `prompt-${String(this.promptUpdates.size + 1)}`, updateTime: timestampFromMs(NOW) })
        if (paths.includes('base_text')) next.baseText = input.baseText
        if (paths.includes('personal_rules')) next.personalRules = input.personalRules
        this.classificationPrompt = next
        this.promptUpdates.set(request.requestId, next)
        return Promise.resolve(next)
      },
      getSettings: () => Promise.resolve(this.settings),
      updateSettings: (request) => {
        if (this.settingsSaveFails) throw new RpcError(Code.INVALID_ARGUMENT, 'BAD_REQUEST', '设置保存失败')
        if (request.settings === undefined) throw new RpcError(Code.INVALID_ARGUMENT, 'BAD_REQUEST', 'settings')
        // As the Worker: only the masked fields change, and naming `mode` clears the breaker.
        const mask = updatePaths(request.updateMask)
        const paths = mask === '*' ? [] : mask
        const next = Object.assign(create(SettingsSchema), this.settings, { etag: 's2' })
        if (paths.includes('mode')) Object.assign(next, { mode: request.settings.mode, breakerTripped: false, breakerReason: '' })
        if (paths.includes('daily_neuron_budget')) next.dailyNeuronBudget = request.settings.dailyNeuronBudget
        if (paths.includes('run_write_limit')) next.runWriteLimit = request.settings.runWriteLimit
        if (paths.includes('classification_provider')) next.classificationProvider = request.settings.classificationProvider
        if (paths.includes('classification_interval_minutes')) next.classificationIntervalMinutes = request.settings.classificationIntervalMinutes
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

    vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
      if (!input.startsWith('/api/')) throw new Error(`a request outside the page's API: ${input}`)
      const headers = Object.fromEntries(new Headers(init.headers).entries())
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
      this.calls.push({ method: init.method ?? 'GET', path: input, headers, body })
      if (input === '/api/csrf') return Response.json({ token: '1' })
      if ((init.method ?? 'GET') !== 'GET' && (headers['x-csrf-token'] !== '1' || headers['content-type']?.split(';', 1)[0] !== 'application/json')) return new Response('{}', { status: 403 })
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
