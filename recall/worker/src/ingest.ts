/**
 * One upload (POST /api/machine/v1/batches, ../../docs/design.md §4), run by RecallState after the Worker checked the
 * ingest token and the size: the gzipped body read with a 4 MiB cap, the batch read strictly (proto/recall/ingest/v1),
 * then per item:
 *
 * 1. the item read strictly and checked against the rules the IDL cannot state (times, spans, the URL); an item that
 *    breaks one is refused alone (`invalid_item`), never for its age or its length; an item that reads only with
 *    members or a kind this build does not know is a newer extension's (`unsupported_item`: the extension keeps it);
 * 2. the denylist again (shared/denylist.ts), the owner's two lists included: recall's own pages dropped, a site-only
 *    page reduced to its site's root URL (its page ID computed again from it) without a title or text, a no-text
 *    page's text dropped;
 * 3. every string scrubbed again (shared/scrub.ts) and cut to its bound;
 * 4. skipped, as accepted, when it changes nothing: a visit revision not above the stored one, a second capture of a
 *    page on its UTC day, a capture with the page's latest text, a visit or capture that began before its page's
 *    deletion (the device's time moved to recall's clock by the batch's skew first); refused as `id_conflict` when
 *    recall holds its ID with other content.
 *
 * The kept texts go to R2 first (gzip, with R2's SHA-256 check), then one transaction writes every row: the device,
 * the pages and sites, each new or changed visit and document with the feed's next seq, and the index rows. If the
 * transaction fails after an R2 put, a retry writes the same key again; nothing refers to an object before its row. A
 * text the transaction does not keep after all (its page deleted by the owner while the puts ran) is deleted again.
 * Uploads are refused with 429 once today's rows written pass the daily budget.
 *
 * Logs hold the batch ID, counts and codes only: never a URL, host, title or text.
 */
import { ChangeSchema, type Change } from '@ziyixi/proto/recall/archive/v1/archive_pb';
import { IngestBatchSchema, IngestItem_Kind, IngestItemSchema, IngestResultSchema, RejectedItemSchema, type DocumentItem, type IngestItem, type VisitItem } from '@ziyixi/proto/recall/ingest/v1/ingest_pb';
import { create } from '@ziyixi/proto/protobuf';
import { timestampMs } from '@ziyixi/proto/protobuf/wkt';
import { fieldRules, fromWire, toWire, WireJsonError } from '@ziyixi/proto/wire-json';
import { denyLevel, routePaths, type DenyLevel, type OwnerPatterns } from '../../shared/denylist.ts';
import { scrubText, scrubUrl } from '../../shared/scrub.ts';
import { cutText, cutUrl, cutUtf8, DOCUMENT_MAX_BYTES, pageIdOf, rootUrl, siteOf } from '../../shared/url.ts';
import { machineError, machineJson, type MachineAnswer } from './answers.ts';
import { deleteBlobs, putText, storedText, textBlobPath, type StoredText } from './blobs.ts';
import { documentChange, visitChange } from './feed.ts';
import { indexedPart, writeIndexRow } from './fts.ts';
import { BATCH_MAX_JSON_BYTES, CLOCK_SKEW_RECORDED_MS, DAILY_ROW_BUDGET, DAY, ITEM_CLOCK_LEEWAY_MS, OVER_BUDGET_JITTER_MS, VERSION_PART_MAX, VISIT_MAX_MS } from './limits.ts';
import { ownerPatterns, readDenylist } from './settings.ts';
import { addDelta, hostKey, nextUtcMidnight, utcDay, type CounterDeltas, type DocumentRow, type PageRow, type Store, type VisitRow } from './store.ts';

export type RejectReason = 'invalid_item' | 'id_conflict' | 'unsupported_item';

/** The reasons whose items are lost (the extension drops them); an `unsupported_item` waits in its outbox. */
export const LOST_REASONS: readonly string[] = ['invalid_item', 'id_conflict'];

/** What one upload needs of RecallState. */
export interface IngestContext {
  readonly store: Store;
  readonly bucket: R2Bucket;
  readonly now: number;
  readonly transact: <T>(fn: () => T) => T;
  /** Hosts recall never records: its PUBLIC_HOST and the extension's build constant. */
  readonly ownHosts: readonly string[];
  readonly requestId: string;
  /** Test hook: throws between the R2 puts and the transaction (DEV_MANUAL_ALARMS only). */
  readonly failBeforeCommit?: () => boolean;
}

