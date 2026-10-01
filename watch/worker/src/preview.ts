/**
 * PreviewWatch (../../docs/design.md §5, §9): every stage of the pipeline for given settings, without storing anything
 * but the fetch's etiquette rows (the host's spacing, the day's request count, a robots.txt verdict). The phone's block
 * picker builds include and exclude selectors from its blocks.
 *
 * A page fetched for a preview in the last PREVIEW_CACHE_MS is previewed again from its stored fetch (the owner tries
 * selectors one after another), at most PREVIEW_CACHE_ENTRIES pages. A preview always asks for HTML (acceptFor), so
 * the block picker has elements even on a site that serves markdown to agents. The etiquette is a check's:
 * - the same URL is never fetched again within URL_MIN_SPACING_MS, by a preview or a check (`url_fetches`): `refresh`
 *   within that time answers the stored fetch (`cached`, with `next_fetch_time`), or RATE_LIMITED until then when
 *   nothing of it is stored (a check fetched it);
 * - the host's spacing: the preview waits for it (at most HOST_SPACING_MS, once) and never fetches a host that asked
 *   to back off; one request at a time per host (host-locks.ts), so two previews never overlap.
 */
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { DiffLine_Kind } from '@ziyixi/proto/watch/ui/v1/change_pb';
import {
  PreviewBlockSchema,
  PreviewFetchSchema,
  PreviewItemSchema,
  PreviewTriggerSchema,
  PreviewWatchResponseSchema,
  type PreviewWatchResponse,
} from '@ziyixi/proto/watch/ui/v1/watch_ui_service_pb';
import { acceptFor, type WatchConfig } from './config.ts';
import { buildContent, viewOf } from './content.ts';
import { extract } from './extract/index.ts';
import { findNumber } from './extract/number.ts';
import { cleanLine } from './normalize.ts';
import { HOST_SPACING_MS, PREVIEW_BLOCKS_MAX, PREVIEW_CACHE_ENTRIES, PREVIEW_CACHE_MS, PREVIEW_ITEMS_MAX, PREVIEW_LINES_MAX, PREVIEW_TEXT_MAX, URL_MIN_SPACING_MS } from './limits.ts';
import { failureReason, suppressionReason, triggerKind } from './model.ts';
import { obtain, REQUESTS_PER_CHECK, type AnswerMeta, type Budget, type Obtained, type ObtainDeps } from './obtain.ts';
import { decodeSnapshot, gunzip, gzip } from './snapshot.ts';
import { utcDay } from './etiquette.ts';
import { evaluate } from './triggers.ts';
import type { Store } from './store.ts';

export interface PreviewDeps extends ObtainDeps {
  readonly store: Store;
  /** Waits (the host's spacing). */
  readonly sleep: (ms: number) => Promise<void>;
}

interface CacheEntry {
  readonly at: number;
  readonly obtained: Obtained;
}

/** The largest gzipped body a cache row holds (a Durable Object SQLite row is at most 2 MB). */
const CACHE_BODY_MAX = 1_900_000;

/**
 * The cache of previewed fetches, in WatchState's SQLite (`previews`): an object leaves memory after seconds without
 * requests, and the owner taps blocks more slowly than that. At most PREVIEW_CACHE_ENTRIES rows of PREVIEW_CACHE_MS;
 * the body is stored gzipped (a page whose compressed body is over CACHE_BODY_MAX is not cached).
 */
export class PreviewCache {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /**
   * The fetch a config makes: one per URL and the options that change the request (the source's kind does not: the
   * same URL is fetched once in URL_MIN_SPACING_MS, whatever the owner tries on it).
   */
  static key(config: WatchConfig): string {
    return JSON.stringify([config.uri, config.fetcher, config.locale, config.allowHttp, config.ignoreRobots]);
  }

  /** A fresh entry for `config`. */
  async get(config: WatchConfig, now: number): Promise<CacheEntry | undefined> {
    const row = this.store.one<{ at: number; meta: string; body: ArrayBuffer | null }>('SELECT at, meta, body FROM previews WHERE key = ? AND at > ?', PreviewCache.key(config), now - PREVIEW_CACHE_MS);
    if (row === undefined) return undefined;
    const meta = JSON.parse(row.meta) as Obtained;
    const obtained: Obtained = meta.kind === 'answer' ? { ...meta, body: row.body === null ? new Uint8Array(0) : await gunzip(new Uint8Array(row.body)) } : meta;
    return { at: row.at, obtained };
  }

