/**
 * Focus (../../docs/design.md §3.2): a small state machine kept in storage, driven only by Chrome's events, since the
 * service worker sleeps after 30 s and loses its globals.
 *
 * At most one span is open: on the active tab of the focused window while the owner is active (chrome.idle), on a
 * page recall records. Every transition runs `reconcile`, which finds that target from Chrome's own state (the focused
 * window, its active tab, the tab's document from webNavigation) rather than from the event, so a replayed or
 * duplicated event (a prerender, a back/forward cache restore, a second commit of the same document) changes nothing:
 * events are deduplicated on the document they leave the tab showing. When the target is the open span's tab,
 * document and page, the span stays open; otherwise it is closed (its visit queued: the tab lost the focus) and a new
 * one opens on the target's visit.
 *
 * - Going idle backdates the span's end by the idle threshold (no input for that long means the owner had left); a
 *   locked screen ends it at once.
 * - After a silence of more than two minutes since the last beat (Chrome closed, the Mac asleep, the worker killed),
 *   an open span is closed at the last beat, never at the time of the event that ended the silence.
 * - The span lives in storage.session and is mirrored to storage.local with the last beat: a span found only in the
 *   mirror (the browser restarted, the extension reloaded) is closed at that beat.
 */
import type { Context } from './context.ts';
import { probePage } from './browser.ts';
import { allVisits, getVisit, saveVisit, visitOfTab, deleteVisit, type Visit } from './db.ts';
import { GAP_MS, IDLE_SECONDS, VISIT_MAX_MS, VISIT_REQUEUE_MS } from './limits.ts';
import { pageOf, titleOf, type PageInfo } from './page.ts';
import { currentDenylist } from './settings.ts';
import { focusState, mirror, type FocusState, type IdleState, type Span } from './store.ts';
import { endVisit, firstFocus, newVisit, queueVisit, visitOver } from './visits.ts';

/** What a tab shows: its document as webNavigation knows it, its URL and title as the tabs API does. */
interface TabPage {
  readonly tabId: number;
  readonly documentId: string;
  readonly url: string;
  readonly title: string;
}

interface Target {
  readonly tab: TabPage;
  readonly page: PageInfo;
}

/** What a tab shows now, or null: no such tab (any more), or its main document is not an active one. */
async function tabPage(ctx: Context, tabId: number): Promise<TabPage | null> {
  try {
    if (ctx.mobile) {
      const [tab, probe] = await Promise.all([ctx.chrome.tabs.get(tabId), probePage(ctx, tabId)]);
      return probe?.visible && !tab.incognito ? { tabId, documentId: probe.documentId, url: probe.url, title: tab.title ?? '' } : null;
    }
    const [tab, frame] = await Promise.all([ctx.chrome.tabs.get(tabId), ctx.chrome.webNavigation.getFrame({ tabId, frameId: 0 })]);
    if (frame === null || frame.documentLifecycle !== 'active' || tab.incognito) return null;
    return { tabId, documentId: frame.documentId, url: tab.url ?? frame.url, title: tab.title ?? '' };
  } catch {
    return null;
  }
}

/** The window in front, or WINDOW_ID_NONE when another app is. */
async function focusedWindow(ctx: Context): Promise<number> {
  try {
    if (ctx.mobile) return (await ctx.chrome.tabs.query({ active: true }))[0]?.windowId ?? -1;
    const window = await ctx.chrome.windows.getLastFocused();
    return window.focused && window.id !== undefined ? window.id : ctx.chrome.windows.WINDOW_ID_NONE;
  } catch {
    return -1;
  }
}

/** The span's target: the focused window's active tab while the owner is active, on a page recall records. */
async function focusTarget(ctx: Context, state: FocusState): Promise<Target | null> {
  if (!ctx.mobile && (state.idle !== 'active' || state.windowId === -1)) return null;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await ctx.chrome.tabs.query({ active: true, ...(ctx.mobile ? {} : { windowId: state.windowId }) });
  } catch {
    return null;
  }
  const id = tabs[0]?.id;
  if (id === undefined) return null;
  const tab = await tabPage(ctx, id);
  if (tab === null) return null;
  const page = await pageOf(tab.url, await currentDenylist(ctx));
  return page === null ? null : { tab, page };
}

async function saveFocus(ctx: Context, state: FocusState, at: number): Promise<void> {
  await Promise.all([focusState.set(ctx.chrome, state), mirror.set(ctx.chrome, { open: state.open, lastBeat: at })]);
}

/**
 * The focus state. When storage.session has none (the browser restarted, the extension reloaded), a fresh one from
 * Chrome, after closing the span the mirror still holds at its last beat.
 */
