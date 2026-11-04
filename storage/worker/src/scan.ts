import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { ClientSchema } from '@ziyixi/proto/storage/ui/v1/client_pb';
import { formatMatches } from '@ziyixi/proto/wire-json';
import type { Dropbox } from './dropbox.ts';
import { failure } from './errors.ts';
import { NAMESPACES_ROOT } from './keys.ts';
import type { Store } from './store.ts';

/** Objects and their bytes; the recent ones were written in the seven days before the scan started. */
export interface Totals {
  objects: number;
  bytes: number;
  recentObjects: number;
  recentBytes: number;
}

export interface FolderTotals extends Totals { readonly name: string }
export interface NamespaceTotals extends Totals { readonly name: string; readonly folders: FolderTotals[] }

/** The owner's object scan: one metadata value, rewritten with each page's totals and continuation. */
export interface Scan {
  readonly id: string;
  state: 'running' | 'succeeded' | 'failed';
  /** Milliseconds, like every time here. */
  readonly start: number;
  update: number;
  /** 0 while running. */
  end: number;
  /** Dropbox's continuation; empty before the first page. */
  cursor: string;
  pages: number;
  runs: number;
  /** Transient failures of the current page in a row. */
  retries: number;
  /** The Storage reason of a failed scan. */
  reason: string;
  objects: number;
  bytes: number;
  readonly namespaces: NamespaceTotals[];
}

/** Dropbox's approximate page size; a page of 1,000 file entries is about half a MiB of JSON. */
export const SCAN_PAGE_LIMIT = 1000;
/** With one token refresh, 41 of the 50 subrequests one Durable Object invocation may make. */
export const SCAN_PAGES_PER_RUN = 40;
export const SCAN_RUN_MS = 60_000;
/** About a million objects in 25 runs; a longer listing stops instead of spending the account's free quota. */
export const SCAN_MAX_PAGES = 1000;
/** A running scan that has not moved for this long has stopped and can be started again. */
export const SCAN_STALE_MS = 10 * 60_000;
export const SCAN_NEXT_RUN_MS = 1_000;
const RECENT_MS = 7 * 86_400_000;
const MAX_NAMESPACES = 64;
const MAX_FOLDERS = 32;
const MAX_RETRIES = 3;
const RETRY_MS = 30_000;
const MAX_RETRY_MS = 5 * 60_000;
const KEY = 'object_scan';

export function storedScan(store: Pick<Store, 'get'>): Scan | null { return store.get(KEY) as Scan | null; }

/** A new scan, or the running one; the caller schedules the first run of a new scan. */
export function startScan(store: Pick<Store, 'get' | 'set'>, now = Date.now()): { readonly scan: Scan; readonly started: boolean } {
  const current = storedScan(store);
  if (current?.state === 'running' && now - current.update < SCAN_STALE_MS) return { scan: current, started: false };
  const scan: Scan = {
    id: crypto.randomUUID(), state: 'running', start: now, update: now, end: 0, cursor: '', pages: 0, runs: 0, retries: 0,
    reason: '', objects: 0, bytes: 0, namespaces: [],
  };
  store.set(KEY, scan);
  return { scan, started: true };
}

function add(totals: Totals, size: number, recent: boolean): void {
  totals.objects++;
  totals.bytes += size;
  if (recent) { totals.recentObjects++; totals.recentBytes += size; }
}

/** The named totals in a list, added while the list holds fewer than `limit`; null once it is full. */
function entry<T extends { readonly name: string }>(list: T[], name: string, limit: number, create: () => T): T | null {
  const found = list.find((item) => item.name === name);
  if (found !== undefined) return found;
  if (list.length >= limit) return null;
  const created = create();
  list.push(created);
  return created;
}

const zero = (): Totals => ({ objects: 0, bytes: 0, recentObjects: 0, recentBytes: 0 });

/**
 * Adds one page's files by namespace and by the first segment of their keys. Every entry is checked before any is
 * added. An object outside a namespace folder counts only in the scan's totals.
 */
