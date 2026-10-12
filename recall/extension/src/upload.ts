/**
 * Uploads (../../docs/design.md §3.8-§3.9): `POST /api/machine/v1/batches` with the ingest token, one batch of the
 * outbox's oldest items (at most 50 and 1 MiB of JSON, gzipped with CompressionStream: `Content-Type:
 * application/gzip`, no Content-Encoding), `credentials: 'omit'` and a 25 s timeout. The tick alarm flushes when the
 * outbox holds items and the last upload was five minutes ago or more, or when it holds 25; startup and the options
 * page's 立即上传 flush at once. When nothing was uploaded for 30 minutes an empty batch goes: the heartbeat, which
 * also carries the device's label, version, outbox size and last error.
 *
 * | Answer | The extension |
 * | --- | --- |
 * | 200 | removes the accepted and the rejected items, but holds an `unsupported_item` for six hours (recall is older than this build: it waits, it is not lost); stores the owner's denylist |
 * | 401 | stops uploading until the token changes; the badge says `!` |
 * | 413 | halves the batch |
 * | 429, 503 | waits Retry-After |
 * | other, network | backs off from a minute, doubling to an hour; the badge says `!` after an hour of failures |
 *
 * Nothing in the outbox expires. A tick flushes only when items that are not held are due (or for the heartbeat).
 */
import type { IngestBatch, IngestItem, IngestResult } from '@ziyixi/proto/recall/ingest/v1/ingest_wire';
import type { CaptureDiagnostic } from '@ziyixi/proto/recall/ingest/v1/diagnostic_wire';
import type { Context } from './context.ts';
import { browserFeatures } from './browser.ts';
import { countItems, getToken, oldestItems, settleItems, type OutboxItem } from './db.ts';
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  BATCH_MAX_ITEMS,
  BATCH_MAX_JSON_BYTES,
  BATCH_MAX_WIRE_BYTES,
  ERROR_REPORTED_MS,
  FAILING_BADGE_MS,
  FLUSH_INTERVAL_MS,
  FLUSH_ITEMS,
  HEARTBEAT_MS,
  RETRY_AFTER_MAX_MS,
  UNSUPPORTED_HOLD_MS,
  UPLOAD_TIMEOUT_MS,
} from './limits.ts';
import { getDevice, lastError, ownerDenylist, uploadState, type Device, type UploadState } from './store.ts';
import { isoTime } from './visits.ts';

export const BATCHES_PATH = '/api/machine/v1/batches';
/** Room left in a batch's JSON for its envelope (the device's report, at most a few hundred bytes). */
const ENVELOPE_BYTES = 4096;

export type FlushReason = 'tick' | 'startup' | 'manual';

/** What a flush did: nothing (`idle`), or the HTTP status of its upload (`network` when none came). */
export type FlushOutcome = { readonly kind: 'idle' } | { readonly kind: 'sent'; readonly items: number; readonly status: number | 'network' };

/** What a batch says of the device besides its items. */
export interface BatchHeader {
  readonly batchId: string;
  readonly sentMs: number;
  readonly device: Device;
  /** The extension's version (the manifest's, in Chrome's form). */
  readonly version: string;
  /** Items in the outbox, this batch's included. */
  readonly queued: number;
  /** The last error code of the past day, or ''. */
  readonly errorCode: string;
  readonly mobile?: boolean;
}

/** A batch of outbox items, as recall.ingest.v1 wire JSON. */
export function batchOf(header: BatchHeader, items: readonly OutboxItem[]): IngestBatch {
  const { device, errorCode } = header;
  return {
    version: 'recall-ingest-v1',
    batch_id: header.batchId,
    sent_time: isoTime(header.sentMs),
    device: {
      device_id: device.id,
      ...(header.mobile ? { mobile: true } : {}),
      label: device.label,
      extension_version: header.version,
      queued_count: header.queued,
      ...(errorCode === '' ? {} : { last_error_code: errorCode }),
    },
    items: items.map((item) => JSON.parse(item.json) as IngestItem),
  };
}