  async put(config: WatchConfig, entry: CacheEntry): Promise<void> {
    const { obtained } = entry;
    const body = obtained.kind === 'answer' ? await gzip(obtained.body) : null;
    if (body !== null && body.byteLength > CACHE_BODY_MAX) return;
    const meta = obtained.kind === 'answer' ? { ...obtained, body: undefined } : obtained;
    this.store.run('INSERT OR REPLACE INTO previews (key, at, meta, body) VALUES (?, ?, ?, ?)', PreviewCache.key(config), entry.at, JSON.stringify(meta), body === null ? null : body.slice().buffer);
    this.store.run('DELETE FROM previews WHERE key NOT IN (SELECT key FROM previews ORDER BY at DESC, rowid DESC LIMIT ?)', PREVIEW_CACHE_ENTRIES);
  }
}

const clip = (text: string) => (text.length > PREVIEW_TEXT_MAX ? `${text.slice(0, PREVIEW_TEXT_MAX - 1)}…` : text);

/** A preview fetch's answer: what was obtained, when, and when the URL may be fetched again. */
interface PreviewFetched {
  readonly obtained: Obtained;
  readonly at: number;
  readonly cached: boolean;
  readonly nextFetch: number;
}

/** A RATE_LIMITED answer that sent nothing new: the host backs off, or the URL was fetched within 15 minutes. */
function waitAnswer(config: WatchConfig, now: number, until: number, meta: Partial<AnswerMeta> = {}): Obtained {
  return { status: 0, finalUrl: config.uri, redirects: 0, robotsAllowed: true, fetched: false, fetchedAt: null, ...meta, kind: 'failed', failure: 'RATE_LIMITED', retryAfter: Math.max(0, until - now) };
}

/** The fetch of a preview: from the stored fetch, or a new one within the etiquette. */
async function previewFetch(deps: PreviewDeps, cache: PreviewCache, config: WatchConfig, refresh: boolean): Promise<PreviewFetched> {
  const start = deps.now();
  const fetchedAt = deps.store.urlFetchedAt(config.uri, start);
  const nextFetch = fetchedAt === null ? start : fetchedAt + URL_MIN_SPACING_MS;
  const stored = await cache.get(config, start);
  // `refresh` fetches again only when the URL may be fetched again; until then the stored fetch answers.
  if (stored !== undefined && (!refresh || fetchedAt !== null)) return { obtained: stored.obtained, at: stored.at, cached: true, nextFetch };
  if (fetchedAt !== null) return { obtained: waitAnswer(config, start, nextFetch), at: start, cached: false, nextFetch };
  for (let attempt = 0; ; attempt++) {
    const budget: Budget = { requests: REQUESTS_PER_CHECK, used: 0, bytes: 0 };
    const obtained = await obtain(deps, config, budget, null, acceptFor(config.source, true));
    const now = deps.now();
    deps.store.addLedger(utcDay(now), budget.used);
    if (obtained.kind === 'deferred') {
      // The host's spacing (another request just started): wait for it once, unless a request already went out.
      const wait = obtained.until - now;
      if (attempt === 0 && !obtained.fetched && wait <= HOST_SPACING_MS) {
        await deps.sleep(Math.max(0, wait));
        continue;
      }
      return { obtained: waitAnswer(config, now, obtained.until, obtained), at: now, cached: false, nextFetch: Math.max(obtained.until, (obtained.fetchedAt ?? 0) + URL_MIN_SPACING_MS) };
    }
    const at = obtained.fetchedAt ?? now;
    if (obtained.kind !== 'failed' || obtained.fetched) await cache.put(config, { at, obtained });
    return { obtained, at, cached: false, nextFetch: obtained.fetched ? at + URL_MIN_SPACING_MS : now };
  }
}

/** An existing watch's stored texts that stages 4 and 5 compare with: its notified state and its previous check's. */
export interface Comparison {
  readonly baselineId: number;
  readonly seenId: number | null;
}

