/**
 * An in-memory stand-in for the Worker's owner API (proto/recall/ui/v1), served by the same shared transcoder the
 * Worker uses, so every request is routed, decoded strictly and answered in the wire JSON profile as in production. It
 * keeps synthetic pages, visits, captured texts, sites, the settings and the status, and answers as the Worker does
 * where the UI depends on it: SearchPages filters by every field (the words in titles, URLs and texts, ignoring case;
 * the range by overlapping visits; the site with its subdomains) in pages of 10 with a reported cap, and refuses a
 * query of lone CJK characters; ListVisits overlaps its range and pages; UpdateSettings needs an explicit mask and
 * refuses a stale etag; RegenerateMachineToken answers a new token once (a repeated request_id without it);
 * ConnectDropboxBackup answers an authorization URL and DisconnectDropboxBackup forgets the connection. Every request
 * must be a same-origin /api path, and a mutation must carry the CSRF header.
 */
import { vi } from 'vitest'
import { updatePaths } from '@ziyixi/proto/field-mask'
import { parseLiteralFilter } from '@ziyixi/proto/filter'
import { HttpTranscoder, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder'
import { create } from '@ziyixi/proto/protobuf'
import { EmptySchema, timestampFromMs, timestampMs } from '@ziyixi/proto/protobuf/wkt'
import { Code, RpcError } from '@ziyixi/proto/rpc-status'
import {
  DocumentSchema,
  FocusSpanSchema,
  PageSchema,
  SearchResultSchema,
  SiteSchema,
  TextSegmentSchema,
  VisitSchema,
  type Document,
  type Page,
  type Site,
  type Visit,
} from '@ziyixi/proto/recall/ui/v1/page_pb'
import {
  ConnectDropboxBackupResponseSchema,
  ListSitesResponseSchema,
  ListVisitsResponseSchema,
  PageType,
  RecallUiService,
  SearchPagesResponseSchema,
  SortOrder,
} from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb'
import {
  DropboxBackupSchema,
  MachineTokenSchema,
  ServiceStatusSchema,
  SettingsSchema,
  type DropboxBackup,
  type MachineToken,
  type ServiceStatus,
  type Settings,
} from '@ziyixi/proto/recall/ui/v1/status_pb'
import { searchable } from '../../../shared/segment.ts'
import { resetClientForTests } from '../api.ts'
import { splitTerms } from '../marks.ts'

/** 14:30 on Friday 9 October 2026 in the tests' zone (Asia/Shanghai, test/setup.ts). */
export const NOW = Date.parse('2026-10-09T06:30:00Z')
export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

/** A local time of the tests' zone: `at('2026-10-09 09:12')`, or with seconds (`09:12:30`). */
export function at(local: string): number {
  return Date.parse(`${local.replace(' ', 'T')}${local.length === 16 ? ':00' : ''}+08:00`)
}

export interface Call {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Record<string, unknown> | null
}

/** A page ID: 32 hex characters from a short name. */
export function pageId(name: string): string {
  return Array.from(name)
    .map((char) => char.charCodeAt(0).toString(16))
    .join('')
    .padEnd(32, '0')
    .slice(0, 32)
}

let uuids = 0

function uuid(): string {
  uuids += 1
  return `00000000-0000-4000-8000-${uuids.toString(16).padStart(12, '0')}`
}

export function page(name: string, init: Partial<Page> = {}): Page {
  const site = init.site ?? 'example.com'
  const made = create(PageSchema, {
    name: `pages/${pageId(name)}`,
    url: `https://${site}/${name}`,
    title: `页面 ${name}`,
    site,
    firstVisitTime: timestampFromMs(at('2026-09-01 10:00')),
    lastVisitTime: timestampFromMs(NOW - HOUR),
    visitCount: 3,
    focusSeconds: 600,
  })
  return Object.assign(made, init)
}

/** A visit to page `name` with focus spans of local times (`['09:00', '09:10:30']` on 9 October, or `2026-10-08 23:50`). */
export function visit(name: string, spans: readonly (readonly [string, string])[], init: Partial<Visit> = {}): Visit {
  const time = (text: string) => at(text.length <= 8 ? `2026-10-09 ${text}` : text)
  const focus = spans.map(([start, end]) => create(FocusSpanSchema, { startTime: timestampFromMs(time(start)), endTime: timestampFromMs(time(end)) }))
  const seconds = spans.reduce((sum, [start, end]) => sum + (time(end) - time(start)) / 1000, 0)
  const site = init.site ?? 'example.com'
  const made = create(VisitSchema, {
    name: `pages/${pageId(name)}/visits/${uuid()}`,
    url: `https://${site}/${name}`,
    title: `页面 ${name}`,
    site,
    deviceLabel: 'MacBook · 工作',
    startTime: focus[0]?.startTime,
    endTime: focus[focus.length - 1]?.endTime,
    focusSeconds: Math.round(seconds),
    focusSpans: focus,
  })
  return Object.assign(made, init)
}

/** A captured text of page `name`. */
export function textOf(name: string, text: string, init: Partial<Document> = {}): Document {
  const made = create(DocumentSchema, {
    name: `pages/${pageId(name)}/documents/${uuid()}`,
    captureTime: timestampFromMs(at('2026-10-09 10:00')),
    title: `页面 ${name}`,
    deviceLabel: 'MacBook · 工作',
    textBytes: new TextEncoder().encode(text).length,
    text,
  })
  return Object.assign(made, init)
}

export function site(host: string, focusSeconds: number): Site {
  return create(SiteSchema, { name: `sites/${host}`, visitCount: 1, focusSeconds })
}

/** One page of `items` after the offset of `token` (the fake's page token is that offset). */
function slice<T>(items: readonly T[], size: number, token: string): { items: T[]; next: string } {
  const start = token === '' ? 0 : Number(token)
  const end = start + size
  return { items: items.slice(start, end), next: end < items.length ? String(end) : '' }
}

const fold = (text: string) => text.normalize('NFKC').toLowerCase()

/** The LocalizedMessage of the reasons the fake answers and the UI shows as they are. */
const LOCALIZED: Readonly<Record<string, string>> = {
  NOT_FOUND: '找不到这一项（可能已被删除）',
  UNAVAILABLE: '服务暂时不可用，请稍后再试',
  INVALID_SETTINGS: '网站格式不对',
  SEARCH_OVER_BUDGET: '今天的搜索额度用完了，明天（UTC 零点后）再搜；时间线和页面照常能看',
}

export class FakeServer {
  readonly calls: Call[] = []
  pages: Page[] = []
  visits: Visit[] = []
  /** The captured texts by their resource name. */
  documents = new Map<string, Document>()
  sites: Site[] = []
  /** SearchPages reports its read bound reached. */
  capped = false
  /** SearchPages answers SEARCH_OVER_BUDGET (today's read budget is spent). */
  overBudget = false
  /** Fields of GetServiceStatus that a test sets (the rest as below). */
  status: Partial<ServiceStatus> = {}
  /** GetServiceStatus answers UNAVAILABLE this many more times. */
  statusFailures = 0
  /** The Dropbox backup (ServiceStatus.dropbox_backup): connected and caught up unless a test sets it. */
  backup: DropboxBackup = create(DropboxBackupSchema, {
    name: 'dropboxBackup',
    appKey: 'syntheticappkey1',
    connected: true,
    accountDisplayName: '合成 Dropbox',
    connectTime: timestampFromMs(at('2026-10-01 10:00')),
    lastUploadTime: timestampFromMs(NOW - 20 * MINUTE),
    syncedSeq: 10432,
  })
  /** The machine tokens (ServiceStatus.machine_tokens): an ingest token made a week ago, no export token. */
  tokens: MachineToken[] = [
    create(MachineTokenSchema, { name: 'machineTokens/ingest', createTime: timestampFromMs(NOW - 7 * 24 * HOUR) }),
    create(MachineTokenSchema, { name: 'machineTokens/export' }),
  ]
  /** The tokens RegenerateMachineToken made, by request_id (a repeated request answers without the token). */
  private readonly made = new Map<string, MachineToken>()
  settings: Settings = create(SettingsSchema, {
    name: 'settings',
    denylistPatterns: ['bank.example'],
    builtinDenylistPatterns: ['ziyixi.science'],
    builtinSiteOnlyPatterns: ['mail.example', 'chat.example'],
    etag: 's1',
  })
  private readonly transcoder: HttpTranscoder<ShapeOf<typeof RecallUiService>, null>

  /** A page with its captured text (Page.latest_document names it). */
  addText(item: Page, document: Document): void {
    item.latestDocument = document.name
    item.latestCaptureTime = document.captureTime
    item.documentCount = Math.max(1, item.documentCount)
    this.documents.set(document.name, document)
  }

  constructor() {
    const notFound = (): never => {
      throw new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'no such resource')
    }
    const handlers: ServiceHandlers<ShapeOf<typeof RecallUiService>, null> = {
      getPage: (request) => Promise.resolve(this.pages.find((item) => item.name === request.name) ?? notFound()),
      deletePage: (request) => {
        if (!this.pages.some((item) => item.name === request.name)) notFound()
        this.pages = this.pages.filter((item) => item.name !== request.name)
        this.visits = this.visits.filter((item) => !item.name.startsWith(`${request.name}/`))
        return Promise.resolve(create(EmptySchema, {}))
      },
      // As the Worker: every term must occur (ignoring case) in the title, URL or text; a range keeps the pages with an
      // overlapping visit and counts only those visits; ten a page, at most 200.
      searchPages: (request) => {
        if (this.overBudget) throw new RpcError(Code.RESOURCE_EXHAUSTED, 'SEARCH_OVER_BUDGET', "today's read budget is used up")
        const terms = splitTerms(request.query)
        const kept = terms.filter(searchable)
        if (terms.length > 0 && kept.length === 0) throw new RpcError(Code.INVALID_ARGUMENT, 'QUERY_NOT_SEARCHABLE', 'no searchable term')
        if (request.sortOrder === SortOrder.RELEVANCE && kept.length === 0) throw new RpcError(Code.INVALID_ARGUMENT, 'BAD_REQUEST', 'relevance needs a query')
        const start = request.startTime === undefined ? -Infinity : timestampMs(request.startTime)
        const end = request.endTime === undefined ? Infinity : timestampMs(request.endTime)
        const ranged = request.startTime !== undefined || request.endTime !== undefined
        const rows = this.pages.flatMap((item) => {
          const text = item.latestDocument === '' ? '' : (this.documents.get(item.latestDocument)?.text ?? '')
          const haystack = fold(`${item.title} ${item.url} ${text}`)
          if (!kept.every((term) => haystack.includes(fold(term)))) return []
          if (request.site !== '' && item.site !== request.site && !item.site.endsWith(`.${request.site}`)) return []
          if (request.pageType === PageType.READ && item.documentCount === 0) return []
          const own = this.visits.filter((one) => one.name.startsWith(`${item.name}/`) && timestampMs(one.startTime!) < end && timestampMs(one.endTime!) > start)
          if (ranged && own.length === 0) return []
          const focus = ranged ? own.reduce((sum, one) => sum + one.focusSeconds, 0) : item.focusSeconds
          if (focus < request.minFocusSeconds) return []
          const last = ranged ? Math.max(...own.map((one) => timestampMs(one.endTime!))) : timestampMs(item.lastVisitTime!)
          const word = kept[0] === undefined ? undefined : fold(kept[0]).split(/\s+/)[0]
          const found = word === undefined ? -1 : fold(text).indexOf(word)
          const snippet =
            word === undefined || found === -1
              ? []
              : [
                  create(TextSegmentSchema, { text: `…${text.slice(Math.max(0, found - 10), found)}` }),
                  create(TextSegmentSchema, { text: text.slice(found, found + word.length), highlighted: true }),
                  create(TextSegmentSchema, { text: `${text.slice(found + word.length, found + word.length + 20)}…` }),
                ]
          return [{ last, result: create(SearchResultSchema, { page: item.name, url: item.url, title: item.title, site: item.site, lastVisitTime: timestampFromMs(last), visitCount: ranged ? own.length : item.visitCount, focusSeconds: focus, hasText: item.documentCount > 0, snippet }) }]
        })
        rows.sort((a, b) => b.last - a.last)
        const { items, next } = slice(rows.map((row) => row.result).slice(0, 200), 10, request.pageToken)
        return Promise.resolve(create(SearchPagesResponseSchema, { results: items, nextPageToken: next, candidatesCapped: this.capped }))
      },
      getVisit: (request) => Promise.resolve(this.visits.find((item) => item.name === request.name) ?? notFound()),
      listVisits: (request) => {
        const start = request.startTime === undefined ? -Infinity : timestampMs(request.startTime)
        const end = request.endTime === undefined ? Infinity : timestampMs(request.endTime)
        const own = this.visits
          .filter((item) => request.parent === 'pages/-' || item.name.startsWith(`${request.parent}/`))
          .filter((item) => timestampMs(item.startTime!) < end && timestampMs(item.endTime!) > start)
          .sort((a, b) => timestampMs(a.startTime!) - timestampMs(b.startTime!))
        if (request.orderBy === 'start_time desc') own.reverse()
        const { items, next } = slice(own, request.pageSize === 0 ? 200 : Math.min(request.pageSize, 500), request.pageToken)
        return Promise.resolve(create(ListVisitsResponseSchema, { visits: items, nextPageToken: next }))
      },
      getDocument: (request) => Promise.resolve(this.documents.get(request.name) ?? notFound()),
      getSite: (request) => Promise.resolve(this.sites.find((item) => item.name === request.name) ?? notFound()),
      // Most focused first; a filter is one literal, the hosts it begins.
      listSites: (request) => {
        const prefix = parseLiteralFilter(request.filter, 1)[0] ?? ''
        const sorted = [...this.sites].filter((item) => item.name.slice('sites/'.length).startsWith(prefix)).sort((a, b) => b.focusSeconds - a.focusSeconds)
        const { items, next } = slice(sorted, request.pageSize === 0 ? 100 : Math.min(request.pageSize, 200), request.pageToken)
        return Promise.resolve(create(ListSitesResponseSchema, { sites: items, nextPageToken: next }))
      },
      getSettings: () => Promise.resolve(this.settings),
      // As the Worker: an explicit mask, only the two lists writable, a stale etag refused with the current settings.
      updateSettings: (request) => {
        const paths = updatePaths(request.updateMask)
        if (paths === '*' || request.settings === undefined) throw new RpcError(Code.INVALID_ARGUMENT, 'BAD_REQUEST', 'update_mask must name the fields')
        if (request.settings.etag !== '' && request.settings.etag !== this.settings.etag) throw new RpcError(Code.ABORTED, 'ETAG_MISMATCH', 'stale etag')
        const lists = { denylistPatterns: request.settings.denylistPatterns, siteOnlyPatterns: request.settings.siteOnlyPatterns }
        const changed = (['denylistPatterns', 'siteOnlyPatterns'] as const).filter((field) => paths.includes(field === 'denylistPatterns' ? 'denylist_patterns' : 'site_only_patterns'))
        for (const field of changed) {
          if (lists[field].some((pattern) => !/^[a-z0-9._-]+(\/[a-z0-9._-]+)*$/.test(pattern))) throw new RpcError(Code.INVALID_ARGUMENT, 'INVALID_SETTINGS', 'pattern')
        }
        if (changed.length > 0) {
          const next: Partial<Settings> = { etag: `${this.settings.etag}+` }
          for (const field of changed) next[field] = lists[field]
          this.settings = Object.assign(create(SettingsSchema), this.settings, next)
        }
        return Promise.resolve(this.settings)
      },
      getServiceStatus: () => {
        if (this.statusFailures > 0) {
          this.statusFailures -= 1
          throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'try later')
        }
        return Promise.resolve(
          Object.assign(
            create(ServiceStatusSchema, {
              name: 'serviceStatus',
              devices: [{ deviceId: '00000000-0000-4000-8000-0000000000aa', label: 'MacBook · 工作', extensionVersion: '2026.1009.1200', firstSeenTime: timestampFromMs(at('2026-09-01 10:00')), lastHeartbeatTime: timestampFromMs(NOW - 3 * MINUTE) }],
              headSeq: 10432,
              firstVisitTime: timestampFromMs(at('2026-09-01 10:00')),
              pageCount: 1234,
              visitCount: 5678,
              documentCount: 345,
              storageUsedMib: 120,
              storageBudgetMib: 900,
              blobStoredMib: 40,
              rowsWrittenTodayCount: 4210,
              dailyRowBudget: 20000,
              rowsReadTodayCount: 52000,
              dailyReadBudget: 1500000,
              build: '0123456789abcdef',
              dropboxBackup: this.backup,
              machineTokens: this.tokens,
            }),
            this.status,
          ),
        )
      },
      connectDropboxBackup: (request) => {
        if (!/^[a-z0-9]{8,32}$/.test(request.appKey)) throw new RpcError(Code.INVALID_ARGUMENT, 'INVALID_APP_KEY', 'app key')
        return Promise.resolve(create(ConnectDropboxBackupResponseSchema, { authorizeUrl: `/oauth2/authorize?client_id=${request.appKey}&state=s` }))
      },
      disconnectDropboxBackup: () => {
        this.backup = create(DropboxBackupSchema, { name: 'dropboxBackup', appKey: this.backup.appKey, syncedSeq: this.backup.syncedSeq, lastUploadTime: this.backup.lastUploadTime })
        return Promise.resolve(this.backup)
      },
      regenerateMachineToken: (request) => {
        const route = request.name.split('/')[1] ?? ''
        if (!['ingest', 'export'].includes(route)) notFound()
        const before = this.made.get(request.requestId)
        if (before !== undefined) return Promise.resolve(create(MachineTokenSchema, { ...before, token: '' }))
        const previous = this.tokens.find((item) => item.name === request.name)
        const token = create(MachineTokenSchema, {
          name: request.name,
          token: `recall_${route}_${'T'.repeat(43)}`,
          createTime: timestampFromMs(NOW),
          ...(previous?.createTime !== undefined && !request.revokePrevious ? { previousExpireTime: timestampFromMs(NOW + 24 * HOUR) } : {}),
        })
        this.made.set(request.requestId, token)
        this.tokens = [...this.tokens.filter((item) => item.name !== request.name), create(MachineTokenSchema, { ...token, token: '' })]
        return Promise.resolve(token)
      },
      deleteMachineToken: (request) => {
        const current = this.tokens.find((item) => item.name === request.name)
        if (current?.createTime === undefined) notFound()
        this.tokens = [...this.tokens.filter((item) => item.name !== request.name), create(MachineTokenSchema, { name: request.name })]
        return Promise.resolve(create(EmptySchema, {}))
      },
    }
    this.transcoder = new HttpTranscoder(RecallUiService, handlers, {
      domain: 'recall.ziyixi.science',
      maxBodyBytes: 65536,
      authorize: () => undefined,
      // The Worker's copy for the reasons the UI shows as they are (worker/src/reasons.ts).
      localize: (reason) => {
        const message = LOCALIZED[reason]
        return message === undefined ? undefined : { locale: 'zh-CN', message }
      },
    })
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
      const request = new Request(`https://recall.ziyixi.science${input}`, { method: init.method ?? 'GET', headers, ...(typeof init.body === 'string' ? { body: init.body } : {}) })
      const result = await this.transcoder.handle(request, null, 'req-1')
      return result?.response ?? new Response('{}', { status: 404 })
    })
  }

  /** The calls to one rpc path prefix (`/api/v1/pages:search`), as URLs with their query parameters. */
  searches(prefix: string): URL[] {
    return this.calls.filter((call) => call.path.startsWith(prefix)).map((call) => new URL(call.path, 'https://recall.ziyixi.science'))
  }
}

/** Waits until the page's pending promises settle. */
export async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
