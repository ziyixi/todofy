/** The iPhone build uses page visibility and a top-frame document token instead of desktop-only window APIs. */
import type { Context } from './context.ts';
import { pageOf } from './page.ts';
import { currentDenylist } from './settings.ts';
import { lastError } from './store.ts';
import { diagnosticRunId, observe, observeTabLocation, observeTabs, resultType } from './diagnostic.ts';
import { BROWSER_REPLY_TIMEOUT_MS } from './limits.ts';

function timedOut(error: unknown): boolean {
  return error instanceof Error && error.message === 'browser_reply_timeout';
}

/** Only mobile callbacks use this bound; a late native reply cannot revive a completed caller. */
function nativeReply<T>(call: (resolve: (value: T) => void, reject: (reason: Error) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('browser_reply_timeout')); }, BROWSER_REPLY_TIMEOUT_MS);
    const fail = (reason: Error) => { clearTimeout(timer); reject(reason); };
    try {
      call((value) => { clearTimeout(timer); resolve(value); }, fail);
    } catch (error) {
      fail(error instanceof Error ? error : new Error('browser_api_failed'));
    }
  });
}

export interface PageProbe {
  readonly documentId: string;
  readonly visible: boolean;
  readonly url: string;
}

/** Chrome's typings mark all namespaces required; Orion's documented subset does not provide all of them. */
export function browserFeatures(api: typeof chrome) {
  const subset = api as unknown as {
    readonly scripting?: typeof chrome.scripting;
    readonly windows?: typeof chrome.windows;
    readonly idle?: typeof chrome.idle;
    readonly webNavigation?: typeof chrome.webNavigation;
    readonly action?: typeof chrome.action;
    readonly browserAction?: typeof chrome.browserAction;
    readonly tabs: {
      readonly executeScript?: (tabId: number, details: { file: string; frameId?: number; runAt: 'document_start' }, callback?: (results?: unknown[]) => void) => Promise<unknown[] | undefined> | undefined;
      readonly captureVisibleTab?: typeof chrome.tabs.captureVisibleTab;
    };
  };
  return subset;
}

/** Read lastError while the native callback is active; it is cleared when that callback returns. */
function receive<T>(ctx: Context, resolve: (value: T) => void, reject: (error: Error) => void, value: T): void {
  const error = ctx.chrome.runtime.lastError;
  if (error !== undefined) reject(new Error(error.message ?? 'browser_api_failed'));
  else resolve(value);
}

/** MV2 callbacks are the native contract; desktop Chrome keeps its Promise calls. */
export async function getTab(ctx: Context, tabId: number): Promise<chrome.tabs.Tab> {
  if (!ctx.mobile) return ctx.chrome.tabs.get(tabId);
  const runId = await observe(ctx, { stage: 'tab_lookup', state: 'pending' }, tabId);
  return nativeReply<chrome.tabs.Tab>((resolve, reject) => {
    ctx.chrome.tabs.get(tabId, (tab) => {
      const failed = ctx.chrome.runtime.lastError !== undefined;
      void observeTabLocation(ctx, tab, runId).then(() => observe(ctx, { stage: 'tab_lookup', state: failed ? 'failed' : 'returned', result: failed ? 'api_error' : resultType(tab) }, tabId, runId));
      receive(ctx, resolve, reject, tab);
    });
  }).catch(async (error: unknown) => {
    if (!timedOut(error)) await observe(ctx, { stage: 'tab_lookup', state: 'failed', result: 'api_error' }, tabId, runId);
    await lastError.set(ctx.chrome, timedOut(error) ? 'page_tab_timeout' : 'page_tab_failed', ctx.now());
    throw error;
  });
}

export async function queryTabs(ctx: Context, query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  if (!ctx.mobile) return ctx.chrome.tabs.query(query);
  const runId = await observe(ctx, { stage: 'active_tabs', state: 'pending' });
  return nativeReply<chrome.tabs.Tab[]>((resolve, reject) => {
    ctx.chrome.tabs.query(query, (tabs) => {
      const failed = ctx.chrome.runtime.lastError !== undefined;
      void (failed ? observe(ctx, { stage: 'active_tabs', state: 'failed', result: 'api_error' }, undefined, runId) : Array.isArray(tabs) ? observeTabs(ctx, tabs, runId) : observe(ctx, { stage: 'active_tabs', state: 'returned', result: resultType(tabs) }, undefined, runId));
      receive(ctx, resolve, reject, tabs);
    });
  }).catch(async (error: unknown) => {
    if (!timedOut(error)) await observe(ctx, { stage: 'active_tabs', state: 'failed', result: 'api_error' }, undefined, runId);
    await lastError.set(ctx.chrome, timedOut(error) ? 'page_query_timeout' : 'page_query_failed', ctx.now());
    throw error;
  });
}

export async function captureViewport(ctx: Context, windowId: number, tabId?: number): Promise<string> {
  if (!ctx.mobile) return ctx.chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const runId = await observe(ctx, { stage: 'screenshot', state: 'pending' }, tabId);
  return nativeReply<string>((resolve, reject) => {
    ctx.chrome.tabs.captureVisibleTab({ format: 'png' }, (data) => {
      const failed = ctx.chrome.runtime.lastError !== undefined;
      void observe(ctx, { stage: 'screenshot', state: failed ? 'failed' : 'returned', result: failed ? 'api_error' : resultType(data) }, tabId, runId);
      receive(ctx, resolve, reject, data);
    });
  }).catch(async (error: unknown) => {
    if (!timedOut(error)) await observe(ctx, { stage: 'screenshot', state: 'failed', result: 'api_error' }, tabId, runId);
    throw error;
  });
}