/** The device of a batch, as every record it writes names it. */
interface Device {
  readonly id: string;
  readonly label: string;
}

interface Envelope {
  readonly batchId: string;
  readonly sentMs: number;
  readonly device: Device & { readonly version: string; readonly queued: number; readonly lastError: string };
  readonly items: readonly unknown[];
}

interface VisitPlan {
  readonly kind: 'visit';
  /** Whether its page keeps its text, is recorded without it or by its site alone. */
  readonly level: Exclude<DenyLevel, 'never'>;
  readonly id: string;
  readonly revision: number;
  readonly pageId: string;
  readonly url: string;
  readonly urlTruncated: boolean;
  readonly title: string;
  /** The URL's site (its host without a leading `www.`): the page's and the site row's key. */
  readonly site: string;
  readonly spans: readonly (readonly [number, number])[];
  readonly startMs: number;
  readonly endMs: number;
  readonly focusSeconds: number;
  /** The start on recall's clock (the device's moved by the batch's skew), for the deletion ledger. */
  readonly serverStartMs: number;
}

interface DocumentPlan {
  readonly kind: 'document';
  readonly id: string;
  readonly visitId: string;
  readonly pageId: string;
  readonly url: string;
  readonly urlTruncated: boolean;
  readonly title: string;
  readonly description: string;
  readonly site: string;
  readonly captureMs: number;
  /** The capture time on recall's clock, for the deletion ledger. */
  readonly serverCaptureMs: number;
  readonly text: string;
  readonly truncated: boolean;
  readonly stored: StoredText;
  readonly blobPath: string;
}

type Plan = VisitPlan | DocumentPlan;
/**
 * What an item comes to before the transaction. A skip that `captured` is a capture of a page that keeps its text,
 * skipped because recall has that text already (the page's latest, or its capture of that day): the day still had one.
 */
type Outcome =
  | { readonly kind: 'skip'; readonly captured?: boolean }
  | { readonly kind: 'reject'; readonly reason: RejectReason }
  | { readonly kind: 'plan'; readonly plan: Plan };

const SKIP: Outcome = { kind: 'skip' };
const INVALID: Outcome = { kind: 'reject', reason: 'invalid_item' };
const UNSUPPORTED: Outcome = { kind: 'reject', reason: 'unsupported_item' };
/** A normalized, scrubbed URL as the archive's Url format allows it (ASCII, http or https). */
const URL_SHAPE = /^https?:\/\/[!-~]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ITEMS = fieldRules(IngestBatchSchema.field.items).maxItems;

/** Why a whole batch is refused. */
class BatchError extends Error {
  readonly reason: 'BAD_REQUEST' | 'PAYLOAD_TOO_LARGE';

  constructor(reason: 'BAD_REQUEST' | 'PAYLOAD_TOO_LARGE') {
    super(reason);
    this.reason = reason;
  }
}

// ---- reading -------------------------------------------------------------------------------------------------------

/** The gzipped body as text, at most BATCH_MAX_JSON_BYTES once decompressed. */
async function decompress(body: ArrayBuffer): Promise<string> {
  const reader = new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BATCH_MAX_JSON_BYTES) {
        await reader.cancel();
        throw new BatchError('PAYLOAD_TOO_LARGE');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BatchError) throw error;
    throw new BatchError('BAD_REQUEST');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await new Blob(chunks).arrayBuffer());
  } catch {
    throw new BatchError('BAD_REQUEST');
  }
}

