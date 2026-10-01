/**
 * PreviewWatch (../../docs/design.md §5, §9): every stage of the pipeline for given settings, without storing anything
 * but the fetch's etiquette rows (the host's spacing, the day's request count, a robots.txt verdict). The phone's block
 * picker builds include and exclude selectors from its blocks.
 *
 * A page fetched for a preview in the last PREVIEW_CACHE_MS is previewed again from memory (the owner tries selectors
 * one after another), at most PREVIEW_CACHE_ENTRIES pages. `refresh` fetches again; the host's spacing still applies:
 * the preview waits for it (at most HOST_SPACING_MS) and never fetches a host that asked to back off.
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
import { buildContent } from './content.ts';
import { extract } from './extract/index.ts';
import { findNumber } from './extract/number.ts';
import { cleanLine } from './normalize.ts';
import { HOST_SPACING_MS, PREVIEW_BLOCKS_MAX, PREVIEW_CACHE_ENTRIES, PREVIEW_CACHE_MS, PREVIEW_ITEMS_MAX, PREVIEW_LINES_MAX, PREVIEW_TEXT_MAX } from './limits.ts';
import { failureReason, suppressionReason, triggerKind } from './model.ts';
import { obtain, type Budget, type Obtained, type ObtainDeps } from './obtain.ts';
import { decodeSnapshot, gunzip, gzip } from './snapshot.ts';
import { utcDay } from './etiquette.ts';
import { evaluate } from './triggers.ts';
import type { Store } from './store.ts';

export interface PreviewDeps extends ObtainDeps {
  readonly store: Store;
  /** Waits (the host's spacing). */
  readonly sleep: (ms: number) => Promise<void>;
  /** The clock after a wait. */
  readonly now: () => number;
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
   * The fetch a config makes: a page's HTML serves every page source (the owner tries selectors one after another);
   * a feed and a JSON API ask for other types.
   */
  static key(config: WatchConfig): string {
    const kind = config.source.kind === 'html' || config.source.kind === 'embedded' ? 'page' : config.source.kind;
    return JSON.stringify([config.uri, config.fetcher, kind, config.locale, config.allowHttp, config.ignoreRobots]);
  }

  /** A fresh entry for `config`; a markdown answer serves only a source that accepts markdown. */
  async get(config: WatchConfig, now: number): Promise<CacheEntry | undefined> {
    const row = this.store.one<{ at: number; meta: string; body: ArrayBuffer | null }>('SELECT at, meta, body FROM previews WHERE key = ? AND at > ?', PreviewCache.key(config), now - PREVIEW_CACHE_MS);
    if (row === undefined) return undefined;
    const meta = JSON.parse(row.meta) as Obtained;
    const obtained: Obtained = meta.kind === 'answer' ? { ...meta, body: row.body === null ? new Uint8Array(0) : await gunzip(new Uint8Array(row.body)) } : meta;
    const markdown = obtained.kind === 'answer' && (obtained.contentType ?? '').toLowerCase().startsWith('text/markdown');
    return markdown && !acceptFor(config.source).startsWith('text/markdown') ? undefined : { at: row.at, obtained };
  }

  async put(config: WatchConfig, entry: CacheEntry): Promise<void> {
    const { obtained } = entry;
    const body = obtained.kind === 'answer' ? await gzip(obtained.body) : null;
    if (body !== null && body.byteLength > CACHE_BODY_MAX) return;
    const meta = obtained.kind === 'answer' ? { ...obtained, body: undefined } : obtained;
    this.store.run('INSERT OR REPLACE INTO previews (key, at, meta, body) VALUES (?, ?, ?, ?)', PreviewCache.key(config), entry.at, JSON.stringify(meta), body === null ? null : body.slice().buffer);
    this.store.run('DELETE FROM previews WHERE key NOT IN (SELECT key FROM previews ORDER BY at DESC LIMIT ?)', PREVIEW_CACHE_ENTRIES);
  }
}

const clip = (text: string) => (text.length > PREVIEW_TEXT_MAX ? `${text.slice(0, PREVIEW_TEXT_MAX - 1)}…` : text);

/** The fetch of a preview: from the cache, or a new one within the etiquette. */
async function previewFetch(deps: PreviewDeps, cache: PreviewCache, config: WatchConfig, refresh: boolean): Promise<{ obtained: Obtained; at: number; cached: boolean }> {
  const cached = refresh ? undefined : await cache.get(config, deps.now());
  if (cached !== undefined) return { obtained: cached.obtained, at: cached.at, cached: true };
  const host = deps.store.host(config.host);
  let now = deps.now();
  if (host?.backoff_until != null && host.backoff_until > now) {
    return { obtained: { kind: 'failed', failure: 'RATE_LIMITED', retryAfter: host.backoff_until - now, status: 0, finalUrl: config.uri, redirects: 0, robotsAllowed: true, fetched: false }, at: now, cached: false };
  }
  const wait = (host?.next_at ?? 0) - now;
  if (wait > 0) {
    await deps.sleep(Math.min(wait, HOST_SPACING_MS));
    now = deps.now();
  }
  const budget: Budget = { requests: 12, used: 0, bytes: 0 };
  const obtained = await obtain(deps, config, now, budget, null);
  deps.store.addLedger(utcDay(now), budget.used);
  if (obtained.kind !== 'failed' || obtained.fetched) await cache.put(config, { at: now, obtained });
  return { obtained, at: now, cached: false };
}

/** An existing watch's stored texts that stages 4 and 5 compare with: its notified state and its previous check's. */
export interface Comparison {
  readonly baselineId: number;
  readonly seenId: number | null;
}

/** The preview of `config`, compared with an existing watch's texts when `comparison` is given. */
export async function preview(deps: PreviewDeps, cache: PreviewCache, config: WatchConfig, refresh: boolean, comparison: Comparison | null): Promise<PreviewWatchResponse> {
  const { obtained, at, cached } = await previewFetch(deps, cache, config, refresh);
  const response = create(PreviewWatchResponseSchema, {
    fetch: create(PreviewFetchSchema, {
      httpStatus: obtained.status,
      finalUri: obtained.finalUrl,
      redirectCount: obtained.redirects,
      robotsAllowed: obtained.robotsAllowed,
      fetchTime: timestampFromMs(at),
      cached,
    }),
  });
  const fetch = response.fetch;
  if (fetch === undefined) return response;
  if (obtained.kind === 'failed') {
    response.failure = failureReason(obtained.failure);
    return response;
  }
  if (obtained.kind === 'not_modified') return response;
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
  response.normalizedLines = built.content.lines.slice(0, PREVIEW_LINES_MAX).map(clip);
  response.linesTruncated ||= built.content.lines.length > PREVIEW_LINES_MAX;
  response.maskedTokenCount = built.masked;
  response.ignoredLineCount = built.ignored;
  if (comparison !== null) {
    const snapshot = deps.store.snapshot(comparison.baselineId);
    const seen = comparison.seenId === null ? undefined : deps.store.snapshot(comparison.seenId);
    if (snapshot !== undefined) {
      const baseline = await decodeSnapshot(snapshot.body);
      const previous = seen === undefined ? baseline : await decodeSnapshot(seen.body);
      const evaluation = evaluate(config.trigger, baseline, previous, built.content);
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
