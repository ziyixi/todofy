/**
 * The owner API (proto/watch/ui/v1): one handler per rpc of WatchUiService, served by the shared transcoder inside
 * WatchState (state.ts), after the Worker authenticated the owner and checked Origin and CSRF (http.ts). A handler
 * checks what the IDL cannot (config.ts, limits.ts), reads or writes the object's SQLite (store.ts) and maps rows to
 * messages (model.ts). Every mutation and its AIP-155 request log entry are one transaction.
 *
 * Errors are RpcErrors with a reason of watch.ui.v1.ErrorReason or common.errors.v1.CommonReason (reasons.ts). The
 * object's storage is its own, so nothing here is a failed dependency: anything unexpected is INTERNAL.
 */
import { FieldMaskError, updatePaths } from '@ziyixi/proto/field-mask';
import { FilterError, parseLiteralFilter } from '@ziyixi/proto/filter';
import type { ServiceHandlers, ShapeOf } from '@ziyixi/proto/http-transcoder';
import { decodePageToken, encodePageToken, PageTokenError, type PageParameters } from '@ziyixi/proto/page-token';
import { create, type DescMessage, type JsonValue, type MessageShape } from '@ziyixi/proto/protobuf';
import { EmptySchema, timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { ChangeSchema } from '@ziyixi/proto/watch/ui/v1/change_pb';
import { WatchSchema, type Watch } from '@ziyixi/proto/watch/ui/v1/watch_pb';
import {
  ListChangesResponseSchema,
  ListWatchesResponseSchema,
  ServiceStatusSchema,
  type PreviewWatchResponse,
  type WatchUiService,
} from '@ziyixi/proto/watch/ui/v1/watch_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { browserAllowed } from './browser.ts';
import { checkHash, readConfig, readHash, SETTINGS_FIELDS, settingsWire, type ConfigEnv, type WatchConfig } from './config.ts';
import { earliestFetch, nextCheckAt, nextUtcMidnight, utcDay } from './etiquette.ts';
import { newEtag, watchId as makeWatchId } from './ids.ts';
import { BROWSER_DAILY_MS, CHANGE_ID_PATTERN, CHANGE_PAGE, FILTER_LITERALS_MAX, FILTER_MAX, SHADOW_PERIOD_MS, URL_MIN_SPACING_MS, WATCH_ID_PATTERN, WATCH_PAGE, WATCHES_MAX } from './limits.ts';
import { changeMessage, watchMessage, withBackoff } from './model.ts';
import type { Comparison } from './preview.ts';
import { REASONS, watchError } from './reasons.ts';
import type { ChangeStateName, Store, WatchRow } from './store.ts';

/** What every handler gets from WatchState. */
export interface ApiContext {
  readonly store: Store;
  /** The request's time (epoch milliseconds). */
  readonly now: number;
  readonly configEnv: ConfigEnv;
  readonly build: string;
  readonly transact: <T>(fn: () => T) => T;
  /** Brings the alarm forward (a new watch, a resume, a check). */
  readonly wake: () => Promise<void>;
  readonly alarmAt: () => Promise<number | null>;
  readonly preview: (config: WatchConfig, refresh: boolean, comparison: Comparison | null) => Promise<PreviewWatchResponse>;
}

function bad(message = REASONS.BAD_REQUEST.message): never {
  throw new RpcError(REASONS.BAD_REQUEST.code, 'BAD_REQUEST', message);
}

function notFound(): never {
  throw watchError('NOT_FOUND');
}

// ---- names and values --------------------------------------------------------------------------------------------

/** The ID of `watches/{watch}`. */
function watchIdOf(name: string): string {
  const id = name.startsWith('watches/') ? name.slice('watches/'.length) : '';
  if (!WATCH_ID_PATTERN.test(id)) throw watchError('INVALID_WATCH_ID');
  return id;
}

/** The IDs of `watches/{watch}/changes/{change}`. */
function changeNameOf(name: string): { watch: string; change: string } {
  const match = /^watches\/([^/]+)\/changes\/([^/]+)$/.exec(name);
  if (match === null || !WATCH_ID_PATTERN.test(match[1] ?? '') || !CHANGE_ID_PATTERN.test(match[2] ?? '')) bad('not a change name');
  return { watch: match[1] ?? '', change: match[2] ?? '' };
}

function existing(ctx: ApiContext, id: string): WatchRow {
  return ctx.store.watch(id) ?? notFound();
}

function configOf(watch: Watch, ctx: ApiContext): WatchConfig {
  const config = readConfig(watch, ctx.configEnv);
  if (typeof config === 'string') throw config === 'BAD_REQUEST' ? new RpcError(REASONS.BAD_REQUEST.code, 'BAD_REQUEST', 'a value breaks its rule') : watchError(config);
  return config;
}

/** page_size (AIP-158): 0 means `max`, a larger value is read as `max`, a negative one is BAD_REQUEST. */
function pageSize(value: number, max: number): number {
  if (value < 0) bad('page_size is negative');
  return value === 0 ? max : Math.min(value, max);
}

function cursorOf<T>(token: string, parameters: PageParameters, read: (cursor: JsonValue) => T | null): T | null {
  if (token === '') return null;
  try {
    return read(decodePageToken(token, parameters)) ?? bad('page_token is not valid');
  } catch (error) {
    if (error instanceof PageTokenError) bad('page_token is not valid');
    throw error;
  }
}

function newCounts(ctx: ApiContext): Map<string, number> {
  return ctx.store.newCounts();
}

function message(ctx: ApiContext, row: WatchRow, counts = newCounts(ctx)): Watch {
  return withBackoff(watchMessage(row, ctx.now, counts.get(row.id) ?? 0), ctx.store.host(row.host)?.backoff_until ?? null, ctx.now);
}

// ---- AIP-155 -----------------------------------------------------------------------------------------------------------

/**
 * Runs a mutation once per request_id: the mutation and its log entry are one transaction; a repeat of the ID for the
 * same rpc and resource answers the logged response, for another one it is BAD_REQUEST and changes nothing.
 */
function once<Desc extends DescMessage>(ctx: ApiContext, requestId: string, rpc: string, resource: string, schema: Desc, run: () => MessageShape<Desc>): MessageShape<Desc> {
  return ctx.transact(() => {
    if (requestId !== '') {
      const logged = ctx.store.request(requestId, ctx.now);
      if (logged !== undefined) {
        if (logged.rpc !== rpc || logged.resource !== resource) bad('the request_id was used for another request (another method or resource)');
        return fromWire(schema, JSON.parse(logged.response) as unknown).message;
      }
    }
    const answer = run();
    if (requestId !== '') ctx.store.putRequest(requestId, rpc, resource, JSON.stringify(toWire(schema, answer)), ctx.now);
    return answer;
  });
}

function checkEtag(ctx: ApiContext, row: WatchRow, etag: string): void {
  if (etag !== '' && etag !== row.etag) throw watchError('ETAG_MISMATCH', message(ctx, row));
}

// ---- updates -----------------------------------------------------------------------------------------------------------

/** Sets `path` of `target` to `source`'s value there (absent: removed), creating the parents. */
function copyPath(target: Record<string, unknown>, source: Record<string, unknown>, path: readonly string[]): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (rest.length === 0) {
    if (source[head] === undefined || source[head] === null) Reflect.deleteProperty(target, head);
    else target[head] = source[head];
    return;
  }
  const from = source[head];
  const to = typeof target[head] === 'object' && target[head] !== null ? (target[head] as Record<string, unknown>) : {};
  copyPath(to, typeof from === 'object' && from !== null ? (from as Record<string, unknown>) : {}, rest);
  target[head] = to;
}

