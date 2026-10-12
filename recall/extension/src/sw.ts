/**
 * The service worker (sw.js, ../../docs/design.md §3). Every listener is registered at the top level, as Manifest V3
 * requires: a worker woken by an event registers them again before the event is dispatched. Every handler that reads
 * or writes the state runs in one queue, one at a time, with the time its event arrived; the network (uploads, the
 * update check) and the page reads (captures) run outside it, so a slow answer never delays a focus event.
 *
 * Logs hold the handler's name and the error's name only: never a URL, host, title or text.
 */
import { captureDelay, captureDue, readTab, storeCapture } from './capture.ts';
import type { Context } from './context.ts';
import { browserFeatures } from './browser.ts';
import { openDb } from './db.ts';
import { beat, browserStarted, idleChanged, pageVisibility, reconcile, releaseFocus, tabChanged, tabRemoved } from './focus.ts';
import { IDLE_SECONDS, TICK_MINUTES } from './limits.ts';
import { isRequest, type Request, type SaveAnswer, type SaveProgress, type Status, type UpdateAnswer } from './messages.ts';
import { saveProgress, saveSettings, status } from './settings.ts';
import { getDevice, reloadedFor } from './store.ts';
import { installedUpdate } from './update.ts';
import { flush, showBadge, type FlushReason } from './upload.ts';

declare const RECALL_ORION: boolean;

// This artifact targets iPhone/iPad; Orion's background navigator can report a desktop identity.
const MOBILE = typeof RECALL_ORION !== 'undefined' && RECALL_ORION;
const features = browserFeatures(chrome);
const TICK = 'tick';

/** The context every handler waits for: the database open and the device made (on the first run). */
const ready: Promise<Context> = (async () => {
  const ctx: Context = {
    mobile: MOBILE,
    chrome,
    db: await openDb(),
    now: () => Date.now(),
    fetch: (input, init) => fetch(input, init),
    later: (fn, ms) => {
      setTimeout(fn, ms);
    },
    uuid: () => crypto.randomUUID(),
    storageUsage: async () => {
      try {
        return (await navigator.storage.estimate()).usage ?? 0;
      } catch {
        return 0;
      }
    },
    build: chrome.runtime.getManifest().version,
  };
  await getDevice(ctx.chrome, ctx.uuid, ctx.mobile ? 'iPhone · Orion' : undefined);
  return ctx;
})();

function report(name: string, error: unknown): void {
  console.warn(`recall: ${name} failed`, error instanceof Error ? error.name : 'unknown');
}

let queue: Promise<unknown> = Promise.resolve();
// Owner settings serialize with each other, independently of browser focus and page inspection.
let settingsWrites: Promise<unknown> = Promise.resolve();

/** Runs `work` after every earlier one. */
function serial<T>(work: (ctx: Context) => Promise<T>): Promise<T> {
  const run = queue.then(async () => work(await ready));
  queue = run.catch(() => undefined);
  return run;
}

/** Reads the focused page once its visit had ten seconds of focus (claimed and stored in the queue, read outside it). */
async function capture(): Promise<void> {
  const job = await serial((ctx) => captureDue(ctx, ctx.now()));
  if (job === null) return;
  const outcome = await readTab(await ready, job);
  await serial((ctx) => storeCapture(ctx, job, outcome, ctx.now()));
  if ((await ready).mobile) await upload('tick');
}

/** Sets the capture's timer for the focused visit, if a capture is to come. */
async function scheduleCapture(): Promise<void> {
  const ctx = await ready;
  const delay = await serial((current) => captureDelay(current, current.now()));
  if (delay === null) return;
  ctx.later(() => {
    capture().catch((error: unknown) => {
      report('capture', error);
    });
  }, delay);
}

/** A focus transition: the state's change in the queue, then the capture's timer. */
function transition(name: string, work: (ctx: Context) => Promise<void>): void {
  serial(work)
    .then(scheduleCapture)
    .catch((error: unknown) => {
      report(name, error);
    });
}

let flushing: Promise<void> | null = null;