/** The batch's envelope read strictly, its items left raw: each is read alone, so one bad item refuses only itself. */
function readEnvelope(text: string): Envelope {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BatchError('BAD_REQUEST');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new BatchError('BAD_REQUEST');
  const items: unknown = (json as Record<string, unknown>)['items'];
  if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new BatchError('BAD_REQUEST');
  let batch;
  try {
    batch = fromWire(IngestBatchSchema, { ...json, items: [] }, { strict: true }).message;
  } catch (error) {
    if (error instanceof WireJsonError) throw new BatchError('BAD_REQUEST');
    throw error;
  }
  const { device, sentTime } = batch;
  // A strict read has both (REQUIRED, non_null); the rule the IDL cannot state: each version part at most 65535.
  if (device === undefined || sentTime === undefined || device.extensionVersion.split('.').some((part) => Number(part) > VERSION_PART_MAX)) {
    throw new BatchError('BAD_REQUEST');
  }
  return {
    batchId: batch.batchId,
    sentMs: timestampMs(sentTime),
    device: { id: device.deviceId, label: device.label, version: device.extensionVersion, queued: device.queuedCount, lastError: device.lastErrorCode },
    items,
  };
}

/** The UUID an item names in the body its kind names (a kind this build does not know too), for its refusal. */
function rawItemId(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return '';
  const record = raw as Record<string, unknown>;
  const kind = record['kind'];
  const body = typeof kind === 'string' && kind !== 'kind' && Object.hasOwn(record, kind) ? record[kind] : undefined;
  const id = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['id'] : undefined;
  return typeof id === 'string' && UUID.test(id) ? id : '';
}

// ---- rows ------------------------------------------------------------------------------------------------------------

function visitRow(plan: VisitPlan, seq: number, now: number, pageRowid: number, device: Device): VisitRow {
  return {
    id: plan.id,
    seq,
    seq_ms: now,
    page_rowid: pageRowid,
    device_id: device.id,
    device_label: device.label,
    url: plan.url,
    url_truncated: plan.urlTruncated ? 1 : 0,
    title: plan.title,
    start_ms: plan.startMs,
    end_ms: plan.endMs,
    focus_seconds: plan.focusSeconds,
    spans: JSON.stringify(plan.spans),
    revision: plan.revision,
  };
}

function documentRow(plan: DocumentPlan, seq: number, now: number, pageRowid: number, device: Device): DocumentRow {
  return {
    id: plan.id,
    seq,
    seq_ms: now,
    page_rowid: pageRowid,
    visit: plan.visitId,
    device_id: device.id,
    device_label: device.label,
    capture_ms: plan.captureMs,
    url: plan.url,
    url_truncated: plan.urlTruncated ? 1 : 0,
    title: plan.title,
    description: plan.description,
    blob_path: plan.blobPath,
    sha256: plan.stored.sha256,
    stored_bytes: plan.stored.gzip.byteLength,
    text_bytes: plan.stored.textBytes,
    text_sha256: plan.stored.textSha256,
    truncated: plan.truncated ? 1 : 0,
  };
}

// ---- planning (no database writes) ---------------------------------------------------------------------------------

/** The URL's host and the paths the denylist judges (its path, a hash router's route), when it is an http(s) URL. */
function parseUrl(url: string): { readonly host: string; readonly paths: readonly string[] } | null {
  if (!URL_SHAPE.test(url)) return null;
  try {
    const parsed = new URL(url);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') return null;
    return { host: parsed.hostname, paths: routePaths(parsed.pathname, parsed.hash) };
  } catch {
    return null;
  }
}

/** Whether a record renders as a feed line the archive's rules accept: the feed must never fail on a stored row. */
function renders(change: () => Change): boolean {
  try {
    toWire(ChangeSchema, change());
    return true;
  } catch (error) {
    if (error instanceof WireJsonError) return false;
    throw error;
  }
}

/** What reading an item needs: the batch, the owner's patterns, recall's own hosts, and the device's clock skew. */
interface Planning {
  readonly envelope: Envelope;
  readonly patterns: OwnerPatterns;
  readonly ownHosts: readonly string[];
  /** The device's clock minus recall's (the batch's sent_time against its arrival). */
  readonly skewMs: number;
}

