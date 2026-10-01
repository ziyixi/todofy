/**
 * An in-memory stand-in for the Worker's owner API (proto/lab/ui/v1, docs/design.md §7–§9), served by the same
 * shared transcoder the Worker uses: every request is routed, decoded strictly and answered in the wire JSON
 * profile exactly as in production, so a UI request the Worker would refuse fails here too. Faithful where
 * the UI depends on it: the decision log with undo of the latest effective decide/restart, versions with
 * DECK_CHANGED (carrying the current state), request_id replay, CSRF on mutations, summary with exclusions
 * and send generations, likes, seeds and settings. Every request must be a same-origin /api path.
 */
import { vi } from 'vitest'
import { HttpTranscoder, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder'
import {
  DeckKind,
  DeckSchema,
  DeckStateSchema,
  DeckSummarySchema,
  Send_State,
  SendMode,
  UndoKind,
  UndoTargetSchema,
  type Card,
  type DeckState,
  type DeckSummary,
  type Send,
} from '@ziyixi/proto/lab/ui/v1/deck_pb'
import { SettingsSchema, type Settings, type Today } from '@ziyixi/proto/lab/ui/v1/home_pb'
import {
  DecideDeckResponseSchema,
  ImportSeedsResponseSchema,
  LabUiService,
  ListLikedPapersResponseSchema,
  ListSeedsResponseSchema,
  RestartDeckResponseSchema,
  SendDeckResponseSchema,
  SnoozeDeckResponseSchema,
  UndoDeckResponseSchema,
} from '@ziyixi/proto/lab/ui/v1/lab_ui_service_pb'
import { LikedPaperSchema, Seed_State, SeedSchema, type LikedPaper, type Seed } from '@ziyixi/proto/lab/ui/v1/library_pb'
import { Decision } from '@ziyixi/proto/lab/ui/v1/paper_pb'
import { create } from '@ziyixi/proto/protobuf'
import { EmptySchema, timestampFromDate } from '@ziyixi/proto/protobuf/wkt'
import { Code, errorDetail, RpcError, statusBody } from '@ziyixi/proto/rpc-status'
import { resetClientForTests } from '../api/client'
import { idOf, paperOf } from '../lib/messages'
import { DAY, sendStatus, today as todayFixture } from './fixtures'

export interface Call {
  readonly method: string
  /** Path and query, as sent. */
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Record<string, unknown> | null
}

type Choice = 'like' | 'dislike'
type Event =
  | { seq: number; kind: 'decide'; paper_id: string; decision: Choice; cancelled: boolean }
  | { seq: number; kind: 'restart'; cleared: Record<string, Choice>; cancelled: boolean }

export type Interceptor = (call: Call) => Response | null | undefined

const DECISION: Readonly<Record<Choice, Decision>> = { like: Decision.LIKE, dislike: Decision.DISLIKE }
const NAME = `decks/${DAY}`

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

/** A google.rpc.Status answer with this ErrorInfo reason (the Worker's shape, errors.proto). */
export function apiError(status: number, reason: string): Response {
  const code = status === 409 ? Code.ABORTED : status === 404 ? Code.NOT_FOUND : status === 403 ? Code.PERMISSION_DENIED : status >= 500 ? Code.UNAVAILABLE : Code.INVALID_ARGUMENT
  return json(statusBody(new RpcError(code, reason, reason, { httpStatus: status }), { domain: 'lab.ziyixi.science', requestId: '0123456789abcdef' }), status)
}

function fail(code: Code, reason: string, details: RpcError['details'] = []): never {
  throw new RpcError(code, reason, reason, { details })
}

const time = (iso: string) => timestampFromDate(new Date(iso))

export class FakeServer {
  readonly calls: Call[] = []
  today: Today
  cards: Card[]
  kind: DeckKind
  events: Event[] = []
  version = 1
  excluded = new Set<string>()
  sentGeneration = new Map<string, number>()
  send: Send | null = null
  snoozeTime: string | null = null
  defaultMode: SendMode = SendMode.SUBTASKS
  ops = new Map<string, Response>()
  /** Answers for SendDeck and GetSend, consumed in order; the last one repeats. */
  sendScript: Send[] = []
  /** Liked papers, newest first; ListLikedPapers pages them by likedPageSize. */
  liked: LikedPaper[] = []
  likedPageSize = 50
  seeds: Seed[] = []
  settings: Settings = create(SettingsSchema, {
    name: 'settings',
    categories: ['cs.IR', 'cs.CL', 'cs.LG'],
    dislikeWeight: 0.3,
    neuronCap: 2000,
    summaryModel: '@cf/ibm-granite/granite-4.0-h-micro',
    sendMode: SendMode.SUBTASKS,
    neuronCeiling: 5000,
    summaryModels: ['@cf/ibm-granite/granite-4.0-h-micro', '@cf/meta/llama-3.2-1b-instruct', '@cf/qwen/qwen3-30b-a3b-fp8'],
  })
  /** Runs first on every call; a Response short-circuits the fake. */
  interceptors: Interceptor[] = []
  /** Milliseconds every request waits before the fake handles it (a slow network). */
  latency = 0
  private tokens = 0
  private readonly api: HttpTranscoder<ShapeOf<typeof LabUiService>, undefined>

  constructor(cards: Card[], today: Today = todayFixture({}, 'ranked', cards.length), kind: DeckKind = DeckKind.RANKED) {
    this.cards = cards
    this.today = today
    this.kind = kind
    this.api = new HttpTranscoder<ShapeOf<typeof LabUiService>, undefined>(LabUiService, this.handlers(), {
      domain: 'lab.ziyixi.science',
      maxBodyBytes: 16 * 1024,
      authorize: (request, route) => {
        if (!route.safe && !request.headers.get('x-csrf-token')) fail(Code.PERMISSION_DENIED, 'CSRF_FAILED')
      },
    })
  }

  // ---- decision log ----

  /** The effective decisions by wire name ('like' / 'dislike'). */
  decisions(): Record<string, Choice> {
    let state: Record<string, Choice> = {}
    for (const event of this.events) {
      if (event.cancelled) continue
      if (event.kind === 'decide') state[event.paper_id] = event.decision
      else state = {}
    }
    return state
  }

  private undoTarget() {
    const last = [...this.events].reverse().find((event) => !event.cancelled)
    if (!last) return undefined
    return last.kind === 'decide'
      ? { kind: UndoKind.DECIDE, paperId: last.paper_id, decision: DECISION[last.decision] }
      : { kind: UndoKind.RESTART, clearedCount: Object.keys(last.cleared).length }
  }

  state(): DeckState {
    const decisions = this.decisions()
    const values = Object.values(decisions)
    const liked = values.filter((value) => value === 'like').length
    const next = this.cards.find((item) => decisions[idOf(item)] === undefined)
    return create(DeckStateSchema, {
      deck: NAME,
      version: this.version,
      decisions: Object.fromEntries(Object.entries(decisions).map(([paper, choice]) => [paper, DECISION[choice]])),
      counts: { total: this.cards.length, decided: values.length, liked, disliked: values.length - liked },
      nextPosition: next?.position,
      finishTime: next ? undefined : time('2026-09-30T12:05:00Z'),
      undo: this.undoTarget(),
    })
  }

  /** Decide directly, as another device would. */
  decideElsewhere(paperId: string, decision: Choice) {
    this.events.push({ seq: this.events.length + 1, kind: 'decide', paper_id: paperId, decision, cancelled: false })
    this.version += 1
  }

  summary(): DeckSummary {
    const decisions = this.decisions()
    const likedItems = this.cards
      .filter((item) => decisions[idOf(item)] === 'like')
      .map((item) => ({
        position: item.position,
        paperId: idOf(item),
        title: paperOf(item).title,
        briefLine: item.brief ? (item.brief.split('。')[0] ?? '') + '。' : undefined,
        abstractUri: paperOf(item).abstractUri,
        excluded: this.excluded.has(idOf(item)),
        sentGeneration: this.sentGeneration.get(idOf(item)),
      }))
    const sendableCount = likedItems.filter((item) => !item.excluded && item.sentGeneration === undefined).length
    return create(DeckSummarySchema, { name: `${NAME}/summary`, state: this.state(), likedItems, sendableCount, latestSend: this.send ?? undefined, defaultMode: this.defaultMode })
  }

  private nextSend(mode: SendMode): Send {
    const scripted = this.sendScript.length > 1 ? this.sendScript.shift() : this.sendScript[0]
    const summary = this.summary()
    const base = scripted ?? sendStatus({ item_count: summary.sendableCount, tasks_total: summary.sendableCount + 1, tasks_created: summary.sendableCount + 1 })
    const status = { ...base, mode: base.frozen && this.send?.frozen ? this.send.mode : mode }
    if (status.state === Send_State.CREATED || status.state === Send_State.DUPLICATE) {
      for (const item of summary.likedItems) if (!item.excluded && item.sentGeneration === undefined) this.sentGeneration.set(item.paperId, status.generation)
    }
    this.send = status
    return status
  }

  private mutateDeck(baseVersion: number, mutation: { kind: 'decide'; paperId: string; decision: Decision } | { kind: 'undo' | 'restart' }): DeckState {
    if (baseVersion !== this.version) fail(Code.ABORTED, 'DECK_CHANGED', [errorDetail(DeckStateSchema, this.state())])
    if (mutation.kind === 'decide') {
      if (this.decisions()[mutation.paperId]) fail(Code.ALREADY_EXISTS, 'ALREADY_DECIDED')
      const decision: Choice = mutation.decision === Decision.LIKE ? 'like' : 'dislike'
      this.events.push({ seq: this.events.length + 1, kind: 'decide', paper_id: mutation.paperId, decision, cancelled: false })
    } else if (mutation.kind === 'undo') {
      const last = [...this.events].reverse().find((event) => !event.cancelled)
      if (!last) fail(Code.FAILED_PRECONDITION, 'NOTHING_TO_UNDO')
      last.cancelled = true
    } else {
      this.events.push({ seq: this.events.length + 1, kind: 'restart', cleared: this.decisions(), cancelled: false })
    }
    this.version += 1
    return this.state()
  }

  private handlers(): ServiceHandlers<ShapeOf<typeof LabUiService>, undefined> {
    const deck = (name: string) => {
      if (name !== NAME && name !== `${NAME}/summary` && name !== `${NAME}/send`) fail(Code.NOT_FOUND, 'DECK_NOT_FOUND')
    }
    return {
      getToday: () => Promise.resolve(this.today),
      getPipelineStatus: () => Promise.reject(new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'not in the fake')),
      getDeck: ({ name }) => {
        deck(name)
        return Promise.resolve(
          create(DeckSchema, {
            name: NAME,
            kind: this.kind,
            createTime: time('2026-09-30T05:00:00Z'),
            cards: this.cards,
            state: this.state(),
            latestSend: this.send ?? undefined,
            snoozeTime: this.snoozeTime === null ? undefined : time(this.snoozeTime),
          }),
        )
      },
      decideDeck: (request) => {
        deck(request.name)
        const state = this.mutateDeck(request.baseVersion, { kind: 'decide', paperId: request.paperId, decision: request.decision })
        return Promise.resolve(create(DecideDeckResponseSchema, { state }))
      },
      undoDeck: (request) => {
        deck(request.name)
        const undone = this.undoTarget()
        const state = this.mutateDeck(request.baseVersion, { kind: 'undo' })
        return Promise.resolve(create(UndoDeckResponseSchema, { state, undone: undone && create(UndoTargetSchema, undone) }))
      },
      restartDeck: (request) => {
        deck(request.name)
        const cleared = Object.keys(this.decisions()).length
        return Promise.resolve(create(RestartDeckResponseSchema, { state: this.mutateDeck(request.baseVersion, { kind: 'restart' }), clearedCount: cleared }))
      },
      snoozeDeck: (request) => {
        deck(request.name)
        this.snoozeTime = '2026-09-30T12:10:00Z'
        return Promise.resolve(create(SnoozeDeckResponseSchema, { snoozeTime: time(this.snoozeTime) }))
      },
      excludePaper: (request) => {
        deck(request.name)
        if (request.excluded) this.excluded.add(request.paperId)
        else this.excluded.delete(request.paperId)
        return Promise.resolve(this.summary())
      },
      sendDeck: (request) => {
        deck(request.name)
        const open = this.send?.frozen === true && this.send.state !== Send_State.CREATED && this.send.state !== Send_State.DUPLICATE
        if (this.summary().sendableCount === 0 && !open) fail(Code.FAILED_PRECONDITION, 'NOTHING_TO_SEND')
        return Promise.resolve(create(SendDeckResponseSchema, { send: this.nextSend(request.mode) }))
      },
      getDeckSummary: ({ name }) => {
        deck(name)
        return Promise.resolve(this.summary())
      },
      getSend: ({ name }) => {
        deck(name)
        if (!this.send) fail(Code.NOT_FOUND, 'NOT_FOUND')
        return Promise.resolve(this.sendScript.length > 0 ? this.nextSend(this.send.mode) : this.send)
      },
      listLikedPapers: ({ pageToken, filter, pageSize }) => {
        const matching = this.liked.filter((paper) => (paper.paper?.title ?? '').toLowerCase().includes(filter.toLowerCase()))
        const start = pageToken === '' ? 0 : Number(pageToken.replace(/^p/, ''))
        const size = Math.min(pageSize || 50, this.likedPageSize)
        const page = matching.slice(start, start + size)
        const nextPageToken = start + size < matching.length ? `p${String(start + size)}` : ''
        return Promise.resolve(create(ListLikedPapersResponseSchema, { likedPapers: page, nextPageToken }))
      },
      deleteLikedPaper: ({ name }) => {
        if (!this.liked.some((paper) => paper.name === name)) fail(Code.NOT_FOUND, 'NOT_FOUND')
        this.liked = this.liked.filter((paper) => paper.name !== name)
        return Promise.resolve(create(EmptySchema))
      },
      createLikedPaper: ({ likedPaperId }) => {
        const name = `likedPapers/${likedPaperId}`
        if (this.liked.some((paper) => paper.name === name)) fail(Code.ALREADY_EXISTS, 'ALREADY_LIKED')
        const paper = this.cards.find((item) => idOf(item) === `arxiv:${likedPaperId}`)?.paper
        const liked = create(LikedPaperSchema, { name, paper, createTime: time('2026-09-30T12:00:00Z') })
        this.liked = [liked, ...this.liked]
        return Promise.resolve(liked)
      },
      listSeeds: () => Promise.resolve(create(ListSeedsResponseSchema, { seeds: this.seeds })),
      importSeeds: ({ inputs }) => {
        const added = inputs.map((id) => create(SeedSchema, { name: `seeds/${id}`, paperId: `arxiv:${id}`, state: Seed_State.PENDING, createTime: time('2026-09-30T00:00:00Z') }))
        this.seeds = [...added, ...this.seeds]
        return Promise.resolve(create(ImportSeedsResponseSchema, { seeds: this.seeds }))
      },
      deleteSeed: ({ name }) => {
        this.seeds = this.seeds.filter((seed) => seed.name !== name)
        return Promise.resolve(create(EmptySchema))
      },
      getSettings: () => Promise.resolve(this.settings),
      updateSettings: ({ settings }) => {
        if (!settings || settings.neuronCap > this.settings.neuronCeiling) fail(Code.INVALID_ARGUMENT, 'BAD_REQUEST')
        this.settings = { ...this.settings, ...settings, neuronCeiling: this.settings.neuronCeiling, summaryModels: this.settings.summaryModels }
        return Promise.resolve(this.settings)
      },
    }
  }

  async handle(call: Call): Promise<Response> {
    for (const intercept of this.interceptors) {
      const response = intercept(call)
      if (response) return response
    }
    if (call.method === 'GET' && call.path === '/api/csrf') {
      this.tokens += 1
      return json({ token: `token-${String(this.tokens)}` })
    }
    // request_id replay: a repeated mutation is answered with its first response (the Worker's op log).
    const url = new URL(call.path, 'http://lab.test')
    const requestId = typeof call.body?.request_id === 'string' ? call.body.request_id : url.searchParams.get('request_id')
    const replayable = call.method !== 'GET' && call.headers['x-csrf-token'] !== undefined && requestId !== null
    const stored = replayable ? this.ops.get(requestId) : undefined
    if (stored) return stored.clone()
    const request = new Request(url, { method: call.method, headers: call.headers, ...(call.body === null ? {} : { body: JSON.stringify(call.body) }) })
    const result = await this.api.handle(request, undefined, '0123456789abcdef')
    const response = result?.response ?? apiError(404, 'NOT_FOUND')
    if (replayable && response.ok) this.ops.set(requestId, response.clone())
    return response
  }

  /** Replaces fetch with this server. */
  install(): this {
    resetClientForTests()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!/^\/api\//.test(url)) throw new Error(`unexpected request to ${url}`)
        const headers: Record<string, string> = {}
        new Headers(init.headers).forEach((value, key) => {
          headers[key] = value
        })
        const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
        const call: Call = { method: init.method ?? 'GET', path: url, headers, body }
        this.calls.push(call)
        if (this.latency > 0) await new Promise((resolve) => setTimeout(resolve, this.latency))
        return this.handle(call)
      }),
    )
    return this
  }

  /** The mutations sent, or those of one custom method (`decide`, `send`, ...) or ending with a path suffix. */
  mutations(verb?: string): Call[] {
    return this.calls.filter((call) => call.method !== 'GET' && (verb === undefined || call.path.split('?')[0]?.endsWith(verb.startsWith('/') ? verb : `:${verb}`)))
  }
}
