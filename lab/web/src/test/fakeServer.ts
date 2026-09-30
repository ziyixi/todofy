/**
 * An in-memory stand-in for the Worker's owner API (docs/design.md §7–§9), faithful where the UI depends on
 * it: the decision log with undo of the latest effective decide/restart, versions with 409 deck_changed,
 * op_id replay, CSRF on mutations, summary with exclusions and send generations. Every request must be a
 * same-origin /api path.
 */
import { vi } from 'vitest'
import type {
  Decision,
  Deck,
  DeckCard,
  DeckKind,
  DeckMutationResponse,
  DeckState,
  DeckSummary,
  SendMode,
  SendStatus,
  TodayResponse,
  UndoTarget,
} from '../../../worker/src/api-types.ts'
import { resetClientForTests } from '../api/client'
import { DAY, sendStatus, today as todayFixture } from './fixtures'

export interface Call {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Record<string, unknown> | null
}

type Event =
  | { seq: number; kind: 'decide'; paper_id: string; decision: Decision; cancelled: boolean }
  | { seq: number; kind: 'restart'; cleared: Record<string, Decision>; cancelled: boolean }

export type Interceptor = (call: Call) => Response | null | undefined

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

export function apiError(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: { code, message: code, request_id: '0123456789abcdef' }, ...extra }, status)
}

export class FakeServer {
  readonly calls: Call[] = []
  today: TodayResponse
  cards: DeckCard[]
  kind: DeckKind
  events: Event[] = []
  version = 1
  excluded = new Set<string>()
  sentGeneration = new Map<string, number>()
  send: SendStatus | null = null
  laterAt: string | null = null
  defaultMode: SendMode = 'subtasks'
  ops = new Map<string, Response>()
  /** Answers for POST …/send and GET …/send, consumed in order; the last one repeats. */
  sendScript: SendStatus[] = []
  /** Runs first on every call; a Response short-circuits the fake. */
  interceptors: Interceptor[] = []
  private tokens = 0

  constructor(cards: DeckCard[], today: TodayResponse = todayFixture({}, 'ranked', cards.length), kind: DeckKind = 'ranked') {
    this.cards = cards
    this.today = today
    this.kind = kind
  }

  // ---- decision log ----

  decisions(): Record<string, Decision> {
    let state: Record<string, Decision> = {}
    for (const event of this.events) {
      if (event.cancelled) continue
      if (event.kind === 'decide') state[event.paper_id] = event.decision
      else state = {}
    }
    return state
  }

  undoTarget(): UndoTarget {
    const last = [...this.events].reverse().find((event) => !event.cancelled)
    if (!last) return null
    return last.kind === 'decide'
      ? { kind: 'decide', paper_id: last.paper_id, decision: last.decision }
      : { kind: 'restart', cleared: Object.keys(last.cleared).length }
  }

  state(): DeckState {
    const decisions = this.decisions()
    const values = Object.values(decisions)
    const liked = values.filter((value) => value === 'like').length
    const next = this.cards.find((item) => decisions[item.paper.id] === undefined)
    return {
      deck_id: DAY,
      version: this.version,
      decisions,
      counts: { total: this.cards.length, decided: values.length, liked, disliked: values.length - liked },
      next_position: next ? next.position : null,
      finished_at: next ? null : '2026-09-30T12:05:00Z',
      undo: this.undoTarget(),
    }
  }

  /** Decide directly, as another device would. */
  decideElsewhere(paperId: string, decision: Decision) {
    this.events.push({ seq: this.events.length + 1, kind: 'decide', paper_id: paperId, decision, cancelled: false })
    this.version += 1
  }

  deck(): Deck {
    return { deck_id: DAY, kind: this.kind, created_at: '2026-09-30T05:00:00Z', cards: this.cards, state: this.state(), send: this.send, later_at: this.laterAt }
  }

  summary(): DeckSummary {
    const decisions = this.decisions()
    const liked = this.cards
      .filter((item) => decisions[item.paper.id] === 'like')
      .map((item) => ({
        position: item.position,
        paper_id: item.paper.id,
        title: item.paper.title,
        brief_line: item.brief ? (item.brief.split('。')[0] ?? '') + '。' : null,
        abs_url: item.paper.abs_url,
        excluded: this.excluded.has(item.paper.id),
        sent_generation: this.sentGeneration.get(item.paper.id) ?? null,
      }))
    const sendable = liked.filter((item) => !item.excluded && item.sent_generation === null).length
    return { deck_id: DAY, state: this.state(), liked, sendable, send: this.send, default_mode: this.defaultMode }
  }