export async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** An owner diagnostic uses the existing authenticated route, without taking or settling any outbox items. */
export async function sendDiagnostic(ctx: Context, diagnostic: CaptureDiagnostic): Promise<boolean> {
  const [token, device, queued] = await Promise.all([getToken(ctx.db), getDevice(ctx.chrome, ctx.uuid), countItems(ctx.db)]);
  if (token === '') return false;
  const batch: IngestBatch = { ...batchOf({ batchId: ctx.uuid(), sentMs: ctx.now(), device, version: ctx.build, queued, errorCode: '', mobile: true }, []), diagnostic };
  try {
    const response = await ctx.fetch(`${device.server}${BATCHES_PATH}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip' }, body: await gzip(JSON.stringify(batch)),
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    return response.status === 200 && await readResult(response) !== null;
  } catch {
    return false;
  }
}

/** A Retry-After header (seconds or an HTTP date) in milliseconds from `at`, or null. */
export function retryAfterMs(header: string | null, at: number): number | null {
  if (header === null || header.trim() === '') return null;
  const value = header.trim();
  const ms = /^[0-9]+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - at;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), RETRY_AFTER_MAX_MS) : null;
}

/** recall's answer to an upload it took, or null when it does not read as one. */
async function readResult(response: Response): Promise<IngestResult | null> {
  try {
    const value = (await response.json()) as Partial<IngestResult> | null;
    if (
      typeof value?.accepted_count !== 'number' ||
      !Array.isArray(value.rejected) ||
      !Array.isArray(value.denylist_patterns) ||
      !value.denylist_patterns.every((pattern: unknown) => typeof pattern === 'string') ||
      typeof value.denylist_etag !== 'string' ||
      !(value.site_only_patterns === undefined || (Array.isArray(value.site_only_patterns) && value.site_only_patterns.every((pattern: unknown) => typeof pattern === 'string')))
    ) {
      return null;
    }
    return value as IngestResult;
  } catch {
    return null;
  }
}

/** The next backoff after a failure. */
function failed(upload: UploadState, at: number): UploadState {
  const backoffMs = upload.backoffMs === 0 ? BACKOFF_MIN_MS : Math.min(upload.backoffMs * 2, BACKOFF_MAX_MS);
  return { ...upload, backoffMs, nextAttemptAt: at + backoffMs, failingSince: upload.failingSince === 0 ? at : upload.failingSince };
}

/** The state after an answer (anything but 200). */
function afterRefusal(upload: UploadState, response: Response, sent: number, at: number): UploadState {
  const { status } = response;
  if (status === 401) return { ...upload, tokenRefused: true };
  if (status === 413 && sent > 1) return { ...upload, batchLimit: Math.max(1, Math.floor(sent / 2)) };
  if (status === 429 || status === 503) {
    const wait = retryAfterMs(response.headers.get('retry-after'), at);
    if (wait === null) return failed(upload, at);
    const failingSince = status === 503 && upload.failingSince === 0 ? at : upload.failingSince;
    return { ...upload, nextAttemptAt: at + wait, failingSince };
  }
  return failed(upload, at);
}

/** Whether the flush has something to send: items that are due (`ready` of them are not held), or a heartbeat. */
function due(reason: FlushReason, ready: number, upload: UploadState, at: number, mobile: boolean): boolean {
  if (reason !== 'tick') return true;
  const sinceUpload = at - upload.lastUploadAt;
  return ready > 0 ? ready >= FLUSH_ITEMS || sinceUpload >= (mobile ? 60_000 : FLUSH_INTERVAL_MS) : sinceUpload >= HEARTBEAT_MS;
}

/** One upload, when one is due: the outbox's oldest items, or the heartbeat. */
export async function flush(ctx: Context, at: number, reason: FlushReason): Promise<FlushOutcome> {
  const [token, upload, queued] = await Promise.all([getToken(ctx.db), uploadState.get(ctx.chrome), countItems(ctx.db)]);
  if (token === '' || upload.tokenRefused || (reason !== 'manual' && at < upload.nextAttemptAt)) return { kind: 'idle' };
  let items = queued === 0 ? [] : await oldestItems(ctx.db, upload.batchLimit, BATCH_MAX_JSON_BYTES - ENVELOPE_BYTES, at);
  if (!due(reason, items.length, upload, at, ctx.mobile === true)) return { kind: 'idle' };
  const [device, error] = await Promise.all([getDevice(ctx.chrome, ctx.uuid), lastError.get(ctx.chrome)]);
  const header: BatchHeader = {
    mobile: ctx.mobile === true,
    batchId: ctx.uuid(),
    sentMs: at,
    device,
    version: ctx.build,
    queued,
    errorCode: error !== null && at - error.at < ERROR_REPORTED_MS ? error.code : '',
  };

  let body = await gzip(JSON.stringify(batchOf(header, items)));
  // Text that hardly compresses can pass the wire's bound: fewer items, still at least one.
  while (body.byteLength > BATCH_MAX_WIRE_BYTES && items.length > 1) {
    items = items.slice(0, Math.ceil(items.length / 2));
    body = await gzip(JSON.stringify(batchOf(header, items)));
  }

  let response: Response | null;
  try {
    response = await ctx.fetch(`${device.server}${BATCHES_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip' },
      body,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch {
    response = null;
  }
  const result = response?.status === 200 ? await readResult(response) : null;
  // The answer applies to the state as it is now: the owner may have saved another token during the upload.
  const [current, tokenNow] = await Promise.all([uploadState.get(ctx.chrome), getToken(ctx.db)]);
  if (result !== null) {
    // An item only a newer recall reads waits in the outbox; any other refusal is lost (recall counts it too).
    const unsupported = result.rejected.filter((item) => item.reason === 'unsupported_item');
    await settleItems(ctx.db, items, 'remove', { ids: new Set(unsupported.map((item) => item.id)), until: at + UNSUPPORTED_HOLD_MS });
    const denylist = await ownerDenylist.get(ctx.chrome);
    if (denylist.etag !== result.denylist_etag) {
      await ownerDenylist.set(ctx.chrome, { patterns: result.denylist_patterns, siteOnly: result.site_only_patterns ?? [], etag: result.denylist_etag });
    }
    await uploadState.set(ctx.chrome, {
      ...current,
      lastUploadAt: at,
      nextAttemptAt: 0,
      backoffMs: 0,
      failingSince: 0,
      batchLimit: Math.min(BATCH_MAX_ITEMS, current.batchLimit * 2),
      rejectedCount: current.rejectedCount + result.rejected.length - unsupported.length,
    });
    return { kind: 'sent', items: items.length, status: 200 };
  }
  await settleItems(ctx.db, items, 'attempt');
  // A refusal of a token the owner has since replaced says nothing about the new one.
  if (response?.status === 401 && tokenNow !== token) return { kind: 'sent', items: items.length, status: 401 };
  const next = response === null || response.status === 200 ? failed(current, at) : afterRefusal(current, response, items.length, at);
  await uploadState.set(ctx.chrome, next);
  if (next.failingSince !== 0 && current.failingSince === 0) await lastError.set(ctx.chrome, 'upload_failed', at);
  return { kind: 'sent', items: items.length, status: response?.status ?? 'network' };
}

/** The action's badge: `!` while the token is refused or the uploads failed for an hour; a click opens the options. */
export async function showBadge(ctx: Context, at: number): Promise<void> {
  const upload = await uploadState.get(ctx.chrome);
  const failing = upload.failingSince !== 0 && at - upload.failingSince >= FAILING_BADGE_MS;
  const text = upload.tokenRefused || failing ? '!' : '';
  const features = browserFeatures(ctx.chrome);
  const action = features.action ?? features.browserAction;
  if (action === undefined) return;
  await action.setBadgeText({ text });
  if (text !== '') {
    await action.setBadgeBackgroundColor({ color: '#9a5b08' });
    await action.setTitle({ title: upload.tokenRefused ? 'recall：令牌无效' : 'recall：上传失败' });
  } else {
    await action.setTitle({ title: 'recall' });
  }
}
