/**
 * An in-memory stand-in for the Worker's owner API (proto/watch/ui/v1), served by the same shared transcoder the Worker
 * uses, so every request is routed, decoded strictly and answered in the wire JSON profile as in production. Faithful
 * where the UI depends on it: etags (ETAG_MISMATCH with the watch), update masks, CSRF on mutations, AIP-155 replays of
 * CreateWatch (logged under the collection without a watch_id, as the Worker does), the inbox and drawer filters,
 * acknowledge, and a scripted preview. Every request must be a same-origin /api path. `loseNextResponse` commits the
 * next matching request and then fails its fetch, as a dropped connection would.
 */
import { vi } from 'vitest'
import { updatePaths } from '@ziyixi/proto/field-mask'
import { HttpTranscoder, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder'
import { clone, create, type MessageInitShape } from '@ziyixi/proto/protobuf'
import { EmptySchema, timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { Code, errorDetail, RpcError } from '@ziyixi/proto/rpc-status'
import { Change_State, ChangeSchema, type Change } from '@ziyixi/proto/watch/ui/v1/change_pb'
import { Watch_State, WatchHealthSchema, WatchSchema, type Watch } from '@ziyixi/proto/watch/ui/v1/watch_pb'
import {
  ListChangesResponseSchema,
  ListWatchesResponseSchema,
  PreviewWatchResponseSchema,
  ServiceStatusSchema,
  WatchUiService,
  type PreviewWatchResponse,
} from '@ziyixi/proto/watch/ui/v1/watch_ui_service_pb'
import { fromWire, toWire } from '@ziyixi/proto/wire-json'
import { resetClientForTests } from '../api.ts'

export interface Call {
  readonly method: string
  /** Path and query, as sent. */
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Record<string, unknown> | null
}

export const NOW = Date.parse('2026-10-01T08:00:00Z')

function fail(code: Code, reason: string, watch?: Watch): never {
  throw new RpcError(code, reason, reason, { details: watch === undefined ? [] : [errorDetail(WatchSchema, watch)] })
}

/** A watch fixture. */
export function watch(id: string, init: MessageInitShape<typeof WatchSchema> = {}): Watch {
  return create(WatchSchema, {
    name: `watches/${id}`,
    displayName: `Watch ${id}`,
    uri: `https://${id}.example.com/page`,
    state: Watch_State.ACTIVE,
    etag: `etag-${id}-1`,
    createTime: timestampFromMs(NOW),
    updateTime: timestampFromMs(NOW),
    health: create(WatchHealthSchema, { lastCheckTime: timestampFromMs(NOW - 3_600_000), nextCheckTime: timestampFromMs(NOW + 3_600_000) }),
    ...init,
  })
}

/** A change fixture. */
export function change(watchId: string, id: string, init: MessageInitShape<typeof ChangeSchema> = {}): Change {
  return create(ChangeSchema, {
    name: `watches/${watchId}/changes/${id}`,
    state: Change_State.CONFIRMED,
    summary: '新增 1 行，删除 1 行',
    addedLineCount: 1,
    removedLineCount: 1,
    diffLines: [
      { kind: 2, text: 'Price 100' },
      { kind: 1, text: 'Price 80' },
    ],
    detectTime: timestampFromMs(NOW - 600_000),
    watchDisplayName: `Watch ${watchId}`,
    ...init,
  })
}

export class FakeServer {
  readonly calls: Call[] = []
  readonly watches = new Map<string, Watch>()
  readonly changes: Change[] = []
  /** What PreviewWatch answers (a function of the request's watch). */
  preview: (watch: Watch) => PreviewWatchResponse = () => create(PreviewWatchResponseSchema, {})
  /** The next request whose path (before the query) ends with this is handled, and its response lost. */
  loseNextResponse: string | null = null
  private readonly created = new Map<string, Watch>()
  private etags = 1
  private readonly api: HttpTranscoder<ShapeOf<typeof WatchUiService>, undefined>

  constructor(watches: Watch[] = [], changes: Change[] = []) {
    for (const item of watches) this.watches.set(item.name, item)
    this.changes.push(...changes)
    this.api = new HttpTranscoder<ShapeOf<typeof WatchUiService>, undefined>(WatchUiService, this.handlers(), {
      domain: 'watch.ziyixi.science',
      maxBodyBytes: 64 * 1024,
      authorize: (request, route) => {
        if (!route.safe && !request.headers.get('x-csrf-token')) fail(Code.PERMISSION_DENIED, 'CSRF_FAILED')
      },
    })
  }

  existing(name: string): Watch {
    return this.watches.get(name) ?? fail(Code.NOT_FOUND, 'NOT_FOUND')
  }

  write(next: Watch): Watch {
    this.etags += 1
    const stored = clone(WatchSchema, next)
    stored.etag = `etag-${stored.name.split('/')[1] ?? ''}-${String(this.etags)}`
    this.watches.set(stored.name, stored)
    return clone(WatchSchema, stored)
  }

  private handlers(): ServiceHandlers<ShapeOf<typeof WatchUiService>, undefined> {
    return this.handlersOf(this)
  }

  private handlersOf(server: FakeServer): ServiceHandlers<ShapeOf<typeof WatchUiService>, undefined> {
    return {
      getWatch: (request) => Promise.resolve(clone(WatchSchema, server.existing(request.name))),
      listWatches: () => Promise.resolve(create(ListWatchesResponseSchema, { watches: [...server.watches.values()] })),
      createWatch: (request) => {
        const replay = request.requestId === '' ? undefined : server.created.get(request.requestId)
        if (replay !== undefined) return Promise.resolve(clone(WatchSchema, replay))
        const id = request.watchId === '' ? `w${String(server.watches.size + 100)}` : request.watchId
        if (server.watches.has(`watches/${id}`)) fail(Code.ALREADY_EXISTS, 'WATCH_EXISTS', server.existing(`watches/${id}`))
        const created = create(WatchSchema, request.watch)
        created.name = `watches/${id}`
        created.state = Watch_State.ACTIVE
        const written = server.write(created)
        if (request.requestId !== '') server.created.set(request.requestId, written)
        return Promise.resolve(written)
      },
      updateWatch: (request) => {
        const incoming = request.watch ?? fail(Code.INVALID_ARGUMENT, 'BAD_REQUEST')
        const current = server.existing(incoming.name)
        if (incoming.etag !== '' && incoming.etag !== current.etag) fail(Code.ABORTED, 'ETAG_MISMATCH', current)
        const paths = updatePaths(request.updateMask)
        const wire = toWire(WatchSchema, current) as Record<string, unknown>
        const update = toWire(WatchSchema, incoming) as Record<string, unknown>
        if (paths === '*') Object.assign(wire, update)
        else {
          for (const path of paths) {
            const [head, child] = path.split('.')
            if (head === undefined || head === 'etag') continue
            const parent = { ...(wire[head] as Record<string, unknown> | undefined) }
            const value = child === undefined ? update[head] : (update[head] as Record<string, unknown> | undefined)?.[child]
            if (child === undefined) wire[head] = value
            else if (value === undefined) Reflect.deleteProperty(parent, child)
            else parent[child] = value
            if (child !== undefined) wire[head] = parent
          }
        }
        return Promise.resolve(server.write(fromWire(WatchSchema, wire).message))
      },
      deleteWatch: (request) => {
        server.existing(request.name)
        server.watches.delete(request.name)
        return Promise.resolve(create(EmptySchema))
      },
      pauseWatch: (request) => Promise.resolve(server.write(create(WatchSchema, { ...server.existing(request.name), state: Watch_State.PAUSED }))),
      resumeWatch: (request) => Promise.resolve(server.write(create(WatchSchema, { ...server.existing(request.name), state: Watch_State.ACTIVE }))),
      checkWatch: (request) => Promise.resolve(clone(WatchSchema, server.existing(request.name))),
      previewWatch: (request) => Promise.resolve(server.preview(request.watch ?? fail(Code.INVALID_ARGUMENT, 'BAD_REQUEST'))),
      getChange: (request) => Promise.resolve(server.changes.find((item) => item.name === request.name) ?? fail(Code.NOT_FOUND, 'NOT_FOUND')),
      listChanges: (request) => {
        const state = /state\s*=\s*(\w+)/.exec(request.filter)?.[1]
        const wanted = state === 'NEW' || state === 'CONFIRMED' ? Change_State.CONFIRMED : state === 'SUPPRESSED' ? Change_State.SUPPRESSED : state === 'PENDING_CONFIRMATION' ? Change_State.PENDING_CONFIRMATION : null
        const items = server.changes.filter((item) => (request.parent === 'watches/-' || item.name.startsWith(`${request.parent}/`)) && (wanted === null || item.state === wanted))
        return Promise.resolve(create(ListChangesResponseSchema, { changes: items }))
      },
      acknowledgeChange: (request) => {
        const found = server.changes.find((item) => item.name === request.name) ?? fail(Code.NOT_FOUND, 'NOT_FOUND')
        if (found.state !== Change_State.CONFIRMED && found.state !== Change_State.ACKNOWLEDGED) fail(Code.FAILED_PRECONDITION, 'BAD_REQUEST')
        found.state = Change_State.ACKNOWLEDGED
        return Promise.resolve(clone(ChangeSchema, found))
      },
      getServiceStatus: () =>
        Promise.resolve(
          create(ServiceStatusSchema, {
            name: 'serviceStatus',
            activeWatchCount: [...server.watches.values()].filter((item) => item.state === Watch_State.ACTIVE).length,
            brokenWatchCount: [...server.watches.values()].filter((item) => item.state === Watch_State.BROKEN).length,
            suppressedChangeCount: server.changes.filter((item) => item.state === Change_State.SUPPRESSED).length,
            browserLimitMs: 480_000,
            build: 'test',
          }),
        ),
    }
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
        this.calls.push({ method: init.method ?? 'GET', path: url, headers, body })
        if (url === '/api/csrf') return Response.json({ token: 'synthetic-token' })
        const result = await this.api.handle(new Request(`https://watch.example.com${url}`, { method: init.method ?? 'GET', headers: init.headers ?? {}, ...(typeof init.body === 'string' ? { body: init.body } : {}) }), undefined)
        if (this.loseNextResponse !== null && (url.split('?')[0] ?? '').endsWith(this.loseNextResponse)) {
          this.loseNextResponse = null
          throw new TypeError('the connection dropped after the request was handled')
        }
        return result?.response ?? new Response('{}', { status: 404 })
      }),
    )
    return this
  }

  /** The mutations sent, or those whose path (before the query) ends with `suffix`. */
  mutations(suffix?: string): Call[] {
    return this.calls.filter((call) => call.method !== 'GET' && (suffix === undefined || (call.path.split('?')[0] ?? '').endsWith(suffix)))
  }
}
