/**
 * An in-memory stand-in for the Worker's owner API (proto/links/ui/v1), served by the same shared transcoder the
 * Worker uses: every request is routed, decoded strictly and answered in the wire JSON profile as in production, so a
 * request the Worker would refuse fails here too. Faithful where the launcher depends on it: etags and revisions,
 * soft delete with undelete, rollback, LINK_EXISTS with the link as a detail, request_id replay, CSRF on mutations,
 * paged lists and exports, and imports with per-line problems. Every request must be a same-origin /_/api path.
 */
import { vi } from 'vitest'
import { updatePaths } from '@ziyixi/proto/field-mask'
import { HttpTranscoder, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder'
import { Link_PathMode, Link_Visibility, LinkSchema, type Link } from '@ziyixi/proto/links/ui/v1/link_pb'
import {
  ExportLinksResponseSchema,
  ImportLinksResponseSchema,
  ImportProblem_Reason,
  LinksUiService,
  ListLinkRevisionsResponseSchema,
  ListLinksResponseSchema,
} from '@ziyixi/proto/links/ui/v1/links_ui_service_pb'
import { decodePageToken, encodePageToken } from '@ziyixi/proto/page-token'
import { clone, create } from '@ziyixi/proto/protobuf'
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { Code, errorDetail, RpcError } from '@ziyixi/proto/rpc-status'
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

function fail(code: Code, reason: string, link?: Link): never {
  throw new RpcError(code, reason, reason, { details: link === undefined ? [] : [errorDetail(LinkSchema, link)] })
}

/** A link fixture (wire defaults: exact, private). */
export function link(key: string, init: Partial<Omit<Link, '$typeName'>> = {}): Link {
  return create(LinkSchema, {
    name: `links/${key}`,
    target: `https://${key}.example.com/`,
    pathMode: Link_PathMode.EXACT,
    visibility: Link_Visibility.PRIVATE,
    createTime: timestampFromMs(NOW),
    updateTime: timestampFromMs(NOW),
    etag: `etag-${key}-1`,
    revisionId: '1',
    revisionCreateTime: timestampFromMs(NOW),
    ...init,
  })
}

export class FakeServer {
  readonly calls: Call[] = []
  /** The links by key; revisions[key] holds every revision's content, oldest first. */
  readonly links = new Map<string, Link>()
  readonly revisions = new Map<string, Link[]>()
  pageSize = 100
  exportPageSize = 250
  private readonly replies = new Map<string, Response>()
  private etags = 1
  private readonly api: HttpTranscoder<ShapeOf<typeof LinksUiService>, undefined>

  constructor(links: Link[] = []) {
    for (const item of links) this.put(item)
    this.api = new HttpTranscoder<ShapeOf<typeof LinksUiService>, undefined>(LinksUiService, this.handlers(), {
      domain: 's.ziyixi.science',
      maxBodyBytes: 128 * 1024,
      authorize: (request, route) => {
        if (!route.safe && !request.headers.get('x-csrf-token')) fail(Code.PERMISSION_DENIED, 'CSRF_FAILED')
      },
    })
  }

  private put(item: Link): void {
    const key = item.name.slice('links/'.length)
    this.links.set(key, item)
    const list = this.revisions.get(key) ?? []
    if (!list.some((revision) => revision.revisionId === item.revisionId)) list.push(clone(LinkSchema, item))
    this.revisions.set(key, list)
  }

  private current(name: string): Link {
    const found = this.links.get(name.slice('links/'.length))
    if (found === undefined) fail(Code.NOT_FOUND, 'NOT_FOUND')
    return found
  }

  private next(base: Link, change: Partial<Omit<Link, '$typeName'>>, revision: boolean): Link {
    this.etags += 1
    const revisionId = revision ? String(Number(base.revisionId) + 1) : base.revisionId
    const updated = create(LinkSchema, { ...base, ...change, etag: `etag-${String(this.etags)}`, revisionId, updateTime: timestampFromMs(NOW + this.etags) })
    this.put(updated)
    return updated
  }

  private handlers(): ServiceHandlers<ShapeOf<typeof LinksUiService>, undefined> {
    const content = (from: Link) => ({
      target: from.target,
      pathMode: from.pathMode || Link_PathMode.EXACT,
      visibility: from.visibility || Link_Visibility.PRIVATE,
      description: from.description,
      tags: [...from.tags],
      expireTime: from.expireTime,
    })
    return {
      getLink: (request) => Promise.resolve(this.current(request.name)),
      listLinks: (request) => {
        const all = [...this.links.entries()].filter(([, item]) => request.showDeleted || item.deleteTime === undefined).sort(([a], [b]) => a.localeCompare(b))
        const after = request.pageToken === '' ? '' : (decodePageToken(request.pageToken, { filter: request.filter, show_deleted: request.showDeleted }) as string)
        const rest = all.filter(([key]) => key > after)
        const page = rest.slice(0, this.pageSize)
        const last = page[page.length - 1]?.[0]
        const next = rest.length > this.pageSize && last !== undefined ? encodePageToken(last, { filter: request.filter, show_deleted: request.showDeleted }) : ''
        return Promise.resolve(create(ListLinksResponseSchema, { links: page.map(([, item]) => item), nextPageToken: next }))
      },
      createLink: (request) => {
        const key = request.linkId.toLowerCase()
        const existing = this.links.get(key)
        if (existing !== undefined) fail(Code.ALREADY_EXISTS, 'LINK_EXISTS', existing)
        if (!/^https:\/\//.test(request.link?.target ?? '')) fail(Code.INVALID_ARGUMENT, 'INVALID_TARGET')
        const created = link(key, { ...content(request.link ?? create(LinkSchema)), etag: `etag-${key}-1` })
        this.put(created)
        return Promise.resolve(created)
      },
      updateLink: (request) => {
        const given = request.link ?? create(LinkSchema)
        const base = this.current(given.name)
        if (base.deleteTime !== undefined) fail(Code.FAILED_PRECONDITION, 'LINK_DELETED', base)
        if (given.etag !== '' && given.etag !== base.etag) fail(Code.ABORTED, 'ETAG_MISMATCH', base)
        const paths = updatePaths(request.updateMask)
        const all = content(given)
        const change = paths === '*' ? all : Object.fromEntries(Object.entries(all).filter(([field]) => paths.includes(field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))))
        return Promise.resolve(this.next(base, change, true))
      },
      deleteLink: (request) => {
        const base = this.current(request.name)
        if (base.deleteTime !== undefined) fail(Code.NOT_FOUND, 'NOT_FOUND', base)
        return Promise.resolve(this.next(base, { deleteTime: timestampFromMs(NOW), purgeTime: timestampFromMs(NOW + 30 * 86_400_000) }, false))
      },
      undeleteLink: (request) => {
        const base = this.current(request.name)
        if (base.deleteTime === undefined) fail(Code.ALREADY_EXISTS, 'NOT_DELETED', base)
        return Promise.resolve(this.next(base, { deleteTime: undefined, purgeTime: undefined }, false))
      },
      listLinkRevisions: (request) => {
        const key = this.current(request.name).name.slice('links/'.length)
        return Promise.resolve(create(ListLinkRevisionsResponseSchema, { links: [...(this.revisions.get(key) ?? [])].reverse() }))
      },
      rollbackLink: (request) => {
        const base = this.current(request.name)
        if (request.etag !== '' && request.etag !== base.etag) fail(Code.ABORTED, 'ETAG_MISMATCH', base)
        const kept = this.revisions.get(base.name.slice('links/'.length))?.find((revision) => revision.revisionId === request.revisionId)
        if (kept === undefined) fail(Code.NOT_FOUND, 'REVISION_NOT_FOUND')
        return Promise.resolve(this.next(base, content(kept), true))
      },
      importLinks: (request) => {
        let created = 0
        const problems: { lineNumber: number; reason: ImportProblem_Reason }[] = []
        request.content.split('\n').forEach((line, index) => {
          if (line.trim() === '') return
          try {
            const item = fromWire(LinkSchema, JSON.parse(line), { strict: true }).message
            const key = item.name.slice('links/'.length)
            if (this.links.has(key)) {
              problems.push({ lineNumber: index + 1, reason: ImportProblem_Reason.LINK_EXISTS })
              return
            }
            this.put(link(key, content(item)))
            created += 1
          } catch {
            problems.push({ lineNumber: index + 1, reason: ImportProblem_Reason.INVALID_LINE })
          }
        })
        return Promise.resolve(create(ImportLinksResponseSchema, { createdCount: created, skippedCount: problems.length, problems }))
      },
      exportLinks: (request) => {
        const all = [...this.links.entries()].filter(([, item]) => item.deleteTime === undefined).sort(([a], [b]) => a.localeCompare(b))
        const after = request.pageToken === '' ? '' : (decodePageToken(request.pageToken, {}) as string)
        const rest = all.filter(([key]) => key > after)
        const page = rest.slice(0, this.exportPageSize)
        const last = page[page.length - 1]?.[0]
        return Promise.resolve(
          create(ExportLinksResponseSchema, {
            lines: page.map(([, item]) => JSON.stringify(toWire(LinkSchema, item))),
            nextPageToken: rest.length > this.exportPageSize && last !== undefined ? encodePageToken(last, {}) : '',
          }),
        )
      },
    }
  }

  private async handle(call: Call, init: RequestInit): Promise<Response> {
    const requestId = /[?&]request_id=([^&]+)/.exec(call.path)?.[1] ?? (typeof call.body?.['request_id'] === 'string' ? call.body['request_id'] : '')
    const stored = requestId === '' ? undefined : this.replies.get(requestId)
    if (stored !== undefined) return stored.clone()
    const result = await this.api.handle(new Request(`https://s.example.com${call.path}`, init), undefined)
    const response = result?.response ?? new Response('{}', { status: 404 })
    if (requestId !== '' && response.ok) this.replies.set(requestId, response.clone())
    return response
  }

  /** Replaces fetch with this server. */
  install(): this {
    resetClientForTests()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!/^\/_\/api\//.test(url)) throw new Error(`unexpected request to ${url}`)
        const headers: Record<string, string> = {}
        new Headers(init.headers).forEach((value, key) => {
          headers[key] = value
        })
        const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
        const call: Call = { method: init.method ?? 'GET', path: url, headers, body }
        this.calls.push(call)
        if (url === '/_/api/csrf') return Response.json({ token: 'synthetic-token' })
        return this.handle(call, { method: call.method, headers: init.headers ?? {}, ...(typeof init.body === 'string' ? { body: init.body } : {}) })
      }),
    )
    return this
  }

  /** The mutations sent, or those whose path (before the query) ends with `suffix`. */
  mutations(suffix?: string): Call[] {
    return this.calls.filter((call) => call.method !== 'GET' && (suffix === undefined || (call.path.split('?')[0] ?? '').endsWith(suffix)))
  }
}
