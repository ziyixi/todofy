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
  ConnectDropboxBackupResponseSchema,
  ListDocumentsResponseSchema,
  ListSitesResponseSchema,
  ListVisitsResponseSchema,
  PageType,
  SearchPagesResponseSchema,
  SortOrder,
  type RecallUiService,
} from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb';
import { DropboxBackupSchema, MachineTokenSchema, SettingsSchema, type Settings } from '@ziyixi/proto/recall/ui/v1/status_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { builtinNoTextPatterns, OWNER_PATTERNS_MAX, parsePattern, patternText, SITE_ONLY_PATTERNS } from '../../shared/denylist.ts';
import type { DayBlob } from './archive.ts';
import { DOCUMENT_MAX_BYTES } from '../../shared/url.ts';
import { base64Of } from './screenshot.ts';
import { APP_KEY, backupMessage, startConnect } from './backup.ts';
import { blobKey, readBounded, readText, sha256Hex } from './blobs.ts';
import { DropboxError, pkceChallenge, randomText, type DropboxEndpoints } from './dropbox.ts';
import {
  DAILY_READ_BUDGET,
  DROPBOX_CONNECT_MS,
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
import { readDenylist, readRetention, validRetention, writeSettings, type Denylist } from './settings.ts';
import { serviceStatus } from './status.ts';
import { hostOfKey, utcDay, type DocumentRow, type PageRow, type SiteRow, type Store } from './store.ts';
import { getVisit, listVisits } from './timeline.ts';
import { addNamedToken, deleteNamedToken, deleteToken, namedTokenId, newToken, storeToken, tokenDigest, tokenMessage, tokenRoute, type TokenRoute } from './tokens.ts';

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
  /** The Dropbox backup's connection: Dropbox's endpoints, recall's host (null: not configured), the disconnection. */
  readonly dropbox: { readonly endpoints: DropboxEndpoints; readonly host: string | null; readonly disconnect: () => Promise<void> };
  /** Whether a Worker secret holds a digest of each route's token too. */
  readonly readArchive: (blob: DayBlob) => Promise<Uint8Array>;
  readonly secretTokens: Readonly<Record<TokenRoute, boolean>>;
}

/** The Settings fields an update mask may name; denylist_patterns, site_only_patterns and text_retention_days are writable. */
const SETTINGS_FIELDS = new Set(['name', 'denylist_patterns', 'builtin_denylist_patterns', 'etag', 'builtin_site_only_patterns', 'site_only_patterns', 'text_retention_days']);
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

/** Whether a request_id was answered already (within REQUEST_ID_TTL_MS): `once` then answers it again. */
function answered(ctx: ApiContext, requestId: string): boolean {
  return requestId !== '' && ctx.store.request(requestId, ctx.now) !== undefined;
}

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

/**
 * Snippets of the results with a text, read from R2 in parallel; a text R2 cannot give, or the retention window moved
 * to the archive alone, is left without one.
 */
