/**
 * A hand-written fake of the chrome.* APIs the extension uses, a fake clock and a fake fetch, over fake-indexeddb
 * (../../docs/design.md §10). The browser is a small model the tests drive: windows and their tabs, each tab showing
 * one document (a UUID, an URL, a title, a lifecycle), the focused window, the idle state, both storage areas (values
 * cloned as Chrome serializes them), the alarms, the badge, executeScript's answer and the extension's own files.
 *
 * Driving the model changes Chrome's state only; a test then calls the handler the event would run (focus.ts) or, for
 * the wiring (sw.test.ts), emits the event on the fake API.
 */
import { IDBFactory } from 'fake-indexeddb';
import type { Context } from '../src/context.ts';
import { openDb } from '../src/db.ts';

export const EXTENSION_ID = 'kpehdcbafdhgghclgaeigokjoceemfhj';
export const WINDOW_ID_NONE = -1;
/** 2026-10-10 09:00:00 UTC. */
export const T0 = Date.UTC(2026, 9, 10, 9, 0, 0);
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

/** An event: listeners registered, then emitted by the test. */
export class FakeEvent<A extends unknown[]> {
  readonly listeners: ((...args: A) => unknown)[] = [];

  addListener(listener: (...args: A) => unknown): void {
    this.listeners.push(listener);
  }

  removeListener(listener: (...args: A) => unknown): void {
    this.listeners.splice(this.listeners.indexOf(listener), 1);
  }

  hasListener(listener: (...args: A) => unknown): boolean {
    return this.listeners.includes(listener);
  }

  /** Calls every listener; answers what the first one returned (onMessage's `true`). */
  emit(...args: A): unknown {
    return this.listeners.map((listener) => listener(...args))[0];
  }
}

export interface FakeTab {
  readonly id: number;
  windowId: number;
  active: boolean;
  url: string;
  title: string;
  documentId: string;
  lifecycle: 'active' | 'prerender' | 'cached';
  incognito: boolean;
}

let documents = 0;
/** A new document UUID. */
export const documentId = (): string => `doc-${String((documents += 1))}`;

class Area {
  readonly values = new Map<string, unknown>();

  get(key: string): Promise<Record<string, unknown>> {
    return Promise.resolve(this.values.has(key) ? { [key]: structuredClone(this.values.get(key)) } : {});
  }

  set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  clear(): void {
    this.values.clear();
  }
}

export type ScriptAnswer = (target: { tabId: number; documentIds?: string[] }) => unknown;

export class FakeBrowser {
  readonly tabs = new Map<number, FakeTab>();
  focusedWindow = 1;
  idle: 'active' | 'idle' | 'locked' = 'active';
  readonly session = new Area();
  readonly local = new Area();
  readonly alarms = new Map<string, { name: string; periodInMinutes?: number }>();
  badge = '';
  title = '';
  reloads = 0;
  manifest: { version: string; version_name?: string } = { version: '2026.1010.900', version_name: 'abc1234' };
  /**
   * What executeScript answers (the capture script's result), or throws. An object answer reads the document's URL
   * (location.href) as its tab's current URL unless it names one: a script that read another route says so.
   */
  script: ScriptAnswer = () => undefined;
  /** The extension's own files, served by getURL + fetch. */
  readonly files = new Map<string, string>();
  readonly scriptCalls: { tabId: number; documentIds?: string[]; files?: string[] }[] = [];
  private nextTab = 1;

  readonly events = {
    activated: new FakeEvent<[{ tabId: number; windowId: number }]>(),
    updated: new FakeEvent<[number, { title?: string; url?: string }]>(),
    removed: new FakeEvent<[number]>(),
    focusChanged: new FakeEvent<[number]>(),
    idleChanged: new FakeEvent<['active' | 'idle' | 'locked']>(),
    committed: new FakeEvent<[{ tabId: number; frameType: string; documentLifecycle: string; documentId: string; url: string }]>(),
    historyUpdated: new FakeEvent<[{ tabId: number; frameType: string; documentLifecycle: string; documentId: string; url: string }]>(),
    fragmentUpdated: new FakeEvent<[{ tabId: number; frameType: string; documentLifecycle: string; documentId: string; url: string }]>(),
    alarm: new FakeEvent<[{ name: string }]>(),
    startup: new FakeEvent<[]>(),
    installed: new FakeEvent<[{ reason: string }]>(),
    message: new FakeEvent<[unknown, { id?: string }, (answer: unknown) => void]>(),
    clicked: new FakeEvent<[]>(),
  };

  /** Opens a tab on `url` in a window; it becomes that window's active tab when `active`. */
  open(url: string, options: { title?: string; windowId?: number; active?: boolean; incognito?: boolean } = {}): FakeTab {
    const windowId = options.windowId ?? 1;
    const tab: FakeTab = {
      id: this.nextTab++,
      windowId,
      active: false,
      url,
      title: options.title ?? '',
      documentId: documentId(),
      lifecycle: 'active',
      incognito: options.incognito ?? false,
    };
    this.tabs.set(tab.id, tab);
    if (options.active ?? true) this.activate(tab.id);
    return tab;
  }

  activate(tabId: number): void {
    const tab = this.tab(tabId);
    for (const other of this.tabs.values()) if (other.windowId === tab.windowId) other.active = other.id === tabId;
  }

  /** A navigation to a new document. */
  navigate(tabId: number, url: string, title = ''): FakeTab {
    const tab = this.tab(tabId);
    Object.assign(tab, { url, title, documentId: documentId() });
    return tab;
  }

  /** pushState or a fragment change: the same document, another URL. */
  pushState(tabId: number, url: string): void {
    this.tab(tabId).url = url;
  }