async function planVisit(item: VisitItem, { envelope, patterns, ownHosts, skewMs }: Planning): Promise<Outcome> {
  const latest = envelope.sentMs + ITEM_CLOCK_LEEWAY_MS;
  const spans: [number, number][] = [];
  for (const span of item.focusSpans) {
    if (span.startTime === undefined || span.endTime === undefined) return INVALID;
    const start = timestampMs(span.startTime);
    const end = timestampMs(span.endTime);
    const previous = spans[spans.length - 1];
    if (end < start || end > latest || (previous !== undefined && start < previous[1])) return INVALID;
    spans.push([start, end]);
  }
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (first === undefined || last === undefined || last[1] - first[0] > VISIT_MAX_MS) return INVALID;
  const focusSeconds = Math.round(spans.reduce((sum, [start, end]) => sum + end - start, 0) / 1000);
  const parsed = parseUrl(item.url);
  if (focusSeconds < 1 || parsed === null) return INVALID;

  const level = denyLevel(parsed.host, parsed.paths, patterns, ownHosts);
  if (level === 'never') return SKIP;
  const base = {
    kind: 'visit',
    level,
    id: item.id,
    revision: item.revision,
    site: siteOf(parsed.host),
    spans,
    startMs: first[0],
    endMs: last[1],
    focusSeconds,
    serverStartMs: first[0] - skewMs,
  } as const;
  let plan: VisitPlan;
  if (level === 'site_only') {
    const root = rootUrl(item.url);
    if (root === null) return INVALID;
    plan = { ...base, pageId: await pageIdOf(root), url: root, urlTruncated: false, title: '' };
  } else {
    const url = cutUrl(scrubUrl(item.url));
    plan = { ...base, pageId: item.pageId, url: url.url, urlTruncated: item.urlTruncated || url.truncated, title: cutText(scrubText(item.title)) };
  }
  const row = visitRow(plan, 1, 0, 0, envelope.device);
  return renders(() => visitChange({ ...row, page_id: plan.pageId, host_key: hostKey(plan.site) })) ? { kind: 'plan', plan } : INVALID;
}

async function planDocument(item: DocumentItem, { envelope, patterns, ownHosts, skewMs }: Planning): Promise<Outcome> {
  if (item.captureTime === undefined) return INVALID;
  const captureMs = timestampMs(item.captureTime);
  const parsed = parseUrl(item.url);
  if (captureMs > envelope.sentMs + ITEM_CLOCK_LEEWAY_MS || parsed === null) return INVALID;
  // A page that is never recorded, recorded by its site alone or recorded without its text has no capture.
  if (denyLevel(parsed.host, parsed.paths, patterns, ownHosts) !== 'record') return SKIP;
  const url = cutUrl(scrubUrl(item.url));
  const text = cutUtf8(scrubText(item.text), DOCUMENT_MAX_BYTES);
  const plan: DocumentPlan = {
    kind: 'document',
    id: item.id,
    visitId: item.visitId,
    pageId: item.pageId,
    url: url.url,
    urlTruncated: item.urlTruncated || url.truncated,
    title: cutText(scrubText(item.title)),
    description: cutText(scrubText(item.description)),
    site: siteOf(parsed.host),
    captureMs,
    serverCaptureMs: captureMs - skewMs,
    text: text.text,
    truncated: item.textTruncated || text.truncated,
    stored: await storedText(text.text),
    blobPath: textBlobPath(captureMs, item.id),
  };
  const row = documentRow(plan, 1, 0, 0, envelope.device);
  return renders(() => documentChange({ ...row, page_id: plan.pageId, host_key: hostKey(plan.site) })) ? { kind: 'plan', plan } : INVALID;
}

/**
 * Whether an item the strict read refused reads leniently with members or a kind this build does not know: a newer
 * extension's item (an optional field, phase 2's `star`), which waits in the extension's outbox for a Worker that
 * reads it instead of being lost.
 */
function fromNewerBuild(raw: unknown): boolean {
  try {
    return fromWire(IngestItemSchema, raw).unrecognized.length > 0;
  } catch {
    return false;
  }
}

async function planItem(raw: unknown, planning: Planning): Promise<Outcome> {
  let item: IngestItem;
  try {
    item = fromWire(IngestItemSchema, raw, { strict: true }).message;
  } catch (error) {
    if (error instanceof WireJsonError) return fromNewerBuild(raw) ? UNSUPPORTED : INVALID;
    throw error;
  }
  if (item.kind === IngestItem_Kind.VISIT && item.visit !== undefined) return planVisit(item.visit, planning);
  if (item.kind === IngestItem_Kind.DOCUMENT && item.document !== undefined) return planDocument(item.document, planning);
  return INVALID;
}

