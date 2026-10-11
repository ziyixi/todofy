/**
 * An in-memory stand-in for the Worker's owner API (proto/brief/ui/v1), served by the same shared transcoder the Worker
 * uses, so every request is routed, decoded strictly and answered in the wire JSON profile as in production. It keeps
 * synthetic issues, items, sources, the profile, the settings and the status, and answers as the Worker does where
 * the UI depends on it (worker/src/api.ts): issues newest first in pages; an unknown issue or item is NOT_FOUND;
 * VoteItem replaces the vote and answers the item, and a repeated request_id answers the first response; ResetProfile
 * puts every weight back to 1; UpdateSettings needs an explicit mask, refuses a stale etag and a budget outside 5-100;
 * ResumeModelCalls clears a refusal. Every request must be a same-origin /api path, and a mutation must carry the CSRF
 * header. All content is synthetic (synthetic-*.org, text written for the tests).
 */
import { vi } from 'vitest'
import {
  BriefUiService,
  ListIssuesResponseSchema,
  ListItemsResponseSchema,
  ListSourcesResponseSchema,
} from '@ziyixi/proto/brief/ui/v1/brief_ui_service_pb'
import {
  Citation_Verdict,
  CitationSchema,
  Issue_Kind,
  Issue_State,
  IssueSchema,
  Item_Format,
  Item_Vote,
  ItemSchema,
  ParagraphSchema,
  ReferenceSchema,
  Review,
  Section,
  StepCostSchema,
  TextScope,
  type Issue,
  type Item,
} from '@ziyixi/proto/brief/ui/v1/issue_pb'
import { Source_Role, Source_State, SourceSchema, type Source } from '@ziyixi/proto/brief/ui/v1/source_pb'
import { Mode, ProfileSchema, ServiceStatus_KeyState, ServiceStatusSchema, SettingsSchema, TopicWeightSchema, type Profile, type ServiceStatus, type Settings } from '@ziyixi/proto/brief/ui/v1/status_pb'
import { updatePaths } from '@ziyixi/proto/field-mask'
import { HttpTranscoder, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder'
import { create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { Code, RpcError } from '@ziyixi/proto/rpc-status'
import { resetClientForTests } from '../api.ts'

/** 23:00 on Monday 12 October 2026 in the tests' zone (Asia/Shanghai, test/setup.ts); 08:00 in Los Angeles. */
export const NOW = Date.parse('2026-10-12T15:00:00Z')
export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

export interface Call {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Record<string, unknown> | null
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** A weekday issue of `day` (`2026-10-12`), sent at 06:31 Los Angeles time, with its step costs. */
export function issue(day: string, init: Partial<Issue> = {}): Issue {
  const [, month, date] = day.split('-').map(Number)
  const weekday = WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()] ?? ''
  const made = create(IssueSchema, {
    name: `issues/${day}`,
    kind: Issue_Kind.WEEKDAY,
    state: Issue_State.SENT,
    title: `简报 · ${String(month)}月${String(date)}日（${weekday}）`,
    itemCount: 2,
    candidateCount: 48,
    costUsd: 0.8235,
    stepCosts: [
      create(StepCostSchema, { step: 'pick', model: 'claude-opus-5-5', callCount: 1, inputTokenCount: 15_200, outputTokenCount: 6_100, costUsd: 0.1828 }),
      create(StepCostSchema, { step: 'write', model: 'claude-opus-5-5', callCount: 1, inputTokenCount: 44_800, outputTokenCount: 23_400, costUsd: 0.6472 }),
      create(StepCostSchema, { step: 'entail', model: 'claude-haiku-5-5', callCount: 1, inputTokenCount: 9_000, cacheReadTokenCount: 3_000, outputTokenCount: 1_500, costUsd: 0.0017 }),
    ],
    writerModels: ['claude-opus-5-5'],
    createTime: timestampFromMs(Date.parse(`${day}T10:30:00Z`)),
    sendTime: timestampFromMs(Date.parse(`${day}T13:31:00Z`)),
  })
  return Object.assign(made, init)
}

/** An item of `day`'s issue (`r1`, `w1`, `deep`), with two checked quotes behind its markers. */
export function item(day: string, id: string, init: Partial<Item> = {}): Item {
  const world = id.startsWith('w')
  const made = create(ItemSchema, {
    name: `issues/${day}/items/${id}`,
    section: world ? Section.WORLD : id === 'deep' ? Section.DEEP_READ : Section.RESEARCH,
    title: world ? '合成国央行首次降息' : '一种层析方法看到更深的地幔结构',
    paragraphs: [create(ParagraphSchema, { text: world ? '合成国央行把利率下调 0.25 个百分点[1]。这是 4 年来首次降息[2]。' : '作者用 120 个台站的数据反演[1]，分辨率比原有模型高 2 倍[2]。' })],
    why: world ? '影响全球利率走向。' : '与你的层析工作直接相关。',
    topic: world ? 'world.economy' : 'geo.seismology',
    score: 8.4,
    references: [
      create(ReferenceSchema, {
        source: world ? 'sources/synthetic-news' : 'sources/synthetic-journal',
        venue: world ? 'Synthetic News' : 'Synthetic Geophysics Letters',
        title: world ? 'Central bank of Synthland cuts rates' : 'Deeper mantle structure from dense arrays',
        uri: world ? 'https://synthetic-news.org/2026/10/rates' : 'https://synthetic-journal.org/papers/a1',
        review: world ? Review.NEWS : Review.PEER_REVIEWED,
        textScope: world ? TextScope.FULL_TEXT : TextScope.ABSTRACT,
      }),
    ],
    citations: [
      create(CitationSchema, { number: 1, referenceIndex: 0, quote: world ? 'The bank lowered its policy rate by 25 basis points.' : 'We invert data from 120 stations of a dense array.', verdict: Citation_Verdict.SUPPORTED }),
      create(CitationSchema, { number: 2, referenceIndex: 0, quote: world ? 'It is the first cut in four years.' : 'The resolution is twice that of earlier models.', verdict: Citation_Verdict.OVERSTATED }),
    ],
    reason: world ? '多年来首次转向' : '新数据揭示以前看不到的结构',
    format: world ? Item_Format.PLAIN : Item_Format.PROFESSIONAL,
  })
  return Object.assign(made, init)
}

export function source(id: string, init: Partial<Source> = {}): Source {
  const made = create(SourceSchema, {
    name: `sources/${id}`,
    displayName: `来源 ${id}`,
    section: Section.RESEARCH,
    role: Source_Role.CANDIDATE,
    review: Review.PEER_REVIEWED,
    state: Source_State.OK,
    uri: `https://synthetic-${id}.org/feed`,
    recentItemCount: 12,
    weight: 1,
    lastItemTitle: `A synthetic paper from ${id}`,
    lastItemTime: timestampFromMs(NOW - 3 * HOUR),
    lastSuccessTime: timestampFromMs(NOW - HOUR),
    usualGapHours: 20,
  })
  return Object.assign(made, init)
}

/** One page of `items` after the offset of `token` (the fake's page token is that offset). */
function slice<T>(items: readonly T[], size: number, token: string): { items: T[]; next: string } {
  const start = token === '' ? 0 : Number(token)
  const end = start + size
  return { items: items.slice(start, end), next: end < items.length ? String(end) : '' }
}

/** The LocalizedMessage of the reasons the fake answers (worker/src/reasons.ts). */
const LOCALIZED: Readonly<Record<string, string>> = {
  NOT_FOUND: '找不到这一项',
  UNAVAILABLE: '服务暂时不可用，请稍后再试',
  INVALID_SETTINGS: '每月预算须在 5 到 100 美元之间',
  BAD_REQUEST: '请求内容不正确',
}

const VOTE_NAMES: Readonly<Record<number, string>> = { [Item_Vote.UP]: 'up', [Item_Vote.DOWN]: 'down', [Item_Vote.MORE]: 'more' }

export class FakeServer {
  readonly calls: Call[] = []
  /** Newest first, as the Worker answers. */
  issues: Issue[] = [issue('2026-10-12'), issue('2026-10-09')]
  items: Item[] = [item('2026-10-12', 'r1'), item('2026-10-12', 'w1'), item('2026-10-09', 'r1')]
  sources: Source[] = [source('a'), source('b')]
  profile: Profile = create(ProfileSchema, {
    name: 'profile',
    topics: [
      create(TopicWeightSchema, { topic: 'geo.seismology', weight: 1.12, shownCount: 6, upCount: 3, downCount: 0, moreCount: 1, format: Item_Format.PROFESSIONAL }),
      create(TopicWeightSchema, { topic: 'llm.systems', weight: 0.9, shownCount: 4, upCount: 0, downCount: 2, moreCount: 0, format: Item_Format.FAMILIAR }),
      create(TopicWeightSchema, { topic: 'world.economy', weight: 1, format: Item_Format.PLAIN }),
    ],
    updateTime: timestampFromMs(NOW - 20 * HOUR),
  })
  settings: Settings = create(SettingsSchema, { name: 'settings', paused: false, monthlyBudgetUsd: 40, etag: 's1' })
  /** Fields of GetServiceStatus that a test sets (the rest as below). */
  status: Partial<ServiceStatus> = {}
  /** GetServiceStatus answers UNAVAILABLE this many more times. */
  statusFailures = 0
  /** The Worker's AIP-155 log: request_id -> the first answer. */
  private readonly replies = new Map<string, unknown>()
  private readonly transcoder: HttpTranscoder<ShapeOf<typeof BriefUiService>, null>

  constructor() {
    const notFound = (): never => {
      throw new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'no such resource')
    }
    const once = <T>(requestId: string, run: () => T): T => {
      if (requestId !== '' && this.replies.has(requestId)) return this.replies.get(requestId) as T
      const answer = run()
      if (requestId !== '') this.replies.set(requestId, answer)
      return answer
    }
    const handlers: ServiceHandlers<ShapeOf<typeof BriefUiService>, null> = {
      getIssue: (request) => Promise.resolve(this.issues.find((one) => one.name === request.name) ?? notFound()),
      listIssues: (request) => {
        const { items, next } = slice(this.issues, request.pageSize === 0 ? 30 : Math.min(request.pageSize, 60), request.pageToken)
        return Promise.resolve(create(ListIssuesResponseSchema, { issues: items, nextPageToken: next }))
      },
      getItem: (request) => Promise.resolve(this.items.find((one) => one.name === request.name) ?? notFound()),
      listItems: (request) => {
        if (!this.issues.some((one) => one.name === request.parent)) notFound()
        const own = this.items.filter((one) => one.name.startsWith(`${request.parent}/items/`))
        return Promise.resolve(create(ListItemsResponseSchema, { items: own, nextPageToken: '' }))
      },
      voteItem: (request) =>
        Promise.resolve(
          once(request.requestId, () => {
            const found = this.items.find((one) => one.name === request.name) ?? notFound()
            if (VOTE_NAMES[request.vote] === undefined) throw new RpcError(Code.INVALID_ARGUMENT, 'BAD_REQUEST', 'vote is required')
            found.vote = request.vote
            found.voteTime = timestampFromMs(NOW)
            return create(ItemSchema, found)
          }),
        ),
      getSource: (request) => Promise.resolve(this.sources.find((one) => one.name === request.name) ?? notFound()),
      listSources: (request) => {
        const { items, next } = slice(this.sources, request.pageSize === 0 ? 100 : Math.min(request.pageSize, 100), request.pageToken)
        return Promise.resolve(create(ListSourcesResponseSchema, { sources: items, nextPageToken: next }))
      },
      getProfile: () => Promise.resolve(this.profile),
      resetProfile: (request) =>
        Promise.resolve(
          once(request.requestId, () => {
            this.profile = create(ProfileSchema, { ...this.profile, topics: this.profile.topics.map((topic) => create(TopicWeightSchema, { ...topic, weight: 1, shownCount: 0, upCount: 0, downCount: 0, moreCount: 0 })), resetTime: timestampFromMs(NOW) })
            return this.profile
          }),
        ),
      getSettings: () => Promise.resolve(this.settings),
      // As the Worker: an explicit mask, a stale etag refused with ABORTED, a budget outside 5-100 refused.
      updateSettings: (request) => {
        const paths = updatePaths(request.updateMask)
        const input = request.settings
        if (paths === '*' || input === undefined) throw new RpcError(Code.INVALID_ARGUMENT, 'BAD_REQUEST', 'update_mask must name the fields')
        if (paths.includes('monthly_budget_usd') && (input.monthlyBudgetUsd < 5 || input.monthlyBudgetUsd > 100)) throw new RpcError(Code.INVALID_ARGUMENT, 'INVALID_SETTINGS', 'budget')
        return Promise.resolve(
          once(request.requestId, () => {
            if (input.etag !== '' && input.etag !== this.settings.etag) throw new RpcError(Code.ABORTED, 'ETAG_MISMATCH', 'stale etag')
            const next: Partial<Settings> = { etag: `${this.settings.etag}+` }
            if (paths.includes('paused')) next.paused = input.paused
            if (paths.includes('monthly_budget_usd')) next.monthlyBudgetUsd = input.monthlyBudgetUsd
            this.settings = create(SettingsSchema, { ...this.settings, ...next })
            return this.settings
          }),
        )
      },
      getServiceStatus: () => {
        if (this.statusFailures > 0) {
          this.statusFailures -= 1
          throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'try later')
        }
        return Promise.resolve(this.currentStatus())
      },
      resumeModelCalls: (request) =>
        Promise.resolve(
          once(request.requestId, () => {
            this.status = { ...this.status, keyState: ServiceStatus_KeyState.OK, rejectedStatus: 0, rejectedErrorType: '' }
            return this.currentStatus()
          }),
        ),
    }
    this.transcoder = new HttpTranscoder(BriefUiService, handlers, {
      domain: 'brief.ziyixi.science',
      maxBodyBytes: 4096,
      authorize: () => undefined,
      localize: (reason) => {
        const message = LOCALIZED[reason]
        return message === undefined ? undefined : { locale: 'zh-CN', message }
      },
    })
  }

  private currentStatus(): ServiceStatus {
    const defaults = create(ServiceStatusSchema, {
      name: 'serviceStatus',
      mode: Mode.LIVE,
      paused: this.settings.paused,
      keyState: ServiceStatus_KeyState.OK,
      mailConfigured: true,
      nextAlarmTime: timestampFromMs(NOW + 2 * HOUR),
      todayCostUsd: 0.12,
      monthCostUsd: 9.8,
      monthlyBudgetUsd: this.settings.monthlyBudgetUsd,
      okSourceCount: 40,
      failingSourceCount: 0,
      staleSourceCount: 0,
      todayItemCount: 230,
      todayCandidateCount: 180,
      todayNeurons: 64.4,
      build: '0123456789abcdef',
    })
    return Object.assign(defaults, this.status)
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
      const request = new Request(`https://brief.ziyixi.science${input}`, { method: init.method ?? 'GET', headers, ...(typeof init.body === 'string' ? { body: init.body } : {}) })
      const result = await this.transcoder.handle(request, null, 'req-1')
      return result?.response ?? new Response('{}', { status: 404 })
    })
  }

  /** The mutations sent (method other than GET), as paths with their bodies. */
  mutations(): Call[] {
    return this.calls.filter((call) => call.method !== 'GET')
  }
}

/** Waits until the page's pending promises settle. */
export async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