export async function loadFocus(ctx: Context, at: number): Promise<FocusState> {
  const state = await focusState.get(ctx.chrome);
  if (state !== undefined) return state;
  const stale = await mirror.get(ctx.chrome);
  const fresh: FocusState = { open: null, windowId: await focusedWindow(ctx), idle: ctx.mobile ? 'active' : await ctx.chrome.idle.queryState(IDLE_SECONDS) };
  // An iOS event page may be recreated between minute beats while the same document remains visible.
  if (ctx.mobile && stale.open !== null && at >= stale.lastBeat && at - stale.lastBeat <= GAP_MS) {
    const target = await focusTarget(ctx, fresh);
    if (target !== null && await keepsSpan(ctx, stale.open, target, at)) {
      const resumed = { ...fresh, open: stale.open };
      await saveFocus(ctx, resumed, at);
      return resumed;
    }
  }
  if (stale.open !== null) await closeSpan(ctx, stale.open, stale.lastBeat, stale.lastBeat);
  await saveFocus(ctx, fresh, at);
  return fresh;
}

/**
 * Closes a span at `end` (never before its start or past its visit's six hours) and queues its visit; the visit ends
 * when it can take no further focus.
 */
export async function closeSpan(ctx: Context, open: Span, end: number, at: number): Promise<void> {
  const visit = await getVisit(ctx.db, open.visitId);
  if (visit === undefined) return;
  const previousEnd = visit.spans[visit.spans.length - 1]?.[1] ?? open.start;
  const start = Math.max(open.start, previousEnd);
  const stop = Math.min(end, firstFocus(visit, start) + VISIT_MAX_MS);
  if (stop > start) {
    visit.spans.push([start, stop]);
    visit.changed = true;
  }
  await queueVisit(ctx, visit, at);
  if (visitOver(visit, at)) await deleteVisit(ctx.db, visit.id);
  else await saveVisit(ctx.db, visit);
}

/** A title change of the open span's visit (the tab's title is the visit's latest). */
function retitle(visit: Visit, title: string): boolean {
  if (visit.title === title) return false;
  visit.title = title;
  visit.changed ||= visit.spans.length > 0;
  return true;
}

/** Opens a span on the target, in the tab's open visit when it is still the same visit, else in a new one. */
async function openSpan(ctx: Context, { tab, page }: Target, at: number): Promise<Span> {
  let visit = await visitOfTab(ctx.db, tab.tabId);
  if (visit !== undefined && (visit.documentId !== tab.documentId || visit.page.pageId !== page.pageId || visitOver(visit, at))) {
    await endVisit(ctx, visit, at);
    visit = undefined;
  }
  const title = titleOf(page, tab.title);
  if (visit === undefined) visit = newVisit(ctx.uuid(), tab.tabId, tab.documentId, page, title, at);
  else retitle(visit, title);
  await saveVisit(ctx.db, visit);
  return { visitId: visit.id, tabId: tab.tabId, documentId: tab.documentId, start: at };
}

/** Whether the open span stays open on the target (same tab, document and page, within its visit's six hours). */
async function keepsSpan(ctx: Context, open: Span, target: Target, at: number): Promise<boolean> {
  if (open.tabId !== target.tab.tabId || open.documentId !== target.tab.documentId) return false;
  const visit = await getVisit(ctx.db, open.visitId);
  if (visit === undefined || visit.page.pageId !== target.page.pageId || at - firstFocus(visit, open.start) >= VISIT_MAX_MS) return false;
  if (retitle(visit, titleOf(target.page, target.tab.title))) await saveVisit(ctx.db, visit);
  return true;
}

/**
 * Makes the open span follow Chrome's state at `at`: `change` is what the event said (the focused window, the idle
 * state), `endAt` an earlier end for a span that closes (going idle).
 */
export async function reconcile(ctx: Context, at: number, change: Partial<Pick<FocusState, 'windowId' | 'idle'>> = {}, endAt?: number): Promise<void> {
  const state: FocusState = { ...(await loadFocus(ctx, at)), ...change };
  const { lastBeat } = await mirror.get(ctx.chrome);
  // After a silence the focus is known to have held only until the last beat.
  let end = endAt ?? at;
  if (state.open !== null && at - lastBeat > GAP_MS) end = Math.min(end, lastBeat);
  const target = await focusTarget(ctx, state);
  if (state.open !== null && target !== null && end === at && (await keepsSpan(ctx, state.open, target, at))) {
    await saveFocus(ctx, state, at);
    return;
  }
  if (state.open !== null) await closeSpan(ctx, state.open, end, at);
  const open = target === null ? null : await openSpan(ctx, target, at);
  await saveFocus(ctx, { ...state, open }, at);
}