// ---- applying (inside the transaction) ----------------------------------------------------------------------------

/** When the page was last deleted (its newest tombstone), or null. */
function deletedAt(store: Store, pageId: string): number | null {
  return store.one<{ t: number | null }>(`SELECT max(seq_ms) AS t FROM tombstones WHERE page_id = ?`, pageId)?.t ?? null;
}

function livePage(store: Store, pageId: string): PageRow | undefined {
  return store.one<PageRow>(`SELECT * FROM pages WHERE id = ?`, pageId);
}

/** The ID of the live page a row's page_rowid names, or undefined when that page was deleted. */
function pageIdOfRowid(store: Store, rowid: number): string | undefined {
  return store.one<{ id: string }>(`SELECT id FROM pages WHERE rowid = ?`, rowid)?.id;
}

/**
 * What a page's first record gives it: its URL, title and site, and its first visit's times and focus (a visit), or
 * its capture's time (a capture whose visit comes later).
 */
interface PageSeed {
  readonly pageId: string;
  readonly url: string;
  readonly urlTruncated: boolean;
  readonly title: string;
  readonly site: string;
  readonly visit: { readonly startMs: number; readonly endMs: number; readonly focusSeconds: number } | null;
  readonly captureMs?: number;
}

/**
 * A new page row, holding its first visit's totals, and its index row with its title and URL. A page a capture makes
 * takes the capture's time as its first and latest visit until its visit arrives (the owner was on it then), so a
 * page's latest visit is never null and the search's scan by it reaches every page.
 */
