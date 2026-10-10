/**
 * The owner API (proto/recall/ui/v1): one handler per rpc of RecallUiService, served by the shared transcoder inside
 * RecallState (state.ts), after the Worker authenticated the owner and checked Origin and CSRF (http.ts). A handler
 * checks what the IDL cannot (limits.ts), reads or writes the object's SQLite (store.ts), reads texts from R2 and maps
 * rows to messages (model.ts). A mutation and its AIP-155 request log entry are one transaction.
 *
 * Errors are RpcErrors with a reason of recall.ui.v1.ErrorReason or common.errors.v1.CommonReason (reasons.ts). Only a
 * failed R2 read is UNAVAILABLE; anything else unexpected is INTERNAL.
 */
import { FieldMaskError, updatePaths } from '@ziyixi/proto/field-mask';
import { FilterError, parseLiteralFilter } from '@ziyixi/proto/filter';
import type { ServiceHandlers, ShapeOf } from '@ziyixi/proto/http-transcoder';
import { decodePageToken, encodePageToken, PageTokenError, type PageParameters } from '@ziyixi/proto/page-token';
import { create, type DescMessage, type JsonValue, type MessageShape } from '@ziyixi/proto/protobuf';
import { EmptySchema, timestampMs, type Timestamp } from '@ziyixi/proto/protobuf/wkt';
import { SearchResultSchema, TextSegmentSchema } from '@ziyixi/proto/recall/ui/v1/page_pb';
import {
  ListSitesResponseSchema,
  ListVisitsResponseSchema,
  PageType,
  SearchPagesResponseSchema,
  SortOrder,
  type RecallUiService,
} from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb';
import { SettingsSchema, type Settings } from '@ziyixi/proto/recall/ui/v1/status_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { builtinNoTextPatterns, OWNER_PATTERNS_MAX, parsePattern, patternText, SITE_ONLY_PATTERNS } from '../../shared/denylist.ts';
import { readText } from './blobs.ts';
import {
  DAILY_READ_BUDGET,
  MIN_FOCUS_MAX_SECONDS,
  SEARCH_MAX_RESULTS,
  SEARCH_PAGE_SIZE,
  SITE_MAX_CHARS,
  SITE_PAGE_DEFAULT,
  SITE_PAGE_MAX,
  VISIT_PAGE_DEFAULT,
  VISIT_PAGE_MAX,
} from './limits.ts';
import { documentMessage, pageMessage, siteMessage, time, visitMessage } from './model.ts';
import { recallError, type Reason } from './reasons.ts';
import { deletePage, deletePageBlobs } from './retention.ts';
import { QueryError, readQuery, search, snippetOf, type ResultRow, type SearchCache, type SearchInput } from './search.ts';
import { readDenylist, writeDenylist, type Denylist } from './settings.ts';
import { serviceStatus } from './status.ts';
import { hostOfKey, utcDay, type DocumentRow, type PageRow, type SiteRow, type Store } from './store.ts';
import { getVisit, listVisits } from './timeline.ts';

/** What every handler gets from RecallState. */
export interface ApiContext {
  readonly store: Store;
  readonly bucket: R2Bucket;
  /** The request's time (epoch milliseconds). */
  readonly now: number;
  readonly build: string;
  readonly transact: <T>(fn: () => T) => T;
  /** Brings the alarm forward (a deletion's purge). */
  readonly wake: () => Promise<void>;
  /** Answered searches, for their next pages. */
  readonly searches: SearchCache;
}

/** The Settings fields an update mask may name; only denylist_patterns and site_only_patterns are writable. */
const SETTINGS_FIELDS = new Set(['name', 'denylist_patterns', 'builtin_denylist_patterns', 'etag', 'builtin_site_only_patterns', 'site_only_patterns']);
const PAGE_ID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A host as the archive's Site format has it (`_` included). */
const HOST = /^[a-z0-9_]([a-z0-9._-]{0,251}[a-z0-9_])?$/;

function bad(message: string): never {
  throw recallError('BAD_REQUEST', [], message);
}