/** A separate, content-free reply exposes native sender and page visibility even when the normal guard rejects it. */
async function probeContext(ctx: Context, tabId: number): Promise<void> {
  const runId = await diagnosticRunId(ctx, tabId);
  if (runId === null) return;
  await observe(ctx, { stage: 'probe_context', state: 'pending' }, tabId);
  ctx.chrome.tabs.sendMessage(tabId, { type: 'recall-diagnostic-context', runId }, (value: unknown) => {
    const failed = ctx.chrome.runtime.lastError !== undefined;
    const fields = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
    const visibility = fields['visibility'] === 'visible' || fields['visibility'] === 'hidden' ? fields['visibility'] : 'unknown';
    const stored = fields['stored_visibility'] === 'visible' || fields['stored_visibility'] === 'hidden' ? fields['stored_visibility'] : 'unknown';
    const identity = fields['sender_identity'];
    const sender = identity === 'same' || identity === 'missing' || identity === 'null' || identity === 'foreign' ? identity : 'unknown';
    void observe(ctx, { stage: 'probe_context', state: failed ? 'failed' : 'returned', result: failed ? 'api_error' : resultType(value), visibility, stored_visibility: stored, sender_identity: sender }, tabId, runId);
  });
}

/** MV2 Orion exposes tabs.executeScript; modern browsers use scripting. Both inject only the main frame. */
export async function executeFile(ctx: Context, tabId: number, file: 'probe.js' | 'capture.js', documentId?: string): Promise<unknown> {
  const features = browserFeatures(ctx.chrome);
  if (ctx.mobile && features.tabs.executeScript !== undefined) {
    const execute = features.tabs.executeScript;
    const runId = await observe(ctx, { stage: 'probe_injection', state: 'pending' }, tabId);
    // Orion's file-injection completion did not yield a usable probe. Use the standard content-message reply.
    await nativeReply<undefined>((resolve, reject) => {
      let completed = false;
      const complete = (value: unknown, error?: Error) => {
        if (completed) return;
        completed = true;
        void observe(ctx, { stage: 'probe_injection', state: error === undefined ? 'returned' : 'failed', result: error === undefined ? resultType(value) : 'api_error' }, tabId, runId);
        if (error === undefined) resolve(undefined);
        else reject(error);
      };
      const execution = execute.call(ctx.chrome.tabs, tabId, { file: 'probe.js', runAt: 'document_start' }, (value) => {
        const error = ctx.chrome.runtime.lastError;
        complete(value, error === undefined ? undefined : new Error(error.message ?? 'browser_api_failed'));
      });
      if (typeof execution?.then === 'function') {
        void execution.then((value) => { complete(value); }, (error: unknown) => {
          complete(undefined, error instanceof Error ? error : new Error('browser_api_failed'));
        });
      }
    }).catch(async (error: unknown) => {
      // An unanswered completion does not establish whether the listener was installed. Ask it once below.
      if (timedOut(error)) return;
      await observe(ctx, { stage: 'probe_injection', state: 'failed', result: 'api_error' }, tabId, runId);
      throw error;
    });
    void probeContext(ctx, tabId).catch(() => undefined);
    const stage = file === 'probe.js' ? 'probe_reply' : 'capture_reply';
    await observe(ctx, { stage, state: 'pending' }, tabId, runId);
    return nativeReply<unknown>((resolve, reject) => {
      ctx.chrome.tabs.sendMessage(tabId, { type: file === 'probe.js' ? 'recall-probe' : 'recall-capture' }, (value: unknown) => {
        const failed = ctx.chrome.runtime.lastError !== undefined;
        void observe(ctx, { stage, state: failed ? 'failed' : 'returned', result: failed ? 'api_error' : resultType(value) }, tabId, runId);
        receive(ctx, resolve, reject, value);
      });
    }).catch(async (error: unknown) => {
      if (!timedOut(error)) await observe(ctx, { stage, state: 'failed', result: 'api_error' }, tabId, runId);
      throw error;
    });
  }
  if (features.scripting !== undefined) {
    const [first] = await features.scripting.executeScript({
      target: { tabId, ...(documentId === undefined ? { frameIds: [0] } : { documentIds: [documentId] }) }, files: [file],
    });
    return first?.result;
  }
  const results = await features.tabs.executeScript?.(tabId, { file, frameId: 0, runAt: 'document_start' });
  return results?.[0];
}

/** Do not inject even this small probe on excluded pages. No text, title or input values are read. */
export async function probePage(ctx: Context, tabId: number): Promise<PageProbe | null> {
  let failureCode = 'page_tab_failed';
  try {
    const tab = await getTab(ctx, tabId);
    failureCode = 'page_probe_failed';
    if (tab.incognito || await pageOf(tab.url ?? '', await currentDenylist(ctx)) === null) return null;
    const value = await executeFile(ctx, tabId, 'probe.js');
    if (typeof value === 'object' && value !== null) {
      const probe = value as Record<string, unknown>;
      if (typeof probe['documentId'] === 'string' && typeof probe['visible'] === 'boolean' && typeof probe['url'] === 'string') return probe as unknown as PageProbe;
    }
    await lastError.set(ctx.chrome, 'page_probe_invalid_result', ctx.now());
    return null;
  } catch (error) {
    await lastError.set(ctx.chrome, timedOut(error) ? failureCode.replace('_failed', '_timeout') : failureCode, ctx.now());
    return null;
  }
}
