/**
 * The extension's IndexedDB, `recall` (../../docs/design.md §3.3, §3.8). Its origin is the extension's ID, which the
 * manifest's key keeps stable, so it survives reloads and updates; removing the extension deletes it. Three stores:
 *
 * - `visits`: the open visits, at most one per tab (index `tabId`); a visit leaves the store when it ends;
 * - `outbox`: the items waiting for an upload, by the visit's or the document's ID (index `queued`, oldest first): a
 *   visit holds only its newest revision, so a flush sends at most one revision of it; an item recall could not read
 *   yet (a newer build's: `unsupported_item`) is held for a while and sent again later;
 * - `kv`: the ingest token, which only the service worker and the options page can read.
 */
import type { PageInfo } from './page.ts';

export const DB_NAME = 'recall';
const DB_VERSION = 1;

/** A visit: one document in one tab on one page, with its closed focus spans (the open one is in storage, focus.ts). */
export interface Visit {
  readonly id: string;
  readonly tabId: number;
  readonly documentId: string;
  readonly page: PageInfo;
  /** The tab's latest title, scrubbed and cut ('' for a site-only page). */
  title: string;
  /** Closed focus spans [start, end] in milliseconds, in time order, without overlaps. */
  spans: [number, number][];
  /** The last revision queued; 0 before the first. */
  revision: number;
  /** The spans or the title changed since the last revision queued. */
  changed: boolean;
  /** When the last revision was queued, or when the visit began. */
  queuedAt: number;
  /** The last capture attempt, successful or not; absent on visits made by older builds. */
  lastAttemptAt?: number;
  /** The last successfully queued text; failed attempts do not change this baseline. */
  snapshotTextHash?: string;
  /** A tiny pixel preview of the last successfully queued screenshot, for visible-change comparison. */
  screenshotPreview?: string;
}

/** An item of the outbox: one IngestItem in recall.ingest.v1's wire JSON. */
export interface OutboxItem {
  /** The visit's or the document's UUID. */
  readonly id: string;
  readonly kind: 'visit' | 'document';
  /** The item's JSON, and its size in UTF-8. */
  readonly json: string;
  readonly bytes: number;
  /** The visit's revision (1 for a document): a flush removes an item only when it still holds what was sent. */
  readonly version: number;
  /** Uploads of this item that failed. */
  readonly attempts: number;
  /** When it was first queued: the outbox's order, kept by a newer revision. */
  readonly queued: number;
  /** recall could not read it yet (`unsupported_item`, recall is older than this build): not sent before this time. */
  readonly heldUntil?: number;
}

/** Opens (and on the first run creates) the database. */
export function openDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('visits', { keyPath: 'id' }).createIndex('tabId', 'tabId');
      db.createObjectStore('outbox', { keyPath: 'id' }).createIndex('queued', 'queued');
      db.createObjectStore('kv', { keyPath: 'key' });
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('indexeddb_open_failed'));
    };
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('indexeddb_request_failed'));
    };
  });
}

/** Runs `work` in one transaction and waits for it to commit. Inside `work`, await only this transaction's requests. */
async function transact<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const tx = db.transaction(store, mode);
  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('indexeddb_transaction_failed'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('indexeddb_transaction_aborted'));
    };
  });
  // Awaited below; the handler only keeps the failure of a transaction whose work threw from going unhandled.
  committed.catch(() => undefined);
  const value = await work(tx.objectStore(store));
  await committed;
  return value;
}

// ---- visits ------------------------------------------------------------------------------------------------------------

export function getVisit(db: IDBDatabase, id: string): Promise<Visit | undefined> {
  return transact(db, 'visits', 'readonly', (store) => result(store.get(id) as IDBRequest<Visit | undefined>));
}

/** The open visit of a tab, if it has one. */
export function visitOfTab(db: IDBDatabase, tabId: number): Promise<Visit | undefined> {
  return transact(db, 'visits', 'readonly', (store) => result(store.index('tabId').get(tabId) as IDBRequest<Visit | undefined>));
}

/** A count of ongoing visits for local capture diagnostics, without reading their contents. */
export function countVisits(db: IDBDatabase): Promise<number> {
  return transact(db, 'visits', 'readonly', (store) => result(store.count()));
}