  close(tabId: number): void {
    this.tabs.delete(tabId);
  }

  tab(tabId: number): FakeTab {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) throw new Error(`No tab with id: ${String(tabId)}.`);
    return tab;
  }

  /** A browser restart: storage.session is gone, the tabs are new. */
  restart(): void {
    this.session.clear();
    this.tabs.clear();
  }

  readonly api = {
    tabs: {
      get: (tabId: number) => Promise.resolve().then(() => ({ ...this.tab(tabId) })),
      query: ({ active, windowId }: { active?: boolean; windowId?: number }) =>
        Promise.resolve([...this.tabs.values()].filter((tab) => (active === undefined || tab.active === active) && (windowId === undefined || tab.windowId === windowId)).map((tab) => ({ ...tab }))),
      onActivated: this.events.activated,
      onUpdated: this.events.updated,
      onRemoved: this.events.removed,
    },
    windows: {
      WINDOW_ID_NONE,
      getLastFocused: () => Promise.resolve({ id: this.focusedWindow === WINDOW_ID_NONE ? 1 : this.focusedWindow, focused: this.focusedWindow !== WINDOW_ID_NONE }),
      onFocusChanged: this.events.focusChanged,
    },
    idle: {
      queryState: () => Promise.resolve(this.idle),
      setDetectionInterval: () => undefined,
      onStateChanged: this.events.idleChanged,
    },
    webNavigation: {
      getFrame: ({ tabId }: { tabId: number }) => {
        const tab = this.tabs.get(tabId);
        return Promise.resolve(tab === undefined ? null : { documentId: tab.documentId, url: tab.url, documentLifecycle: tab.lifecycle, frameType: 'outermost_frame', errorOccurred: false, parentFrameId: -1 });
      },
      onCommitted: this.events.committed,
      onHistoryStateUpdated: this.events.historyUpdated,
      onReferenceFragmentUpdated: this.events.fragmentUpdated,
    },
    storage: { session: this.session, local: this.local },
    alarms: {
      get: (name: string) => Promise.resolve(this.alarms.get(name)),
      create: (name: string, info: { periodInMinutes?: number }) => {
        this.alarms.set(name, { name, ...info });
        return Promise.resolve();
      },
      onAlarm: this.events.alarm,
    },
    scripting: {
      executeScript: async (injection: { target: { tabId: number; documentIds?: string[] }; files?: string[] }) => {
        this.scriptCalls.push({ ...injection.target, ...(injection.files === undefined ? {} : { files: injection.files }) });
        await Promise.resolve();
        const answer = this.script(injection.target);
        const result = typeof answer === 'object' && answer !== null ? { url: this.tabs.get(injection.target.tabId)?.url ?? '', ...answer } : answer;
        return [{ frameId: 0, documentId: injection.target.documentIds?.[0] ?? '', result }];
      },
    },
    runtime: {
      id: EXTENSION_ID,
      getManifest: () => this.manifest,
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
      reload: () => {
        this.reloads += 1;
      },
      openOptionsPage: () => Promise.resolve(),
      onStartup: this.events.startup,
      onInstalled: this.events.installed,
      onMessage: this.events.message,
    },
    action: {
      setBadgeText: ({ text }: { text: string }) => {
        this.badge = text;
        return Promise.resolve();
      },
      setBadgeBackgroundColor: () => Promise.resolve(),
      setTitle: ({ title }: { title: string }) => {
        this.title = title;
        return Promise.resolve();
      },
      onClicked: this.events.clicked,
    },
  };

  get chrome(): typeof chrome {
    return this.api as unknown as typeof chrome;
  }
}

export interface FakeRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch whose answers the test sets; the extension's own files are served from the browser's `files`. */
export class FakeFetch {
  readonly requests: FakeRequest[] = [];
  answer: (request: FakeRequest) => Response | Promise<Response> = () => new Response('{}', { status: 500 });
  private readonly browser: FakeBrowser;

  constructor(browser: FakeBrowser) {
    this.browser = browser;
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const own = `chrome-extension://${EXTENSION_ID}/`;
    if (url.startsWith(own)) {
      const file = this.browser.files.get(url.slice(own.length));
      if (file === undefined) throw new TypeError('Failed to fetch');
      return new Response(file);
    }
    const request = { url, init };
    this.requests.push(request);
    return this.answer(request);
  };
}

/** The clock and the timers `later` set (fired by the test). */
export class FakeClock {
  time = T0;
  readonly timers: { readonly at: number; readonly fn: () => void }[] = [];

  advance(ms: number): number {
    this.time += ms;
    return this.time;
  }
}

export interface Harness {
  readonly browser: FakeBrowser;
  readonly net: FakeFetch;
  readonly clock: FakeClock;
  readonly ctx: Context;
}

let uuids = 0;
/** A deterministic lower-case UUID. */
export const testUuid = (): string => `00000000-0000-4000-8000-${(uuids += 1).toString(16).padStart(12, '0')}`;

export async function harness(options: { storageUsage?: number } = {}): Promise<Harness> {
  const browser = new FakeBrowser();
  const net = new FakeFetch(browser);
  const clock = new FakeClock();
  const db = await openDb(new IDBFactory());
  const ctx: Context = {
    chrome: browser.chrome,
    db,
    now: () => clock.time,
    fetch: net.fetch,
    later: (fn, ms) => {
      clock.timers.push({ at: clock.time + ms, fn });
    },
    uuid: testUuid,
    storageUsage: () => Promise.resolve(options.storageUsage ?? 0),
    build: browser.manifest.version,
  };
  return { browser, net, clock, ctx };
}

/** A synthetic ingest token in mint-tokens.mjs's shape. */
export const INGEST_TOKEN = `recall_ingest_${'A'.repeat(43)}`;