/** The settings after an AIP-134 update of `request` with `paths`, and whether it sets shadow_mode (and to what). */
function merged(current: string, request: Watch, paths: '*' | readonly string[]): { settings: Record<string, unknown>; shadow: boolean | null } {
  const incoming = settingsWire(request);
  if (paths === '*') return { settings: incoming, shadow: request.shadowMode };
  const settings = JSON.parse(current) as Record<string, unknown>;
  let shadow: boolean | null = null;
  for (const path of paths) {
    const parts = path.split('.');
    const head = parts[0] ?? '';
    if (head === 'shadow_mode') shadow = request.shadowMode;
    else if ((SETTINGS_FIELDS as readonly string[]).includes(head)) copyPath(settings, incoming, parts);
    // Other paths (name, etag, the output-only fields) change nothing.
  }
  return { settings, shadow };
}

/** The shadow_end after a write that sets shadow_mode to `on` (a running period keeps its end). */
function shadowEnd(row: Pick<WatchRow, 'shadow_end'> | null, on: boolean | null, now: number): number | null {
  const running = row?.shadow_end != null && row.shadow_end > now ? row.shadow_end : null;
  if (on === null) return running;
  return on ? (running ?? now + SHADOW_PERIOD_MS) : null;
}

// ---- the handlers ----------------------------------------------------------------------------------------------------