function fail(reason: Reason): never {
  throw recallError(reason);
}

/** The IDs of a resource name `pages/{page}[/<collection>/{id}]`, or BAD_REQUEST. */
function pageName(name: string): string {
  const id = name.startsWith('pages/') ? name.slice('pages/'.length) : '';
  if (!PAGE_ID.test(id)) bad('not a page name');
  return id;
}

function childName(name: string, collection: 'visits' | 'documents'): { readonly page: string; readonly id: string } {
  const parts = name.split('/');
  if (parts.length !== 4 || parts[0] !== 'pages' || parts[2] !== collection || !PAGE_ID.test(parts[1] ?? '') || !UUID.test(parts[3] ?? '')) bad(`not a ${collection} name`);
  return { page: parts[1] ?? '', id: parts[3] ?? '' };
}

/** page_size (AIP-158): 0 means `fallback`, a larger value than `max` is read as `max`, a negative one is BAD_REQUEST. */
function pageSize(value: number, fallback: number, max: number): number {
  if (value < 0) bad('page_size is negative');
  return value === 0 ? fallback : Math.min(value, max);
}

/** A page token's cursor, checked by `read`; BAD_REQUEST for a token of other parameters or a cursor it refuses. */
function cursorOf<T>(token: string, parameters: PageParameters, read: (cursor: JsonValue) => T | null): T | null {
  if (token === '') return null;
  try {
    return read(decodePageToken(token, parameters)) ?? bad('page_token is not valid');
  } catch (error) {
    if (error instanceof PageTokenError) bad('page_token is not valid');
    throw error;
  }
}

/** A time range [start, end) of a request: each bound optional, start before end. */
function timeRange(startTime: Timestamp | undefined, endTime: Timestamp | undefined): { readonly start: number | null; readonly end: number | null } {
  const start = startTime === undefined ? null : timestampMs(startTime);
  const end = endTime === undefined ? null : timestampMs(endTime);
  if (start !== null && end !== null && start >= end) bad('end_time must be after start_time');
  return { start, end };
}

// ---- AIP-155 ---------------------------------------------------------------------------------------------------------

/** A mutation once per request_id: the mutation, its log entry and its rows' charge are one transaction. */
function once<Desc extends DescMessage>(ctx: ApiContext, requestId: string, method: string, resource: string, schema: Desc, run: () => MessageShape<Desc>): MessageShape<Desc> {
  return ctx.transact(() => {
    if (requestId !== '') {
      const logged = ctx.store.request(requestId, ctx.now);
      if (logged !== undefined) {
        if (logged.method !== method || logged.resource !== resource) bad('the request_id was used for another request (another method or resource)');
        return fromWire(schema, JSON.parse(logged.answer) as unknown).message;
      }
    }
    const answer = run();
    if (requestId !== '') ctx.store.putRequest(requestId, method, resource, JSON.stringify(toWire(schema, answer)), ctx.now);
    ctx.store.chargeRows(utcDay(ctx.now));
    return answer;
  });
}

// ---- search -----------------------------------------------------------------------------------------------------------

/** The site filter: a host in lower case, a leading `www.` ignored; '' for none. */
function siteFilter(value: string): string | null {
  const site = value.trim().toLowerCase().replace(/^www\./, '');
  if (site === '') return null;
  if (site.length > SITE_MAX_CHARS || !HOST.test(site)) bad('site is not a host name');
  return site;
}

/** Snippets of the results with a text, read from R2 in parallel; a text R2 cannot give is left without one. */
async function snippets(ctx: ApiContext, rows: readonly ResultRow[], terms: readonly string[]): Promise<Map<number, ReturnType<typeof snippetOf>>> {
  const out = new Map<number, ReturnType<typeof snippetOf>>();
  if (terms.length === 0) return out;
  await Promise.all(
    rows.map(async (row) => {
      if (row.document_count === 0 || row.latest_document === null) return;
      const document = ctx.store.one<{ blob_path: string }>(`SELECT blob_path FROM documents WHERE id = ?`, row.latest_document);
      if (document === undefined) return;
      try {
        const text = await readText(ctx.bucket, document.blob_path);
        if (text !== null) out.set(row.rowid, snippetOf(text, terms));
      } catch {
        // R2 failed for this text: the result still shows, without its snippet.
      }
    }),
  );
  return out;
}