async function snippets(ctx: ApiContext, rows: readonly ResultRow[], terms: readonly string[]): Promise<Map<number, ReturnType<typeof snippetOf>>> {
  const out = new Map<number, ReturnType<typeof snippetOf>>();
  if (terms.length === 0) return out;
  await Promise.all(
    rows.map(async (row) => {
      if (row.document_count === 0 || row.latest_document === null) return;
      const document = ctx.store.one<{ blob_path: string; archived_ms: number | null }>(`SELECT blob_path, archived_ms FROM documents WHERE id = ?`, row.latest_document);
      if (document === undefined || document.archived_ms !== null) return;
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

/** Reads only a record's fixed blob, from R2 or the already confirmed Dropbox archive. */
async function readContent(ctx: ApiContext, blob: DayBlob, archived: boolean): Promise<Uint8Array> {
  if (archived) return ctx.readArchive(blob);
  let object: R2ObjectBody | null;
  try { object = await ctx.bucket.get(blobKey(blob.path)); } catch { throw new DropboxError('r2_unavailable'); }
  if (object === null) return ctx.readArchive(blob);
  let bytes: Uint8Array;
  try { bytes = await readBounded(object.body, blob.size); } catch { throw new DropboxError('blob_corrupt'); }
  if (bytes.length !== blob.size || await sha256Hex(bytes) !== blob.sha256) throw new DropboxError('blob_corrupt');
  return bytes;
}

function contentFailure(error: unknown): string {
  return error instanceof DropboxError ? error.code : 'blob_corrupt';
}

// ---- settings ---------------------------------------------------------------------------------------------------------

function settingsMessage(denylist: Denylist, retentionDays: number | null): Settings {
  return create(SettingsSchema, {
    name: 'settings',
    denylistPatterns: [...denylist.patterns],
    builtinDenylistPatterns: builtinNoTextPatterns(),
    etag: denylist.etag,
    builtinSiteOnlyPatterns: [...SITE_ONLY_PATTERNS],
    siteOnlyPatterns: [...denylist.siteOnly],
    ...(retentionDays === null ? {} : { textRetentionDays: retentionDays }),
  });
}

/** The stored settings' message. */
function currentSettings(store: Store): Settings {
  return settingsMessage(readDenylist(store), readRetention(store));
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
    const deviceId = request.deviceId === '' ? null : request.deviceId;
    if (deviceId !== null && !UUID.test(deviceId)) bad('device_id is not a lower-case UUID');
    const parameters = { parent: request.parent, order, start: start ?? '', end: end ?? '', device: deviceId ?? '' };
    const after = cursorOf(request.pageToken, parameters, (cursor) =>
      Array.isArray(cursor) && cursor.length === 2 && typeof cursor[0] === 'number' && typeof cursor[1] === 'string' && UUID.test(cursor[1]) ? ([cursor[0], cursor[1]] as const) : null,
    );
    const rows = listVisits(ctx.store, { pageRowid, deviceId, start, end, descending, after, size });
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return Promise.resolve(
      create(ListVisitsResponseSchema, {
        visits: page.map(visitMessage),
        nextPageToken: rows.length > size && last !== undefined ? encodePageToken([last.start_ms, last.id], parameters) : '',
      }),
    );
  },

  listDocuments(request, ctx) {
    const parent = pageName(request.parent);
    const page = ctx.store.one<{ rowid: number }>(`SELECT rowid FROM pages WHERE id = ?`, parent) ?? fail('NOT_FOUND');
    const size = pageSize(request.pageSize, 20, 50);
    const parameters = { parent: request.parent };
    const after = cursorOf(request.pageToken, parameters, (value) => Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && Number.isSafeInteger(value[0]) && typeof value[1] === 'string' && UUID.test(value[1]) ? [value[0], value[1]] as const : null);
    const rows = after === null
      ? ctx.store.all<DocumentRow>(`SELECT * FROM documents WHERE page_rowid = ? ORDER BY capture_ms DESC, id DESC LIMIT ?`, page.rowid, size + 1)
      : ctx.store.all<DocumentRow>(`SELECT * FROM documents WHERE page_rowid = ? AND (capture_ms, id) < (?, ?) ORDER BY capture_ms DESC, id DESC LIMIT ?`, page.rowid, after[0], after[1], size + 1);
    const selected = rows.slice(0, size);
    const last = selected.at(-1);
    return Promise.resolve(create(ListDocumentsResponseSchema, {
      documents: selected.map((row) => documentMessage(row, parent)),
      nextPageToken: rows.length > size && last !== undefined ? encodePageToken([last.capture_ms, last.id], parameters) : '',
    }));
  },

  async getDocument(request, ctx) {
    const { page, id } = childName(request.name, 'documents');
    const row = ctx.store.one<DocumentRow>(`SELECT d.* FROM documents d JOIN pages p ON p.rowid = d.page_rowid WHERE d.id = ? AND p.id = ?`, id, page) ?? fail('NOT_FOUND');
    let text = '';
    let screenshot = '';
    let error = '';
    try {
      const compressed = await readContent(ctx, { path: row.blob_path, sha256: row.sha256, size: row.stored_bytes }, row.archived_ms !== null);
      const plain = await readBounded(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')), DOCUMENT_MAX_BYTES);
      if (plain.length !== row.text_bytes || await sha256Hex(plain) !== row.text_sha256) throw new DropboxError('blob_corrupt');
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plain);
    } catch (failure) { error = contentFailure(failure); }
    if (row.screenshot_path !== '') {
      try {
        screenshot = base64Of(await readContent(ctx, { path: row.screenshot_path, sha256: row.screenshot_sha256, size: row.screenshot_bytes }, row.archived_ms !== null));
      } catch (failure) { error ||= contentFailure(failure); }
    }
    // A delete during an external read must not resurrect its content in an owner response.
    if (ctx.store.one(`SELECT 1 FROM pages WHERE id = ?`, page) === undefined) fail('NOT_FOUND');
    return documentMessage(row, page, text, screenshot, error);
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
    return Promise.resolve(currentSettings(ctx.store));
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
    // Named without a value: every text stays in Cloudflare.
    const retentionDays = paths.includes('text_retention_days') ? (input.textRetentionDays ?? null) : undefined;
    if (retentionDays !== undefined && retentionDays !== null && !validRetention(retentionDays)) fail('INVALID_RETENTION');
    return Promise.resolve(
      once(ctx, request.requestId, 'UpdateSettings', 'settings', SettingsSchema, () => {
        const current = readDenylist(ctx.store);
        if (input.etag !== '' && input.etag !== current.etag) throw recallError('ETAG_MISMATCH', [{ schema: SettingsSchema, message: currentSettings(ctx.store) }]);
        if (patterns === undefined && siteOnly === undefined && retentionDays === undefined) return currentSettings(ctx.store);
        // The two lists hold at most OWNER_PATTERNS_MAX patterns together.
        if ((patterns ?? current.patterns).length + (siteOnly ?? current.siteOnly).length > OWNER_PATTERNS_MAX) fail('LIMIT_REACHED');
        writeSettings(ctx.store, { ...(patterns === undefined ? {} : { patterns }), ...(siteOnly === undefined ? {} : { siteOnly }), ...(retentionDays === undefined ? {} : { retentionDays }) }, ctx.now);
        return currentSettings(ctx.store);
      }),
    );
  },

  getServiceStatus(request, ctx) {
    if (request.name !== 'serviceStatus') fail('NOT_FOUND');
    return Promise.resolve(serviceStatus(ctx.store, ctx.now, ctx.build, ctx.secretTokens));
  },

  async connectDropboxBackup(request, ctx) {
    if (request.name !== 'dropboxBackup') fail('NOT_FOUND');
    const appKey = request.appKey.trim();
    if (!APP_KEY.test(appKey)) fail('INVALID_APP_KEY');
    const host = ctx.dropbox.host ?? fail('NOT_CONFIGURED');
    // A fresh state (its SHA-256 kept) and PKCE verifier (kept, for the exchange) per connection.
    const state = randomText(32);
    const verifier = randomText(48);
    const [challenge, stateSha256] = await Promise.all([pkceChallenge(verifier), sha256Hex(new TextEncoder().encode(state))]);
    return once(ctx, request.requestId, 'ConnectDropboxBackup', request.name, ConnectDropboxBackupResponseSchema, () =>
      create(ConnectDropboxBackupResponseSchema, {
        authorizeUrl: startConnect(ctx.store, ctx.dropbox.endpoints, host, { appKey, state, stateSha256, verifier, challenge, expiresMs: ctx.now + DROPBOX_CONNECT_MS }),
      }),
    );
  },

  async disconnectDropboxBackup(request, ctx) {
    if (request.name !== 'dropboxBackup') fail('NOT_FOUND');
    if (!answered(ctx, request.requestId)) await ctx.dropbox.disconnect();
    return once(ctx, request.requestId, 'DisconnectDropboxBackup', request.name, DropboxBackupSchema, () => backupMessage(ctx.store));
  },

  async createMachineToken(request, ctx) {
    const label = request.machineToken?.label.trim() ?? '';
    if (label.length === 0 || label.length > 80 || Array.from(label).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) bad('label must be 1-80 characters');
    if (answered(ctx, request.requestId)) return once(ctx, request.requestId, 'CreateMachineToken', 'machineTokens', MachineTokenSchema, () => fail('INTERNAL'));
    const token = newToken('ingest');
    const digest = await tokenDigest(token);
    const created = { value: false };
    const stored = once(ctx, request.requestId, 'CreateMachineToken', 'machineTokens', MachineTokenSchema, () => {
      const made = addNamedToken(ctx.store, label, digest, ctx.now) ?? fail('LIMIT_REACHED');
      created.value = true;
      return made;
    });
    // A matching request may finish during hashing; only the transaction that created it can show the bearer.
    if (created.value) stored.token = token;
    return stored;
  },

  async regenerateMachineToken(request, ctx) {
    const route = tokenRoute(request.name) ?? fail('NOT_FOUND');
    // A repeated request changes nothing and answers without the token: it is shown once, and never stored.
    if (answered(ctx, request.requestId)) return once(ctx, request.requestId, 'RegenerateMachineToken', request.name, MachineTokenSchema, () => fail('INTERNAL'));
    const token = newToken(route);
    const digest = await tokenDigest(token);
    const created = { value: false };
    const stored = once(ctx, request.requestId, 'RegenerateMachineToken', request.name, MachineTokenSchema, () => {
      storeToken(ctx.store, route, digest, ctx.now, request.revokePrevious);
      created.value = true;
      return tokenMessage(ctx.store, route, ctx.now, ctx.secretTokens[route]);
    });
    // Replays return the saved metadata without attaching a token this transaction did not store.
    if (created.value) stored.token = token;
    return stored;
  },

  deleteMachineToken(request, ctx) {
    const route = tokenRoute(request.name);
    const namedId = namedTokenId(request.name);
    if (route === null && namedId === null) fail('NOT_FOUND');
    return Promise.resolve(
      once(ctx, request.requestId, 'DeleteMachineToken', request.name, EmptySchema, () => {
        const deleted = route === null ? deleteNamedToken(ctx.store, namedId ?? '') : deleteToken(ctx.store, route);
        if (!deleted) fail('NOT_FOUND');
        return create(EmptySchema);
      }),
    );
  },
};