function createPage(store: Store, totals: CounterDeltas, seed: PageSeed): PageRow {
  const { visit } = seed;
  const row = store.one<PageRow>(
    `INSERT INTO pages (id, url, url_truncated, title, host_key, first_visit_ms, last_visit_ms, visit_count, focus_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    seed.pageId,
    seed.url,
    seed.urlTruncated ? 1 : 0,
    seed.title,
    hostKey(seed.site),
    visit?.startMs ?? seed.captureMs ?? null,
    visit?.endMs ?? seed.captureMs ?? null,
    visit === null ? 0 : 1,
    visit?.focusSeconds ?? 0,
  );
  if (row === undefined) throw new Error('page_insert_failed');
  writeIndexRow(store, row.rowid, seed.title, seed.url, '', false);
  addDelta(totals, 'page_count', 1);
  return row;
}

/** Adds a visit (or a revision's growth) to its site's totals, creating the site's row with its first page. */
function addToSite(store: Store, site: string, visits: number, focusDelta: number, startMs: number, endMs: number): void {
  store.run(
    `INSERT INTO sites (host, host_key, first_visit_ms, last_visit_ms, visit_count, focus_seconds) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (host) DO UPDATE SET visit_count = visit_count + excluded.visit_count, focus_seconds = focus_seconds + excluded.focus_seconds,
       first_visit_ms = coalesce(min(first_visit_ms, excluded.first_visit_ms), excluded.first_visit_ms),
       last_visit_ms = coalesce(max(last_visit_ms, excluded.last_visit_ms), excluded.last_visit_ms)`,
    site,
    hostKey(site),
    startMs,
    endMs,
    visits,
    focusDelta,
  );
}

interface Applied {
  readonly outcome: 'stored' | 'skip' | RejectReason;
  readonly newVisit?: boolean;
  /** A visit of a page that keeps its text reached ten seconds of focus: the day should have a capture. */
  readonly reachedTenSeconds?: boolean;
  /** A capture of a page that keeps its text arrived (stored, or skipped as a text recall has): see Outcome. */
  readonly captured?: boolean;
}

function applyVisit(store: Store, totals: CounterDeltas, plan: VisitPlan, nextSeq: () => number, now: number, device: Device): Applied {
  const deleted = deletedAt(store, plan.pageId);
  if (deleted !== null && plan.serverStartMs < deleted) return { outcome: 'skip' };
  const existing = store.one<{ revision: number; page_rowid: number; focus_seconds: number; start_ms: number }>(
    `SELECT revision, page_rowid, focus_seconds, start_ms FROM visits WHERE id = ?`,
    plan.id,
  );
  if (existing !== undefined) {
    const holder = pageIdOfRowid(store, existing.page_rowid);
    // Its page was deleted since: the alarm removes the row, and a late revision changes nothing.
    if (holder === undefined) return { outcome: 'skip' };
    if (holder !== plan.pageId) return { outcome: 'id_conflict' };
    if (plan.revision <= existing.revision) return { outcome: 'skip' };
  }
  const found = livePage(store, plan.pageId);
  const page = found ?? createPage(store, totals, { ...plan, visit: plan });
  const row = visitRow(plan, nextSeq(), now, page.rowid, device);
  if (existing === undefined) store.insert('visits', row);
  else {
    // A revision moves the record to its new seq; its start (indexed twice) rarely changes.
    const changes: Record<string, string | number> = {
      seq: row.seq,
      seq_ms: row.seq_ms,
      device_id: row.device_id,
      device_label: row.device_label,
      url: row.url,
      url_truncated: row.url_truncated,
      title: row.title,
      end_ms: row.end_ms,
      focus_seconds: row.focus_seconds,
      spans: row.spans,
      revision: row.revision,
    };
    if (row.start_ms !== existing.start_ms) changes['start_ms'] = row.start_ms;
    store.update('visits', 'id', plan.id, changes);
  }
  const added = existing === undefined ? 1 : 0;
  const focusDelta = plan.focusSeconds - (existing?.focus_seconds ?? 0);
  if (found !== undefined) {
    // Only what changes: the newest visit gives the page its URL and title (its index row is not rewritten for a title
    // alone, fts.ts) and its latest time (indexed twice).
    const changes: Record<string, string | number> = { visit_count: found.visit_count + added, focus_seconds: found.focus_seconds + focusDelta };
    if (found.first_visit_ms === null || plan.startMs < found.first_visit_ms) changes['first_visit_ms'] = plan.startMs;
    if (found.last_visit_ms === null || plan.endMs > found.last_visit_ms) changes['last_visit_ms'] = plan.endMs;
    if (found.last_visit_ms === null || plan.endMs >= found.last_visit_ms) Object.assign(changes, { url: plan.url, url_truncated: row.url_truncated, title: plan.title });
    store.update('pages', 'rowid', found.rowid, changes);
  }
  addToSite(store, plan.site, added, focusDelta, plan.startMs, plan.endMs);
  addDelta(totals, 'visit_count', added);
  const reachedTenSeconds = plan.level === 'record' && (existing?.focus_seconds ?? 0) < 10 && plan.focusSeconds >= 10;
  return { outcome: 'stored', newVisit: added === 1, reachedTenSeconds };
}

/** Why a capture changes nothing (a replay, a deleted page, its page's capture of that day, the latest text), or null. */
function documentSkip(store: Store, plan: DocumentPlan): Applied | null {
  const existing = store.one<{ page_rowid: number; text_sha256: string }>(`SELECT page_rowid, text_sha256 FROM documents WHERE id = ?`, plan.id);
  if (existing !== undefined) {
    const holder = pageIdOfRowid(store, existing.page_rowid);
    if (holder === undefined) return { outcome: 'skip' };
    return holder === plan.pageId && existing.text_sha256 === plan.stored.textSha256 ? { outcome: 'skip' } : { outcome: 'id_conflict' };
  }
  const deleted = deletedAt(store, plan.pageId);
  if (deleted !== null && plan.serverCaptureMs < deleted) return { outcome: 'skip' };
  const page = livePage(store, plan.pageId);
  if (page === undefined) return null;
  if (page.latest_text_sha256 === plan.stored.textSha256) return { outcome: 'skip', captured: true };
  const dayStart = Math.floor(plan.captureMs / DAY) * DAY;
  const sameDay = store.one(`SELECT 1 AS x FROM documents WHERE page_rowid = ? AND capture_ms >= ? AND capture_ms < ? LIMIT 1`, page.rowid, dayStart, dayStart + DAY);
  return sameDay === undefined ? null : { outcome: 'skip', captured: true };
}

function applyDocument(store: Store, totals: CounterDeltas, plan: DocumentPlan, nextSeq: () => number, now: number, device: Device): Applied {
  const skip = documentSkip(store, plan);
  if (skip !== null) return skip;
  let page = livePage(store, plan.pageId);
  if (page === undefined) {
    store.run(`INSERT INTO sites (host, host_key) VALUES (?, ?) ON CONFLICT (host) DO NOTHING`, plan.site, hostKey(plan.site));
    page = createPage(store, totals, { ...plan, visit: null });
  }
  const row = documentRow(plan, nextSeq(), now, page.rowid, device);
  store.insert('documents', row);
  addDelta(totals, 'document_count', 1);
  addDelta(totals, 'blob_bytes', row.stored_bytes);
  if (page.latest_capture_ms === null || plan.captureMs >= page.latest_capture_ms) {
    // The page's newest capture: its index row is written again with this text (and the page's current title).
    const indexed = indexedPart(plan.text);
    writeIndexRow(store, page.rowid, page.title, page.url, indexed.text, true);
    addDelta(totals, 'indexed_text_bytes', indexed.bytes - page.text_indexed);
    store.run(
      `UPDATE pages SET document_count = document_count + 1, latest_document = ?, latest_capture_ms = ?, latest_text_sha256 = ?, text_indexed = ? WHERE rowid = ?`,
      plan.id,
      plan.captureMs,
      plan.stored.textSha256,
      indexed.bytes,
      page.rowid,
    );
  } else {
    store.run(`UPDATE pages SET document_count = document_count + 1 WHERE rowid = ?`, page.rowid);
  }
  return { outcome: 'stored', captured: true };
}

// ---- the upload ------------------------------------------------------------------------------------------------------

function overBudget(ctx: IngestContext, day: string): MachineAnswer {
  const { store } = ctx;
  if (store.usage(day).over_budget === 0) {
    ctx.transact(() => {
      store.markOverBudget(day);
      store.pushError('upload_over_budget');
      store.chargeRows(day);
    });
  }
  const retryAfter = Math.ceil((nextUtcMidnight(ctx.now) - ctx.now + Math.random() * OVER_BUDGET_JITTER_MS) / 1000);
  return machineError('UPLOAD_OVER_BUDGET', ctx.requestId, { 'retry-after': String(retryAfter) });
}

/** Texts recall already has, or that change nothing, are skipped before their R2 write (and stay skipped). */
function skipKnownTexts(store: Store, entries: readonly { outcome: Outcome }[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.outcome.kind !== 'plan' || entry.outcome.plan.kind !== 'document') continue;
    const plan = entry.outcome.plan;
    const pageDay = `${plan.pageId}:${utcDay(plan.captureMs)}`;
    const skip = documentSkip(store, plan);
    if (skip !== null) entry.outcome = skip.outcome === 'skip' ? { kind: 'skip', captured: skip.captured === true } : { kind: 'reject', reason: 'id_conflict' };
    // Two captures of one page on one UTC day in one batch: the first is kept.
    else if (seen.has(pageDay)) entry.outcome = { kind: 'skip', captured: true };
    seen.add(pageDay);
  }
}

/** The answer to one upload (the body as the Worker read it: gzip, at most 1 MiB). */
export async function ingestBatch(ctx: IngestContext, body: ArrayBuffer): Promise<MachineAnswer> {
  const { store, now } = ctx;
  const day = utcDay(now);
  if (store.usage(day).rows_written >= DAILY_ROW_BUDGET) return overBudget(ctx, day);

  let envelope: Envelope;
  try {
    envelope = readEnvelope(await decompress(body));
  } catch (error) {
    if (error instanceof BatchError) return machineError(error.reason, ctx.requestId);
    throw error;
  }
  const denylist = readDenylist(store);
  const planning: Planning = { envelope, patterns: ownerPatterns(denylist), ownHosts: ctx.ownHosts, skewMs: envelope.sentMs - now };
  const entries: { readonly id: string; outcome: Outcome }[] = [];
  for (const raw of envelope.items) entries.push({ id: rawItemId(raw), outcome: await planItem(raw, planning) });
  skipKnownTexts(store, entries);
  try {
    for (const { outcome } of entries) {
      if (outcome.kind === 'plan' && outcome.plan.kind === 'document') await putText(ctx.bucket, outcome.plan.blobPath, outcome.plan.stored);
    }
  } catch {
    ctx.transact(() => {
      store.pushError('r2_unavailable');
      store.chargeRows(day);
    });
    console.log(JSON.stringify({ event: 'upload', batch_id: envelope.batchId, request_id: ctx.requestId, code: 'r2_unavailable' }));
    return machineError('UNAVAILABLE', ctx.requestId, { 'retry-after': '60' });
  }
  if (ctx.failBeforeCommit?.() === true) throw new Error('test_crash_before_commit');

  const rejected: { id: string; reason: RejectReason }[] = [];
  /**
   * Texts put to R2 that the transaction did not keep after all: the owner deleted their page while the puts ran, or an
   * earlier capture of the same batch already holds the same text.
   */
  const unkept: string[] = [];
  let accepted = 0;
  const writtenBefore = store.rowsWritten;
  ctx.transact(() => {
    const seqs = store.seqs();
    const totals: CounterDeltas = {};
    const skew = envelope.sentMs - now;
    store.run(
      `INSERT INTO devices (id, label, extension_version, first_seen_ms, last_seen_ms, queued_count, last_error_code, clock_skew_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET label = excluded.label, extension_version = excluded.extension_version, last_seen_ms = excluded.last_seen_ms,
         queued_count = excluded.queued_count, last_error_code = excluded.last_error_code, clock_skew_s = excluded.clock_skew_s`,
      envelope.device.id,
      envelope.device.label,
      envelope.device.version,
      now,
      now,
      envelope.device.queued,
      envelope.device.lastError,
      Math.abs(skew) > CLOCK_SKEW_RECORDED_MS ? Math.round(skew / 1000) : 0,
    );
    let visits = 0;
    let longVisits = 0;
    let captures = 0;
    let texts = 0;
    for (const { id, outcome } of entries) {
      let applied: Applied;
      if (outcome.kind === 'skip') applied = { outcome: 'skip', captured: outcome.captured === true };
      else if (outcome.kind === 'reject') applied = { outcome: outcome.reason };
      else if (outcome.plan.kind === 'visit') applied = applyVisit(store, totals, outcome.plan, seqs.next, now, envelope.device);
      else applied = applyDocument(store, totals, outcome.plan, seqs.next, now, envelope.device);
      if (applied.outcome === 'stored' || applied.outcome === 'skip') accepted += 1;
      else rejected.push({ id, reason: applied.outcome });
      if (applied.newVisit === true) visits += 1;
      if (applied.reachedTenSeconds === true) longVisits += 1;
      if (applied.captured === true) captures += 1;
      if (outcome.kind === 'plan' && outcome.plan.kind === 'document') {
        if (applied.outcome === 'stored') texts += 1;
        else if (store.one(`SELECT 1 AS x FROM documents WHERE id = ?`, outcome.plan.id) === undefined) unkept.push(outcome.plan.blobPath);
      }
    }
    seqs.commit();
    store.addCounters(totals);
    store.addRefusals(
      day,
      rejected.map((item) => item.reason),
      now,
    );
    store.chargeRows(day, { batches: 1, items: entries.length, visits, long_visits: longVisits, captures, texts });
  });
  if (unkept.length > 0) {
    // No row names these objects, and none ever will (a retry is skipped the same way): a text of a page the owner
    // deleted must not stay behind in the bucket.
    try {
      await deleteBlobs(ctx.bucket, unkept);
    } catch {
      ctx.transact(() => {
        store.pushError('r2_cleanup_failed');
      });
    }
  }
  // Counts and codes only: never a URL, host, title or text.
  const rowsWritten = store.rowsWritten - writtenBefore;
  console.log(JSON.stringify({ event: 'upload', batch_id: envelope.batchId, request_id: ctx.requestId, accepted, rejected: rejected.length, rows_written: rowsWritten, code: 'ok' }));
  const result = create(IngestResultSchema, {
    acceptedCount: accepted,
    rejected: rejected.map((item) => create(RejectedItemSchema, item)),
    denylistPatterns: [...denylist.patterns],
    denylistEtag: denylist.etag,
    siteOnlyPatterns: [...denylist.siteOnly],
  });
  return machineJson(JSON.stringify(toWire(IngestResultSchema, result)));
}