export function addPage(scan: Scan, entries: unknown): void {
  if (!Array.isArray(entries)) throw failure(Code.UNAVAILABLE, 'PROVIDER_RESPONSE_INVALID');
  const files: { readonly path: string; readonly size: number; readonly recent: boolean }[] = [];
  for (const value of entries as unknown[]) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw failure(Code.UNAVAILABLE, 'PROVIDER_RESPONSE_INVALID');
    const item = value as Record<string, unknown>;
    if (item['.tag'] !== 'file') continue;
    if (typeof item.path_lower !== 'string' || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0) {
      throw failure(Code.UNAVAILABLE, 'PROVIDER_RESPONSE_INVALID');
    }
    const modified = typeof item.server_modified === 'string' ? Date.parse(item.server_modified) : Number.NaN;
    files.push({ path: item.path_lower, size: item.size, recent: modified >= scan.start - RECENT_MS });
  }
  for (const file of files) {
    scan.objects++;
    scan.bytes += file.size;
    const parts = file.path.startsWith(NAMESPACES_ROOT + '/') ? file.path.slice(NAMESPACES_ROOT.length + 1).split('/') : [];
    const name = parts[0] ?? '';
    if (parts.length < 2 || !formatMatches(ClientSchema.file, 'Namespace', name)) continue;
    const namespace = entry(scan.namespaces, name, MAX_NAMESPACES, () => ({ name, ...zero(), folders: [] }));
    if (namespace === null) continue;
    add(namespace, file.size, file.recent);
    // An object at the namespace's root has the folder ''.
    const folderName = parts.length > 2 ? parts[1] ?? '' : '';
    const folder = entry(namespace.folders, folderName, MAX_FOLDERS, () => ({ name: folderName, ...zero() }));
    if (folder !== null) add(folder, file.size, file.recent);
  }
}

function retryDelay(error: RpcError): number {
  const seconds = Number(error.headers['retry-after']);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(MAX_RETRY_MS, Math.max(1_000, seconds * 1000)) : RETRY_MS;
}

/**
 * One alarm run of the running scan: at most 40 pages or a minute. Each page's totals are written with its
 * continuation, so an interrupted run repeats at most one page. Answers when the next run should start, or null
 * once the scan ended or another replaced it. Never throws: a failure ends the scan with its reason.
 */
export async function runScan(store: Pick<Store, 'get' | 'set'>, dropbox: Pick<Dropbox, 'scanPage'>, now = (): number => Date.now()): Promise<number | null> {
  const scan = storedScan(store);
  if (scan?.state !== 'running') return null;
  const begun = now();
  scan.runs++;
  const end = (state: 'succeeded' | 'failed', reason = ''): null => {
    scan.state = state;
    scan.reason = reason;
    scan.end = now();
    scan.update = scan.end;
    store.set(KEY, scan);
    return null;
  };
  for (let page = 0; page < SCAN_PAGES_PER_RUN && now() - begun < SCAN_RUN_MS; page++) {
    if (scan.pages >= SCAN_MAX_PAGES) return end('failed', 'SCAN_PAGE_LIMIT');
    let next: { readonly more: boolean; readonly cursor: string };
    try {
      const answer = scan.cursor === ''
        ? await dropbox.scanPage('files/list_folder', {
          path: NAMESPACES_ROOT, recursive: true, include_deleted: false, include_non_downloadable_files: false, limit: SCAN_PAGE_LIMIT,
        })
        : await dropbox.scanPage('files/list_folder/continue', { cursor: scan.cursor });
      if (storedScan(store)?.id !== scan.id) return null;
      if (typeof answer.has_more !== 'boolean' || typeof answer.cursor !== 'string' || (answer.has_more && answer.cursor === '')) {
        throw failure(Code.UNAVAILABLE, 'PROVIDER_RESPONSE_INVALID');
      }
      addPage(scan, answer.entries);
      next = { more: answer.has_more, cursor: answer.cursor };
    } catch (error) {
      if (storedScan(store)?.id !== scan.id) return null;
      const reason = error instanceof RpcError ? error.reason : 'INTERNAL';
      // No namespace has written an object yet.
      if (reason === 'NOT_FOUND' && scan.cursor === '') return end('succeeded');
      if (reason === 'UNAVAILABLE' && error instanceof RpcError && scan.retries < MAX_RETRIES) {
        scan.retries++;
        scan.update = now();
        store.set(KEY, scan);
        return scan.update + retryDelay(error);
      }
      return end('failed', reason);
    }
    scan.retries = 0;
    scan.pages++;
    scan.cursor = next.cursor;
    scan.update = now();
    if (!next.more) return end('succeeded');
    store.set(KEY, scan);
  }
  return now() + SCAN_NEXT_RUN_MS;
}