const CHANGE_FILTERS: Readonly<Record<string, ChangeStateName>> = {
  NEW: 'confirmed',
  CONFIRMED: 'confirmed',
  PENDING_CONFIRMATION: 'pending',
  SUPPRESSED: 'suppressed',
  ACKNOWLEDGED: 'acknowledged',
};

export const handlers: ServiceHandlers<ShapeOf<typeof WatchUiService>, ApiContext> = {
  getWatch(request, ctx) {
    return Promise.resolve(message(ctx, existing(ctx, watchIdOf(request.name))));
  },

  listWatches(request, ctx) {
    const size = pageSize(request.pageSize, WATCH_PAGE);
    if (request.filter.length > FILTER_MAX) bad('filter is too long');
    let literals: string[];
    try {
      literals = parseLiteralFilter(request.filter, FILTER_LITERALS_MAX).map((literal) => literal.toLowerCase());
    } catch (error) {
      if (error instanceof FilterError) bad('filter is not valid');
      throw error;
    }
    const parameters = { filter: request.filter };
    const after = cursorOf(request.pageToken, parameters, (cursor) => (Array.isArray(cursor) && typeof cursor[0] === 'number' && typeof cursor[1] === 'string' ? ([cursor[0], cursor[1]] as const) : null));
    const counts = newCounts(ctx);
    const rows = ctx.store.watches().filter((row) => {
      if (after !== null && (row.create_time > after[0] || (row.create_time === after[0] && row.id >= after[1]))) return false;
      if (literals.length === 0) return true;
      const settings = JSON.parse(row.settings) as { display_name?: string; uri?: string };
      const haystack = `${settings.display_name ?? ''}\n${settings.uri ?? ''}`.toLowerCase();
      return literals.every((literal) => haystack.includes(literal));
    });
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    return Promise.resolve(
      create(ListWatchesResponseSchema, {
        watches: page.map((row) => message(ctx, row, counts)),
        nextPageToken: rows.length > size && last !== undefined ? encodePageToken([last.create_time, last.id], parameters) : '',
      }),
    );
  },

  /**
   * AIP-133 with AIP-155. Without a watch_id the Worker names the watch, so a repeat of the request_id is logged under
   * the collection (`watches`): a retry after a lost response answers the watch the first request made, never a new
   * one and never BAD_REQUEST.
   */
  async createWatch(request, ctx) {
    const watch = request.watch ?? bad();
    const id = request.watchId === '' ? makeWatchId() : request.watchId;
    if (!WATCH_ID_PATTERN.test(id)) throw watchError('INVALID_WATCH_ID');
    const config = configOf(watch, ctx);
    watch.uri = config.uri;
    const settings = JSON.stringify(settingsWire(watch));
    const hashes = { read_hash: await readHash(config), check_hash: await checkHash(config) };
    const resource = request.watchId === '' ? 'watches' : `watches/${id}`;
    const answer = once(ctx, request.requestId, 'CreateWatch', resource, WatchSchema, () => {
      const found = ctx.store.watch(id);
      if (found !== undefined) throw watchError('WATCH_EXISTS', message(ctx, found));
      if (ctx.store.watchCount() >= WATCHES_MAX) throw watchError('WATCHES_FULL');
      // A preview just fetched the URL: that fetch counts for its 15 minutes, so the first check comes after them.
      const fetchedAt = ctx.store.urlFetchedAt(config.uri, ctx.now);
      ctx.store.insertWatch({
        id,
        settings,
        host: config.host,
        ...hashes,
        state: 'active',
        pause_reason: null,
        etag: newEtag(ctx.now),
        create_time: ctx.now,
        update_time: ctx.now,
        shadow_end: shadowEnd(null, watch.shadowMode, ctx.now),
        next_check_at: fetchedAt === null ? ctx.now : Math.max(ctx.now, fetchedAt + URL_MIN_SPACING_MS),
        check_requested: 0,
        last_fetch_at: fetchedAt,
        last_check_at: null,
        last_success_at: null,
        last_outcome: null,
        last_failure: null,
        last_http_status: 0,
        failures: 0,
        failure_start: null,
        masked_count: 0,
        http_etag: null,
        http_last_modified: null,
        raw_sha: null,
        raw_check_hash: null,
        seen_sha: null,
        seen_check_hash: null,
        seen_snapshot_id: null,
        baseline_id: null,
        baseline_read_hash: null,
        pending_change: null,
      });
      return message(ctx, existing(ctx, id));
    });
    await ctx.wake();
    return answer;
  },

  /**
   * AIP-134 with AIP-154: the masked fields (or all). A client that wants its etag checked with a mask names `etag` in
   * the mask too (the shared client sends only the masked fields); the UI does.
   */
  async updateWatch(request, ctx) {
    const watch = request.watch ?? bad();
    const id = watchIdOf(watch.name);
    let paths: '*' | readonly string[];
    try {
      paths = updatePaths(request.updateMask);
    } catch (error) {
      if (error instanceof FieldMaskError) bad('update_mask is not valid');
      throw error;
    }
    const row = existing(ctx, id);
    const { settings, shadow } = merged(row.settings, watch, paths);
    const next = fromWire(WatchSchema, settings).message;
    const config = configOf(next, ctx);
    next.uri = config.uri;
    const stored = JSON.stringify(settingsWire(next));
    const hashes = { read_hash: await readHash(config), check_hash: await checkHash(config) };
    const answer = once(ctx, request.requestId, 'UpdateWatch', `watches/${id}`, WatchSchema, () => {
      const current = existing(ctx, id);
      checkEtag(ctx, current, watch.etag);
      // Merged from `row`: if another write landed since, this one is refused rather than undoing it.
      if (current.etag !== row.etag) throw watchError('ETAG_MISMATCH', message(ctx, current));
      const checkChanged = hashes.check_hash !== current.check_hash;
      const oldInterval = (JSON.parse(current.settings) as { check_interval_minutes?: number }).check_interval_minutes ?? 0;
      const intervalChanged = (next.checkIntervalMinutes || 0) !== oldInterval;
      let nextCheck = current.next_check_at;
      if (current.state !== 'paused' && checkChanged) nextCheck = ctx.now;
      else if (current.state !== 'paused' && intervalChanged) nextCheck = nextCheckAt(id, ctx.now, config.intervalMinutes, current.last_fetch_at);
      // A pending change stays: its confirmation fetch evaluates it under the new settings, or, when what is read
      // changed, confirms it as it was seen with a note (pipeline.ts). It is never dropped unseen.
      ctx.store.updateWatch(id, {
        settings: stored,
        host: config.host,
        ...hashes,
        etag: newEtag(ctx.now),
        update_time: ctx.now,
        shadow_end: shadowEnd(current, shadow, ctx.now),
        next_check_at: nextCheck,
      });
      return message(ctx, existing(ctx, id));
    });
    await ctx.wake();
    return answer;
  },

  deleteWatch(request, ctx) {
    const id = watchIdOf(request.name);
    return Promise.resolve(
      once(ctx, request.requestId, 'DeleteWatch', `watches/${id}`, EmptySchema, () => {
        const row = existing(ctx, id);
        checkEtag(ctx, row, request.etag);
        ctx.store.deleteWatch(id);
        return create(EmptySchema);
      }),
    );
  },

  pauseWatch(request, ctx) {
    const id = watchIdOf(request.name);
    return Promise.resolve(
      once(ctx, request.requestId, 'PauseWatch', `watches/${id}`, WatchSchema, () => {
        const row = existing(ctx, id);
        checkEtag(ctx, row, request.etag);
        if (row.state !== 'paused') ctx.store.updateWatch(id, { state: 'paused', pause_reason: 'owner', next_check_at: null, check_requested: 0, etag: newEtag(ctx.now), update_time: ctx.now });
        return message(ctx, existing(ctx, id));
      }),
    );
  },

  async resumeWatch(request, ctx) {
    const id = watchIdOf(request.name);
    const answer = once(ctx, request.requestId, 'ResumeWatch', `watches/${id}`, WatchSchema, () => {
      const row = existing(ctx, id);
      checkEtag(ctx, row, request.etag);
      if (row.state === 'paused') {
        // A new start: the failures before the pause no longer count toward BROKEN or the auto-pause.
        ctx.store.updateWatch(id, { state: 'active', pause_reason: null, failures: 0, failure_start: null, next_check_at: ctx.now, etag: newEtag(ctx.now), update_time: ctx.now });
      }
      return message(ctx, existing(ctx, id));
    });
    await ctx.wake();
    return answer;
  },

  async checkWatch(request, ctx) {
    const id = watchIdOf(request.name);
    const answer = once(ctx, request.requestId, 'CheckWatch', `watches/${id}`, WatchSchema, () => {
      const row = existing(ctx, id);
      // The host's spacing and backoff, and the URL's 15 minutes since its last fetch (a preview's included).
      const fetchedAt = ctx.store.urlFetchedAt((JSON.parse(row.settings) as { uri?: string }).uri ?? '', ctx.now);
      const at = Math.max(earliestFetch(ctx.now, ctx.store.host(row.host) ?? null, row.last_fetch_at), fetchedAt === null ? 0 : fetchedAt + URL_MIN_SPACING_MS);
      ctx.store.updateWatch(id, { check_requested: 1, next_check_at: Math.min(row.next_check_at ?? at, at) });
      return message(ctx, existing(ctx, id));
    });
    await ctx.wake();
    return answer;
  },

  async previewWatch(request, ctx) {
    const watch = request.watch ?? bad();
    const config = configOf(watch, ctx);
    // Stages 4 and 5 compare with an existing watch's texts, when what is read is the same.
    let comparison: Comparison | null = null;
    if (watch.name !== '') {
      const row = ctx.store.watch(watchIdOf(watch.name));
      if (row?.baseline_id != null && row.baseline_read_hash === (await readHash(config))) comparison = { baselineId: row.baseline_id, seenId: row.seen_snapshot_id };
    }
    return ctx.preview(config, request.refresh, comparison);
  },

  getChange(request, ctx) {
    const { watch, change } = changeNameOf(request.name);
    const row = ctx.store.change(watch, change) ?? notFound();
    const settings = JSON.parse(existing(ctx, watch).settings) as { display_name?: string };
    return Promise.resolve(changeMessage(row, settings.display_name ?? ''));
  },

  listChanges(request, ctx) {
    const watch = request.parent === 'watches/-' ? null : watchIdOf(request.parent);
    if (watch !== null) existing(ctx, watch);
    const filter = /^\s*state\s*=\s*([A-Z_]+)\s*$/.exec(request.filter);
    if (request.filter.trim() !== '' && (filter === null || CHANGE_FILTERS[filter[1] ?? ''] === undefined)) bad('filter is not valid');
    const state = filter === null ? null : (CHANGE_FILTERS[filter[1] ?? ''] ?? null);
    const size = pageSize(request.pageSize, CHANGE_PAGE);
    const parameters = { parent: request.parent, filter: request.filter.trim() };
    const before = cursorOf(request.pageToken, parameters, (cursor) => (typeof cursor === 'string' && CHANGE_ID_PATTERN.test(cursor) ? cursor : null));
    const rows = ctx.store.changes(watch, state, before, size + 1);
    const page = rows.slice(0, size);
    const names = new Map(ctx.store.watches().map((row) => [row.id, (JSON.parse(row.settings) as { display_name?: string }).display_name ?? '']));
    const last = page[page.length - 1];
    return Promise.resolve(
      create(ListChangesResponseSchema, {
        changes: page.map((row) => changeMessage(row, names.get(row.watch_id) ?? '')),
        nextPageToken: rows.length > size && last !== undefined ? encodePageToken(last.id, parameters) : '',
      }),
    );
  },

  acknowledgeChange(request, ctx) {
    const { watch, change } = changeNameOf(request.name);
    return Promise.resolve(
      once(ctx, request.requestId, 'AcknowledgeChange', request.name, ChangeSchema, () => {
        const row = ctx.store.change(watch, change) ?? notFound();
        if (row.state === 'pending' || row.state === 'suppressed') {
          throw new RpcError(Code.FAILED_PRECONDITION, 'BAD_REQUEST', 'only a confirmed change can be acknowledged');
        }
        if (row.state === 'confirmed') ctx.store.updateChange(row.id, { state: 'acknowledged', ack_time: ctx.now });
        const settings = JSON.parse(existing(ctx, watch).settings) as { display_name?: string };
        return changeMessage(ctx.store.change(watch, change) ?? notFound(), settings.display_name ?? '');
      }),
    );
  },

  async getServiceStatus(request, ctx) {
    if (request.name !== 'serviceStatus') notFound();
    const rows = ctx.store.watches();
    const counts = ctx.store.openCounts();
    const ledger = ctx.store.ledger(utcDay(ctx.now));
    const alarm = await ctx.alarmAt();
    const lastAlarm = ctx.store.getMeta('last_alarm_at');
    return create(ServiceStatusSchema, {
      name: 'serviceStatus',
      activeWatchCount: rows.filter((row) => row.state === 'active').length,
      pausedWatchCount: rows.filter((row) => row.state === 'paused').length,
      brokenWatchCount: rows.filter((row) => row.state === 'broken').length,
      newChangeCount: counts.confirmed,
      pendingChangeCount: counts.pending,
      suppressedChangeCount: counts.suppressed,
      browserEnabled: ctx.configEnv.browserEnabled,
      browserUsedMs: ledger.browser_ms,
      browserLimitMs: BROWSER_DAILY_MS,
      browserQuotaExhausted: !browserAllowed(ledger),
      browserQuotaResetTime: timestampFromMs(nextUtcMidnight(ctx.now)),
      nextAlarmTime: alarm === null ? undefined : timestampFromMs(alarm),
      lastAlarmTime: lastAlarm === null ? undefined : timestampFromMs(Number(lastAlarm)),
      fetchCountToday: ledger.fetches,
      build: ctx.build,
    });
  },
};