/** One upload at a time (a later one waits for the running one); the badge follows each outcome. */
async function upload(reason: FlushReason): Promise<void> {
  while (flushing !== null) await flushing;
  flushing = (async () => {
    try {
      const ctx = await ready;
      await flush(ctx, ctx.now(), reason);
      await showBadge(ctx, ctx.now());
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/**
 * Reloads into a newer build installed in the extension's folder, after closing the span. The tick reloads once per
 * version: should Chrome come back with the old code, it would otherwise reload every minute (检查更新 still can).
 */
async function updateIfInstalled(trigger: 'tick' | 'owner'): Promise<boolean> {
  const ctx = await ready;
  const version = await installedUpdate(ctx);
  if (version === null || (trigger === 'tick' && (await reloadedFor.get(ctx.chrome)) === version)) return false;
  await reloadedFor.set(ctx.chrome, version);
  await serial((current) => releaseFocus(current, current.now()));
  ctx.chrome.runtime.reload();
  return true;
}

async function ensureAlarm(): Promise<void> {
  if ((await chrome.alarms.get(TICK)) === undefined) await chrome.alarms.create(TICK, { periodInMinutes: TICK_MINUTES });
}

async function onTick(at: number): Promise<void> {
  await serial((ctx) => beat(ctx, at));
  await capture();
  await scheduleCapture();
  await upload('tick');
  await updateIfInstalled('tick');
}

async function onStartup(at: number): Promise<void> {
  await serial((ctx) => browserStarted(ctx, at));
  await ensureAlarm();
  await scheduleCapture();
  await upload('startup');
}

async function answer(request: Request): Promise<Status | SaveAnswer | SaveProgress | UpdateAnswer> {
  const ctx = await ready;
  switch (request.type) {
    case 'status':
      return status(ctx);
    case 'save-progress':
      return saveProgress();
    case 'save': {
      const write = settingsWrites.then(() => saveSettings(ctx, request));
      settingsWrites = write.catch(() => undefined);
      const saved = await write;
      // A saved setting is independent of the network and browser badge APIs.
      if (saved.ok) void upload('manual').catch((error: unknown) => { report('save_upload', error); });
      return saved;
    }
    case 'flush':
      await upload('manual');
      return status(ctx);
    case 'check-update':
      return { reloading: await updateIfInstalled('owner') };
  }
}

/** A navigation of a tab's main document: not a prerender, a page from the back/forward cache or a frame's. */
function navigated(details: { readonly tabId: number; readonly frameId?: number; readonly frameType?: string; readonly documentLifecycle?: string }): void {
  if (MOBILE ? details.frameId !== 0 : details.frameType !== 'outermost_frame' || details.documentLifecycle !== 'active') return;
  const at = Date.now();
  transition('navigation', (ctx) => tabChanged(ctx, details.tabId, at));
}

if (!MOBILE) features.idle?.setDetectionInterval(IDLE_SECONDS);

chrome.tabs.onActivated.addListener(() => {
  const at = Date.now();
  transition('tab_activated', (ctx) => reconcile(ctx, at));
});

features.windows?.onFocusChanged.addListener((windowId) => {
  const at = Date.now();
  transition('window_focus', (ctx) => reconcile(ctx, at, { windowId }));
});

if (!MOBILE) {
  features.idle?.onStateChanged.addListener((idle) => {
    const at = Date.now();
    transition('idle', (ctx) => idleChanged(ctx, idle, at));
  });
}

features.webNavigation?.onCommitted.addListener(navigated);
features.webNavigation?.onHistoryStateUpdated.addListener(navigated);
features.webNavigation?.onReferenceFragmentUpdated.addListener(navigated);

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.title === undefined && change.url === undefined) return;
  const at = Date.now();
  transition('tab_updated', (ctx) => tabChanged(ctx, tabId, at));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const at = Date.now();
  transition('tab_removed', (ctx) => tabRemoved(ctx, tabId, at));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TICK) return;
  onTick(Date.now()).catch((error: unknown) => {
    report('tick', error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  onStartup(Date.now()).catch((error: unknown) => {
    report('startup', error);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  const at = Date.now();
  ensureAlarm().catch((error: unknown) => {
    report('alarm', error);
  });
  transition('installed', (ctx) => reconcile(ctx, at));
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'page-visibility') {
    const value = message as Record<string, unknown>;
    if (sender.frameId !== 0 || sender.tab?.id === undefined || sender.tab.incognito || typeof value['documentId'] !== 'string' || typeof value['visible'] !== 'boolean' || typeof value['at'] !== 'number' || !Number.isFinite(value['at'])) return false;
    const tabId = sender.tab.id;
    const documentId = value['documentId'];
    const visible = value['visible'];
    const at = Math.min(Date.now(), value['at']);
    transition('page_visibility', (ctx) => pageVisibility(ctx, tabId, documentId, visible, at));
    ready.then((ctx) => { if (ctx.mobile && visible) return upload('startup'); }).catch((error: unknown) => { report('resume_upload', error); });
    return false;
  }
  if (!isRequest(message)) return false;
  answer(message).then(sendResponse, (error: unknown) => {
    report(message.type, error);
    sendResponse(null);
  });
  return true;
});

(features.action ?? features.browserAction)?.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage().catch((error: unknown) => {
    report('options', error);
  });
});

ensureAlarm().catch((error: unknown) => {
  report('alarm', error);
});