export function allVisits(db: IDBDatabase): Promise<Visit[]> {
  return transact(db, 'visits', 'readonly', (store) => result(store.getAll() as IDBRequest<Visit[]>));
}

export async function saveVisit(db: IDBDatabase, visit: Visit): Promise<void> {
  await transact(db, 'visits', 'readwrite', (store) => result(store.put(visit)));
}

export async function deleteVisit(db: IDBDatabase, id: string): Promise<void> {
  await transact(db, 'visits', 'readwrite', (store) => result(store.delete(id)));
}

// ---- the outbox --------------------------------------------------------------------------------------------------------

/** Puts an item into the outbox, replacing an older revision of it (whose place in the order it keeps). */
export async function queueItem(db: IDBDatabase, item: Pick<OutboxItem, 'id' | 'kind' | 'json' | 'version'>, at: number): Promise<void> {
  await transact(db, 'outbox', 'readwrite', async (store) => {
    const existing = (await result(store.get(item.id))) as OutboxItem | undefined;
    const stored: OutboxItem = {
      ...item,
      bytes: new TextEncoder().encode(item.json).byteLength,
      attempts: existing?.attempts ?? 0,
      queued: existing?.queued ?? at,
    };
    await result(store.put(stored));
  });
}

/** The oldest items not held at `at`, at most `limit` and `maxBytes` of JSON together (but always the oldest one). */
export function oldestItems(db: IDBDatabase, limit: number, maxBytes: number, at: number): Promise<OutboxItem[]> {
  return transact(db, 'outbox', 'readonly', (store) => {
    const items: OutboxItem[] = [];
    let bytes = 0;
    const cursor = store.index('queued').openCursor();
    return new Promise<OutboxItem[]>((resolve, reject) => {
      cursor.onsuccess = () => {
        const next = cursor.result;
        const item = next?.value as OutboxItem | undefined;
        if (next === null || item === undefined || items.length >= limit || (items.length > 0 && bytes + item.bytes > maxBytes)) {
          resolve(items);
          return;
        }
        if ((item.heldUntil ?? 0) > at) {
          next.continue();
          return;
        }
        items.push(item);
        bytes += item.bytes;
        next.continue();
      };
      cursor.onerror = () => {
        reject(cursor.error ?? new Error('indexeddb_cursor_failed'));
      };
    });
  });
}

export function countItems(db: IDBDatabase): Promise<number> {
  return transact(db, 'outbox', 'readonly', (store) => result(store.count()));
}

/** The items held at `at` (waiting for a recall that reads them). */
export async function countHeld(db: IDBDatabase, at: number): Promise<number> {
  const items = await transact(db, 'outbox', 'readonly', (store) => result(store.getAll() as IDBRequest<OutboxItem[]>));
  return items.filter((item) => (item.heldUntil ?? 0) > at).length;
}

/**
 * After an upload: removes each sent item that still holds what was sent (a revision queued during the upload stays),
 * but holds those recall could not read yet (`held`) until `heldUntil`; or, when the upload failed, counts the attempt
 * on it.
 */
export async function settleItems(
  db: IDBDatabase,
  sent: readonly OutboxItem[],
  outcome: 'remove' | 'attempt',
  held: { readonly ids: ReadonlySet<string>; readonly until: number } = { ids: new Set(), until: 0 },
): Promise<void> {
  await transact(db, 'outbox', 'readwrite', async (store) => {
    for (const item of sent) {
      const current = (await result(store.get(item.id))) as OutboxItem | undefined;
      if (current?.version !== item.version) continue;
      if (outcome === 'attempt') await result(store.put({ ...current, attempts: current.attempts + 1 }));
      else if (held.ids.has(item.id)) await result(store.put({ ...current, heldUntil: held.until }));
      else await result(store.delete(item.id));
    }
  });
}

// ---- the token ---------------------------------------------------------------------------------------------------------

export async function getToken(db: IDBDatabase): Promise<string> {
  const row = await transact(db, 'kv', 'readonly', (store) => result(store.get('token') as IDBRequest<{ value?: unknown } | undefined>));
  return typeof row?.value === 'string' ? row.value : '';
}

export async function setToken(db: IDBDatabase, token: string): Promise<void> {
  await transact(db, 'kv', 'readwrite', (store) => result(store.put({ key: 'token', value: token })));
}