// ---- settings ---------------------------------------------------------------------------------------------------------

function settingsMessage(denylist: Denylist): Settings {
  return create(SettingsSchema, {
    name: 'settings',
    denylistPatterns: [...denylist.patterns],
    builtinDenylistPatterns: builtinNoTextPatterns(),
    etag: denylist.etag,
    builtinSiteOnlyPatterns: [...SITE_ONLY_PATTERNS],
    siteOnlyPatterns: [...denylist.siteOnly],
  });
}

/** One of the owner's lists, canonical (trimmed, lower case, without a trailing `/`) and without repeats. */
function checkPatterns(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const pattern = parsePattern(value.trim().toLowerCase());
    if (pattern === null) fail('INVALID_SETTINGS');
    const text = patternText(pattern);
    if (!out.includes(text)) out.push(text);
  }
  if (out.length > OWNER_PATTERNS_MAX) fail('LIMIT_REACHED');
  return out;
}

// ---- the handlers -----------------------------------------------------------------------------------------------------

export const handlers: ServiceHandlers<ShapeOf<typeof RecallUiService>, ApiContext> = {
  getPage(request, ctx) {
    const row = ctx.store.one<PageRow>(`SELECT * FROM pages WHERE id = ?`, pageName(request.name)) ?? fail('NOT_FOUND');
    return Promise.resolve(pageMessage(row));
  },

  async deletePage(request, ctx) {
    const id = pageName(request.name);
    const deleted: { rowid: number | null } = { rowid: null };
    const answer = once(ctx, request.requestId, 'DeletePage', request.name, EmptySchema, () => {
      deleted.rowid = deletePage(ctx.store, id, ctx.now) ?? fail('NOT_FOUND');
      return create(EmptySchema);
    });
    ctx.searches.clear();
    // The texts leave R2 at once (the blob route reads R2 without asking the object); the alarm removes the rows.
    if (deleted.rowid !== null) await deletePageBlobs(ctx.store, ctx.bucket, deleted.rowid);
    await ctx.wake();
    return answer;
  },

  async searchPages(request, ctx) {
    const size = pageSize(request.pageSize, SEARCH_PAGE_SIZE, SEARCH_PAGE_SIZE);
    let query;
    try {
      query = readQuery(request.query);
    } catch (error) {
      if (error instanceof QueryError) throw recallError(error.reason, [], error.message);
      throw error;
    }
    const { start, end } = timeRange(request.startTime, request.endTime);
    const site = siteFilter(request.site);
    if (request.minFocusSeconds < 0 || request.minFocusSeconds > MIN_FOCUS_MAX_SECONDS) bad('min_focus_seconds is out of range');
    if (request.sortOrder === SortOrder.RELEVANCE && query.match === null) bad('sorting by relevance needs a query');
    const sort = request.sortOrder === SortOrder.RECENT || query.match === null ? 'recent' : 'relevance';
    const readOnly = request.pageType === PageType.READ;
    const parameters = { query: request.query, start: start ?? '', end: end ?? '', site: site ?? '', read: readOnly, focus: request.minFocusSeconds, sort };
    const offset = cursorOf(request.pageToken, parameters, (cursor) => (typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor > 0 && cursor < SEARCH_MAX_RESULTS ? cursor : null)) ?? 0;
    // A next page takes the results its first page found; a first page (or one the object no longer holds) searches.
    const key = JSON.stringify(parameters);
    let found = offset === 0 ? undefined : ctx.searches.get(key, ctx.now);
    if (found === undefined) {
      if (ctx.store.usage(utcDay(ctx.now)).rows_read >= DAILY_READ_BUDGET) fail('SEARCH_OVER_BUDGET');
      const input: SearchInput = { query, start, end, site, readOnly, minFocusSeconds: request.minFocusSeconds, sort };
      found = search(ctx.store, input);
      ctx.searches.put(key, found, ctx.now);
    }
    const upTo = Math.min(offset + size, SEARCH_MAX_RESULTS);
    const page = found.rows.slice(offset, upTo);
    const more = found.rows.length > upTo && upTo < SEARCH_MAX_RESULTS;
    const texts = await snippets(ctx, page, query.terms);
    return create(SearchPagesResponseSchema, {
      results: page.map((row) =>
        create(SearchResultSchema, {
          page: `pages/${row.id}`,
          url: row.url,
          title: row.title,
          site: hostOfKey(row.host_key),
          lastVisitTime: time(row.last_ms),
          visitCount: row.visit_count,
          focusSeconds: row.focus_seconds,
          hasText: row.document_count > 0,
          snippet: (texts.get(row.rowid) ?? []).map((part) => create(TextSegmentSchema, part)),
        }),
      ),
      nextPageToken: more ? encodePageToken(upTo, parameters) : '',
      candidatesCapped: found.capped,
    });
  },

  getVisit(request, ctx) {
    const { page, id } = childName(request.name, 'visits');
    const row = getVisit(ctx.store, page, id) ?? fail('NOT_FOUND');
    return Promise.resolve(visitMessage(row));
  },

  listVisits(request, ctx) {
    let pageRowid: number | null = null;
    if (request.parent !== 'pages/-') {
      const page = ctx.store.one<{ rowid: number }>(`SELECT rowid FROM pages WHERE id = ?`, pageName(request.parent)) ?? fail('NOT_FOUND');
      pageRowid = page.rowid;
    }
    const size = pageSize(request.pageSize, VISIT_PAGE_DEFAULT, VISIT_PAGE_MAX);
    const order = request.orderBy.trim().replace(/\s+/g, ' ');
    if (!['', 'start_time', 'start_time desc'].includes(order)) bad('order_by is `start_time` or `start_time desc`');
    const descending = order === 'start_time desc';
    const { start, end } = timeRange(request.startTime, request.endTime);
    const parameters = { parent: request.parent, order, start: start ?? '', end: end ?? '' };
    const after = cursorOf(request.pageToken, parameters, (cursor) =>
      Array.isArray(cursor) && cursor.length === 2 && typeof cursor[0] === 'number' && typeof cursor[1] === 'string' && UUID.test(cursor[1]) ? ([cursor[0], cursor[1]] as const) : null,
    );
    const rows = listVisits(ctx.store, { pageRowid, start, end, descending, after, size });
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return Promise.resolve(
      create(ListVisitsResponseSchema, {
        visits: page.map(visitMessage),
        nextPageToken: rows.length > size && last !== undefined ? encodePageToken([last.start_ms, last.id], parameters) : '',
      }),
    );
  },

  async getDocument(request, ctx) {
    const { page, id } = childName(request.name, 'documents');
    const row =
      ctx.store.one<DocumentRow>(`SELECT d.* FROM documents d JOIN pages p ON p.rowid = d.page_rowid WHERE d.id = ? AND p.id = ?`, id, page) ?? fail('NOT_FOUND');
    let text: string | null;
    try {
      text = await readText(ctx.bucket, row.blob_path);
    } catch {
      throw recallError('UNAVAILABLE');
    }
    if (text === null) {
      // A live record whose object is gone: a wrong binding or a lost object, never a retry's matter.
      ctx.transact(() => {
        ctx.store.pushError('blob_missing');
      });
      console.log(JSON.stringify({ event: 'blob_missing', document: id }));
      throw recallError('INTERNAL');
    }
    return documentMessage(row, page, text);
  },

  getSite(request, ctx) {
    const host = request.name.startsWith('sites/') ? request.name.slice('sites/'.length) : '';
    if (!HOST.test(host)) bad('not a site name');
    const row = ctx.store.one<SiteRow>(`SELECT * FROM sites WHERE host = ?`, host) ?? fail('NOT_FOUND');
    return Promise.resolve(siteMessage(row));
  },

  listSites(request, ctx) {
    const size = pageSize(request.pageSize, SITE_PAGE_DEFAULT, SITE_PAGE_MAX);
    let literals: string[];
    try {
      literals = parseLiteralFilter(request.filter, 1);
    } catch (error) {
      if (error instanceof FilterError) bad('filter is one quoted host prefix');
      throw error;
    }
    const prefix = (literals[0] ?? '').trim().toLowerCase().replace(/^www\./, '');
    const after = cursorOf(request.pageToken, { filter: request.filter }, (cursor) =>
      Array.isArray(cursor) && cursor.length === 2 && typeof cursor[0] === 'number' && typeof cursor[1] === 'string' ? ([cursor[0], cursor[1]] as const) : null,
    );
    const conditions = [`substr(host, 1, 1) <> '['`];
    const params: (string | number)[] = [];
    if (prefix !== '') {
      // `~` sorts after every character of a host name.
      conditions.push('host >= ? AND host < ?');
      params.push(prefix, `${prefix}~`);
    }
    if (after !== null) {
      conditions.push('(focus_seconds < ? OR (focus_seconds = ? AND host < ?))');
      params.push(after[0], after[0], after[1]);
    }
    const rows = ctx.store.all<SiteRow>(`SELECT * FROM sites WHERE ${conditions.join(' AND ')} ORDER BY focus_seconds DESC, host DESC LIMIT ?`, ...params, size + 1);
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return Promise.resolve(
      create(ListSitesResponseSchema, {
        sites: page.map(siteMessage),
        nextPageToken: rows.length > size && last !== undefined ? encodePageToken([last.focus_seconds, last.host], { filter: request.filter }) : '',
      }),
    );
  },

  getSettings(request, ctx) {
    if (request.name !== 'settings') fail('NOT_FOUND');
    return Promise.resolve(settingsMessage(readDenylist(ctx.store)));
  },

  updateSettings(request, ctx) {
    const input = request.settings ?? bad('settings is required');
    if (input.name !== '' && input.name !== 'settings') fail('NOT_FOUND');
    let paths: '*' | readonly string[];
    try {
      paths = updatePaths(request.updateMask);
    } catch (error) {
      if (error instanceof FieldMaskError) bad('update_mask is not valid');
      throw error;
    }
    // An explicit mask only: a client that leaves the list out must never empty the denylist by accident.
    if (paths === '*') bad('update_mask must name the fields to change');
    // The identifier, the etag and the output-only lists change nothing (AIP-134); any other name is a client's bug.
    for (const path of paths) if (!SETTINGS_FIELDS.has(path)) bad('update_mask names an unknown field');
    const patterns = paths.includes('denylist_patterns') ? checkPatterns(input.denylistPatterns) : undefined;
    const siteOnly = paths.includes('site_only_patterns') ? checkPatterns(input.siteOnlyPatterns) : undefined;
    return Promise.resolve(
      once(ctx, request.requestId, 'UpdateSettings', 'settings', SettingsSchema, () => {
        const current = readDenylist(ctx.store);
        if (input.etag !== '' && input.etag !== current.etag) throw recallError('ETAG_MISMATCH', [{ schema: SettingsSchema, message: settingsMessage(current) }]);
        if (patterns === undefined && siteOnly === undefined) return settingsMessage(current);
        // The two lists hold at most OWNER_PATTERNS_MAX patterns together.
        if ((patterns ?? current.patterns).length + (siteOnly ?? current.siteOnly).length > OWNER_PATTERNS_MAX) fail('LIMIT_REACHED');
        return settingsMessage(writeDenylist(ctx.store, { ...(patterns === undefined ? {} : { patterns }), ...(siteOnly === undefined ? {} : { siteOnly }) }, ctx.now));
      }),
    );
  },

  getServiceStatus(request, ctx) {
    if (request.name !== 'serviceStatus') fail('NOT_FOUND');
    return Promise.resolve(serviceStatus(ctx.store, ctx.now, ctx.build));
  },
};
