/** The iPhone build uses page visibility and a top-frame document token instead of desktop-only window APIs. */
import type { Context } from './context.ts';
import { pageOf } from './page.ts';
import { currentDenylist } from './settings.ts';

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
      readonly executeScript?: (tabId: number, details: { file: string; frameId: number; runAt: 'document_start' }, callback?: (results?: unknown[]) => void) => Promise<unknown[] | undefined> | undefined;
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
export function getTab(ctx: Context, tabId: number): Promise<chrome.tabs.Tab> {
  if (!ctx.mobile) return ctx.chrome.tabs.get(tabId);
  return new Promise((resolve, reject) => {
    ctx.chrome.tabs.get(tabId, (tab) => { receive(ctx, resolve, reject, tab); });
  });
}

export function queryTabs(ctx: Context, query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  if (!ctx.mobile) return ctx.chrome.tabs.query(query);
  return new Promise((resolve, reject) => {
    ctx.chrome.tabs.query(query, (tabs) => { receive(ctx, resolve, reject, tabs); });
  });
}

export function captureViewport(ctx: Context, windowId: number): Promise<string> {
  if (!ctx.mobile) return ctx.chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  return new Promise((resolve, reject) => {
    ctx.chrome.tabs.captureVisibleTab({ format: 'png' }, (data) => { receive(ctx, resolve, reject, data); });
  });
}

/** MV2 Orion exposes tabs.executeScript; modern browsers use scripting. Both inject only the main frame. */
export async function executeFile(ctx: Context, tabId: number, file: string, documentId?: string): Promise<unknown> {
  const features = browserFeatures(ctx.chrome);
  if (ctx.mobile && features.tabs.executeScript !== undefined) {
    const execute = features.tabs.executeScript;
    const results = await new Promise<unknown[] | undefined>((resolve, reject) => {
      void execute.call(ctx.chrome.tabs, tabId, { file, frameId: 0, runAt: 'document_start' }, (values) => { receive(ctx, resolve, reject, values); });
    });
    return results?.[0];
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
  try {
    const tab = await getTab(ctx, tabId);
    if (tab.incognito || await pageOf(tab.url ?? '', await currentDenylist(ctx)) === null) return null;
    const value = await executeFile(ctx, tabId, 'probe.js');
    if (typeof value !== 'object' || value === null) return null;
    const probe = value as Record<string, unknown>;
    return typeof probe['documentId'] === 'string' && typeof probe['visible'] === 'boolean' && typeof probe['url'] === 'string'
      ? probe as unknown as PageProbe : null;
  } catch {
    return null;
  }
}
