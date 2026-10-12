/**
 * What every part of the service worker works with: Chrome's APIs, the extension's database, the clock and the
 * network. sw.ts builds the real one; the tests build one over a fake Chrome, fake-indexeddb, a fake clock and a fake
 * fetch (test/fake-chrome.ts).
 */

export interface Context {
  /** True only for the Orion build running on iOS, never inferred from a missing API. */
  readonly mobile?: boolean;
  /** Chrome's extension APIs. */
  readonly chrome: typeof chrome;
  /** The extension's IndexedDB (db.ts): the open visits, the outbox and the token. */
  readonly db: IDBDatabase;
  /** The time in milliseconds since the epoch. */
  readonly now: () => number;
  readonly fetch: typeof fetch;
  /** Runs `fn` after `ms` milliseconds (the capture's ten seconds). */
  readonly later: (fn: () => void, ms: number) => void;
  /** A new lower-case UUID. */
  readonly uuid: () => string;
  /** The bytes the extension's origin stores (navigator.storage.estimate), which bounds the captures. */
  readonly storageUsage: () => Promise<number>;
  /** This build's version (the manifest's), which a capture result must carry. */
  readonly build: string;
}