/** The preview of `config`, compared with an existing watch's texts when `comparison` is given. */
export async function preview(deps: PreviewDeps, cache: PreviewCache, config: WatchConfig, refresh: boolean, comparison: Comparison | null): Promise<PreviewWatchResponse> {
  const { obtained, at, cached, nextFetch } = await previewFetch(deps, cache, config, refresh);
  const response = create(PreviewWatchResponseSchema, {
    fetch: create(PreviewFetchSchema, {
      httpStatus: obtained.status,
      finalUri: obtained.finalUrl,
      redirectCount: obtained.redirects,
      robotsAllowed: obtained.robotsAllowed,
      fetchTime: timestampFromMs(at),
      cached,
      nextFetchTime: timestampFromMs(nextFetch),
    }),
  });
  const fetch = response.fetch;
  if (fetch === undefined) return response;
  if (obtained.kind === 'failed') {
    response.failure = failureReason(obtained.failure);
    return response;
  }
  if (obtained.kind === 'not_modified' || obtained.kind === 'deferred') return response;
  fetch.bodyBytes = obtained.body.byteLength;
  const extraction = await extract({ source: config.source, contentType: obtained.contentType, body: obtained.body, url: obtained.finalUrl, blocks: true });
  fetch.mimeType = extraction.info.mediaType;
  fetch.charset = extraction.info.charset.label;
  fetch.metaCharset = extraction.info.charset.source === 'meta' || extraction.info.charset.source === 'xml';
  fetch.markdown = extraction.info.markdown;
  response.blocks = extraction.info.blocks.slice(0, PREVIEW_BLOCKS_MAX).map((block) => create(PreviewBlockSchema, { ...block, text: clip(block.text) }));
  if (!extraction.ok) {
    response.failure = failureReason(extraction.failure);
    return response;
  }
  const page = extraction.page;
  response.extractedLines = page.lines.slice(0, PREVIEW_LINES_MAX).map(clip);
  response.items = (page.items ?? []).slice(0, PREVIEW_ITEMS_MAX).map((item) => create(PreviewItemSchema, { key: clip(item.key), text: clip(item.text) }));
  response.availability = page.availability ?? '';
  const label = config.trigger.kind === 'number' ? config.trigger.label : '';
  response.numberValue = findNumber(page.lines.map(cleanLine), label)?.text ?? '';
  const built = buildContent(page, config.normalize, config.trigger);
  response.linesTruncated = page.truncated || page.lines.length > PREVIEW_LINES_MAX;
  if (!built.ok) {
    response.failure = failureReason(built.failure);
    return response;
  }
  // As compared: without the owner's ignored lines (content.ts viewOf), on both sides.
  const ignored = config.normalize.ignoredLines;
  const view = viewOf(built.content, ignored);
  response.normalizedLines = view.content.lines.slice(0, PREVIEW_LINES_MAX).map(clip);
  response.linesTruncated ||= view.content.lines.length > PREVIEW_LINES_MAX;
  response.maskedTokenCount = built.masked;
  response.ignoredLineCount = view.ignored;
  if (comparison !== null) {
    const snapshot = deps.store.snapshot(comparison.baselineId);
    const seen = comparison.seenId === null ? undefined : deps.store.snapshot(comparison.seenId);
    if (snapshot !== undefined) {
      const baseline = viewOf(await decodeSnapshot(snapshot.body), ignored).content;
      const previous = seen === undefined ? baseline : viewOf(await decodeSnapshot(seen.body), ignored).content;
      const evaluation = evaluate(config.trigger, baseline, previous, view.content);
      response.trigger = create(PreviewTriggerSchema, {
        fired: evaluation.fired,
        triggerKind: triggerKind(evaluation.kind),
        suppressionReason: evaluation.added + evaluation.removed === 0 && evaluation.previous === evaluation.current ? suppressionReason(null) : suppressionReason(evaluation.reason),
        addedLineCount: evaluation.added,
        removedLineCount: evaluation.removed,
        diffLines: evaluation.diff.ops.slice(0, 200).map((op) => ({ kind: op.kind === 'added' ? DiffLine_Kind.ADDED : DiffLine_Kind.REMOVED, text: clip(op.text) })),
        previousValue: evaluation.previous,
        currentValue: evaluation.current,
      });
    }
  }
  return response;
}