/** The idle state changed: going idle backdates the end by the threshold, a lock ends the span at once. */
export async function idleChanged(ctx: Context, idle: IdleState, at: number): Promise<void> {
  await reconcile(ctx, at, { idle }, idle === 'idle' ? at - IDLE_SECONDS * 1000 : undefined);
}

/**
 * A tab's document, URL or title changed: the focus follows, and a visit of the tab that no longer shows its document
 * and page ends (a background tab's too); a title change is the visit's new title.
 */
export async function tabChanged(ctx: Context, tabId: number, at: number): Promise<void> {
  await reconcile(ctx, at);
  const visit = await visitOfTab(ctx.db, tabId);
  if (visit === undefined || (await loadFocus(ctx, at)).open?.visitId === visit.id) return;
  const tab = await tabPage(ctx, tabId);
  const page = tab === null ? null : await pageOf(tab.url, await currentDenylist(ctx));
  if (tab === null || page === null || tab.documentId !== visit.documentId || page.pageId !== visit.page.pageId) {
    await endVisit(ctx, visit, at);
    return;
  }
  if (retitle(visit, titleOf(page, tab.title))) await saveVisit(ctx.db, visit);
}

/** A tab closed: the focus moves on, and the tab's visit ends. */
export async function tabRemoved(ctx: Context, tabId: number, at: number): Promise<void> {
  await reconcile(ctx, at);
  const state = await loadFocus(ctx, at);
  if (state.open?.tabId === tabId) {
    await closeSpan(ctx, state.open, at, at);
    await saveFocus(ctx, { ...state, open: null }, at);
  }
  const visit = await visitOfTab(ctx.db, tabId);
  if (visit !== undefined) await endVisit(ctx, visit, at);
}

/**
 * The one-minute beat: the focus follows Chrome (a silence before it closes the span at the last beat), visits without
 * focus for 30 minutes end, and a visit that lasts is queued every 30 minutes when it changed (the focused one by
 * closing its span and opening the next).
 */
export async function beat(ctx: Context, at: number): Promise<void> {
  await reconcile(ctx, at);
  const state = await loadFocus(ctx, at);
  for (const visit of await allVisits(ctx.db)) {
    if (visit.id === state.open?.visitId) {
      if (at - visit.queuedAt < VISIT_REQUEUE_MS) continue;
      await closeSpan(ctx, state.open, at, at);
      await saveFocus(ctx, { ...state, open: null }, at);
      await reconcile(ctx, at);
    } else if (visitOver(visit, at)) {
      await endVisit(ctx, visit, at);
    } else if (visit.changed && at - visit.queuedAt >= VISIT_REQUEUE_MS) {
      await queueVisit(ctx, visit, at);
      await saveVisit(ctx.db, visit);
    }
  }
}

/** Chrome started: the span left in the mirror closes at its last beat, and the last session's visits end. */
export async function browserStarted(ctx: Context, at: number): Promise<void> {
  await loadFocus(ctx, at);
  for (const visit of await allVisits(ctx.db)) await endVisit(ctx, visit, at);
  await reconcile(ctx, at);
}

/** Before the extension reloads: the open span closes now. */
export async function releaseFocus(ctx: Context, at: number): Promise<void> {
  const state = await loadFocus(ctx, at);
  if (state.open !== null) await closeSpan(ctx, state.open, at, at);
  await saveFocus(ctx, { ...state, open: null }, at);
}

/** A hidden iOS document ends its span at the event time, before suspension; visible resumes use a fresh probe. */
export async function pageVisibility(ctx: Context, tabId: number, documentId: string, visible: boolean, at: number): Promise<void> {
  if (!ctx.mobile) return;
  if (!visible) {
    // pagehide can itself wake a recreated event page. Its exact document identity closes the mirrored span
    // at the event time without requiring that the document still be visible to a new probe.
    const saved = await mirror.get(ctx.chrome);
    const state = await focusState.get(ctx.chrome);
    const open = state === undefined ? saved.open : state.open;
    if (open?.tabId !== tabId || open.documentId !== documentId) return;
    await closeSpan(ctx, open, at - saved.lastBeat > GAP_MS ? saved.lastBeat : at, at);
    await saveFocus(ctx, { open: null, windowId: state?.windowId ?? -1, idle: 'active' }, at);
    return;
  }
  await reconcile(ctx, at);
}