  private nextSend(mode: SendMode): SendStatus {
    const scripted = this.sendScript.length > 1 ? this.sendScript.shift() : this.sendScript[0]
    const summary = this.summary()
    const base = scripted ?? sendStatus({ items: summary.sendable, tasks_total: summary.sendable + 1, tasks_created: summary.sendable + 1 })
    const status = { ...base, mode: base.frozen && this.send?.frozen ? this.send.mode : mode }
    if (status.state === 'created' || status.state === 'duplicate') {
      for (const item of summary.liked) if (!item.excluded && item.sent_generation === null) this.sentGeneration.set(item.paper_id, status.generation)
    }
    this.send = status
    return status
  }

  private mutateDeck(body: Record<string, unknown>, kind: 'decide' | 'undo' | 'restart'): Response {
    if (body.base_version !== this.version) return apiError(409, 'deck_changed', { state: this.state() })
    let applied: DeckMutationResponse['applied']
    if (kind === 'decide') {
      const paperId = String(body.paper_id)
      if (this.decisions()[paperId]) return apiError(409, 'already_decided')
      const decision = body.decision as Decision
      this.events.push({ seq: this.events.length + 1, kind: 'decide', paper_id: paperId, decision, cancelled: false })
      applied = { kind: 'decide', paper_id: paperId, decision }
    } else if (kind === 'undo') {
      const target = this.undoTarget()
      const last = [...this.events].reverse().find((event) => !event.cancelled)
      if (!target || !last) return apiError(409, 'nothing_to_undo')
      last.cancelled = true
      applied = { kind: 'undo', undone: target }
    } else {
      const cleared = this.decisions()
      this.events.push({ seq: this.events.length + 1, kind: 'restart', cleared, cancelled: false })
      applied = { kind: 'restart', cleared: Object.keys(cleared).length }
    }
    this.version += 1
    return json({ state: this.state(), applied } satisfies DeckMutationResponse)
  }

  handle(call: Call): Response {
    for (const intercept of this.interceptors) {
      const response = intercept(call)
      if (response) return response
    }
    const path = call.path.replace(/\?.*$/, '')
    if (call.method === 'GET') {
      if (path === '/api/csrf') {
        this.tokens += 1
        return json({ token: `token-${this.tokens}` })
      }
      if (path === '/api/today') return json(this.today)
      if (path === `/api/decks/${DAY}`) return json(this.deck())
      if (path === `/api/decks/${DAY}/summary`) return json(this.summary())
      if (path === `/api/decks/${DAY}/send`) {
        if (!this.send) return apiError(404, 'not_found')
        return json(this.sendScript.length > 0 ? this.nextSend(this.send.mode) : this.send)
      }
      return apiError(404, 'not_found')
    }
    if (!call.headers['x-csrf-token']) return apiError(403, 'csrf_failed')
    const body = call.body ?? {}
    const opId = typeof body.op_id === 'string' ? body.op_id : null
    if (opId && this.ops.has(opId)) return (this.ops.get(opId) as Response).clone()
    const response = this.route(call.method, path, body)
    if (opId && response.ok) this.ops.set(opId, response.clone())
    return response
  }

  private route(method: string, path: string, body: Record<string, unknown>): Response {
    if (method === 'POST' && path === `/api/decks/${DAY}/decide`) return this.mutateDeck(body, 'decide')
    if (method === 'POST' && path === `/api/decks/${DAY}/undo`) return this.mutateDeck(body, 'undo')
    if (method === 'POST' && path === `/api/decks/${DAY}/restart`) return this.mutateDeck(body, 'restart')
    if (method === 'POST' && path === `/api/decks/${DAY}/exclude`) {
      if (body.excluded) this.excluded.add(String(body.paper_id))
      else this.excluded.delete(String(body.paper_id))
      return json(this.summary())
    }
    if (method === 'POST' && path === `/api/decks/${DAY}/send`) {
      if (this.summary().sendable === 0 && !(this.send?.frozen && this.send.state !== 'created' && this.send.state !== 'duplicate')) {
        return apiError(409, 'nothing_to_send')
      }
      return json(this.nextSend(body.mode as SendMode))
    }
    if (method === 'POST' && path === `/api/decks/${DAY}/later`) {
      this.laterAt = '2026-09-30T12:10:00Z'
      return json({ later_at: this.laterAt })
    }
    return apiError(404, 'not_found')
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
        return Promise.resolve(this.handle(call))
      }),
    )
    return this
  }

  mutations(suffix?: string): Call[] {
    return this.calls.filter((call) => call.method !== 'GET' && (suffix === undefined || call.path.endsWith(suffix)))
  }
}
