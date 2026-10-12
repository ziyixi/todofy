/** One owner-started, five-minute observation of the fixed public test page. No browsing values are retained. */
import type { CaptureDiagnostic, CaptureDiagnosticStep } from '@ziyixi/proto/recall/ingest/v1/diagnostic_wire';
import type { Context } from './context.ts';
import { getToken } from './db.ts';
import type { DiagnosticAnswer, DiagnosticStatus } from './messages.ts';
import { sendDiagnostic } from './upload.ts';
import { isoTime } from './visits.ts';

declare const RECALL_ORION: boolean;

// Keep the owner-only mobile test target out of the desktop package entirely.
export const DIAGNOSTIC_URL = ((typeof RECALL_ORION === 'undefined' || RECALL_ORION) && 'https://example.org/?recall-diagnostic=1') || '';
const DURATION_MS = 5 * 60_000;
const KEY = 'capture_diagnostic';

interface Run {
  readonly report: CaptureDiagnostic;
  readonly expiresAt: number;
  readonly tabId?: number;
  readonly stopped: boolean;
  readonly sentAt: number;
}

// A separate storage write queue cannot be held by focus queries, content callbacks or normal uploads.
const runs = new WeakMap<typeof chrome, Promise<Run | null>>();

type NativeStage = 'active_tabs' | 'tab_lookup' | 'probe_injection' | 'probe_reply' | 'capture_reply' | 'screenshot';
const nativeCalls = new WeakMap<typeof chrome, Set<{ readonly stage: NativeStage }>>();

/** Only unfinished native calls: no arguments, browsing values or event history. Finishing twice is harmless. */
export function beginNativeCall(ctx: Context, stage: NativeStage): () => void {
  if (!ctx.mobile) return () => undefined;
  const calls = nativeCalls.get(ctx.chrome) ?? new Set<{ readonly stage: NativeStage }>();
  nativeCalls.set(ctx.chrome, calls);
  const call = { stage };
  calls.add(call);
  return () => { calls.delete(call); };
}

async function read(ctx: Context): Promise<Run | null> {
  if (!ctx.mobile) return null;
  if (!runs.has(ctx.chrome)) {
    runs.set(ctx.chrome, ctx.chrome.storage.local.get(KEY).then((saved) => (saved[KEY] as Run | undefined) ?? null));
  }
  return runs.get(ctx.chrome) ?? null;
}

function change(ctx: Context, update: (run: Run | null) => Run | null): Promise<Run | null> {
  const pending = read(ctx).then(async (previous) => {
    const run = update(previous);
    if (run !== previous) await ctx.chrome.storage.local.set({ [KEY]: run });
    return run;
  });
  runs.set(ctx.chrome, pending);
  return pending;
}

function active(ctx: Context, run: Run | null): run is Run {
  return run !== null && !run.stopped && ctx.now() < run.expiresAt;
}

function view(ctx: Context, run: Run | null): DiagnosticStatus {
  const last = run?.report.steps.at(-1);
  return {
    state: run === null ? 'idle' : run.sentAt > 0 ? 'sent' : active(ctx, run) ? 'running' : 'stopped',
    runId: run?.report.run_id ?? '', startedAt: run === null ? 0 : Date.parse(run.report.start_time), expiresAt: run?.expiresAt ?? 0,
    stepCount: run?.report.steps.length ?? 0, tabEvents: run?.report.tab_event_count ?? 0, alarmEvents: run?.report.alarm_event_count ?? 0,
    sentAt: run?.sentAt ?? 0, latestStage: last?.stage ?? '', latestState: last?.state ?? '', steps: run?.report.steps ?? [],
  };
}

export function resultType(value: unknown): NonNullable<CaptureDiagnosticStep['result']> {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  return 'other';
}

export function isDiagnosticPage(url: string | undefined): boolean {
  return url === DIAGNOSTIC_URL;
}

/** Other tabs may reveal only their category in the active selection, never any content or identifier. */
export async function observe(ctx: Context, step: CaptureDiagnosticStep, tabId?: number, expectedRunId?: string | null): Promise<string | null> {
  if (!ctx.mobile || expectedRunId === null) return null;
  const observed = await change(ctx, (run) => {
    if (!active(ctx, run) || (expectedRunId !== undefined && expectedRunId !== run.report.run_id) || (tabId !== undefined && tabId !== run.tabId) || (tabId === undefined && !['active_tabs', 'alarm_setup', 'open_test_page'].includes(step.stage))) return run;
    const previous = run.report.steps.find((value) => value.stage === step.stage);
    // Reopening the test UI can start fresh native calls or hide the page. Keep the completed foreground evidence.
    if (previous !== undefined && previous.state !== 'pending' && step.state === 'pending') return run;
    if (step.stage === 'active_tabs' && previous?.selection === 'test_page' && step.selection !== 'test_page') return run;
    if (step.stage === 'probe_context' && previous?.visibility === 'visible' && step.visibility === 'hidden') return run;
    if (step.stage === 'focus_target' && previous?.result === 'visible' && (step.result === 'hidden' || step.result === 'excluded')) return run;
    return { ...run, report: { ...run.report, steps: [...run.report.steps.filter((value) => value.stage !== step.stage), step] } };
  });
  return active(ctx, observed) ? observed.report.run_id : null;
}

export async function observeTabs(ctx: Context, tabs: readonly chrome.tabs.Tab[], expectedRunId?: string | null): Promise<void> {
  const run = await read(ctx);
  if (!active(ctx, run) || expectedRunId === null || (expectedRunId !== undefined && expectedRunId !== run.report.run_id)) return;
  const first = tabs[0];
  const test = first !== undefined && !first.incognito && isDiagnosticPage(first.url);
  const extensionPage = first?.url?.startsWith('chrome-extension:') || first?.url?.startsWith('safari-web-extension:');
  const leftTestPage = first?.id !== undefined && first.id === run.tabId && !test;
  if (leftTestPage || (extensionPage && run.report.steps.some((step) => step.stage === 'active_tabs' && step.selection === 'test_page'))) {
    await change(ctx, (current) => active(ctx, current) && current.report.run_id === run.report.run_id ? { ...current, stopped: true } : current);
    return;
  }
  const tabId = first?.id;
  if (test && tabId !== undefined && run.tabId !== tabId) await change(ctx, (current) => active(ctx, current) && current.report.run_id === run.report.run_id ? { ...current, tabId } : current);
  await observe(ctx, { stage: 'active_tabs', state: 'returned', result: 'array', count: Math.min(tabs.length, 100), selection: test ? 'test_page' : first === undefined ? 'none' : extensionPage ? 'extension_page' : 'other_page' }, undefined, run.report.run_id);
}

export async function diagnosticEvent(ctx: Context, kind: 'tab' | 'alarm'): Promise<void> {
  const key = kind === 'tab' ? 'tab_event_count' : 'alarm_event_count';
  if (!ctx.mobile) return;
  await change(ctx, (run) => active(ctx, run) ? { ...run, report: { ...run.report, [key]: Math.min(1000, (run.report[key] ?? 0) + 1) } } : run);
}

export async function diagnosticRunId(ctx: Context, tabId: number): Promise<string | null> {
  const run = await read(ctx);
  return active(ctx, run) && run.tabId === tabId ? run.report.run_id : null;
}

export async function diagnosticStatus(ctx: Context): Promise<DiagnosticAnswer> {
  return { ok: true, diagnostic: view(ctx, await read(ctx)) };
}

export async function startDiagnostic(ctx: Context): Promise<DiagnosticAnswer> {
  if (!ctx.mobile) return { ok: false, error: 'unsupported', diagnostic: view(ctx, null) };
  if (await getToken(ctx.db) === '') return { ok: false, error: 'token_missing', diagnostic: view(ctx, await read(ctx)) };
  const at = ctx.now();
  const pendingStages = new Set(Array.from(nativeCalls.get(ctx.chrome) ?? [], (call) => call.stage));
  const beforeStart: CaptureDiagnosticStep[] = Array.from(pendingStages, (stage) => ({ stage, state: 'pending', initially_pending: true }));
  const run: Run = { expiresAt: at + DURATION_MS, stopped: false, sentAt: 0, report: { run_id: ctx.uuid(), start_time: isoTime(at), report_time: isoTime(at), steps: [{ stage: 'open_test_page', state: 'pending' }, ...beforeStart], tab_event_count: 0, alarm_event_count: 0 } };
  await change(ctx, () => run);
  // Do not await a native callback here: an unresponsive browser must still allow Send diagnostic.
  try {
    ctx.chrome.tabs.create({ url: DIAGNOSTIC_URL, active: true }, (answer: chrome.tabs.Tab | null | undefined) => {
      const failed = ctx.chrome.runtime.lastError !== undefined;
      const tab = answer ?? undefined;
      void (async () => {
        const current = await read(ctx);
        if (!active(ctx, current) || current.report.run_id !== run.report.run_id) return;
        const tabId = tab?.id;
        if (!failed && tab !== undefined && tabId !== undefined && !tab.incognito && isDiagnosticPage(tab.url)) await change(ctx, (latest) => active(ctx, latest) && latest.report.run_id === run.report.run_id ? { ...latest, tabId } : latest);
        await observe(ctx, { stage: 'open_test_page', state: failed ? 'failed' : 'returned', result: failed ? 'api_error' : resultType(tab) }, undefined, run.report.run_id);
      })().catch(() => undefined);
    });
  } catch {
    await observe(ctx, { stage: 'open_test_page', state: 'failed', result: 'api_error' });
    return { ok: false, error: 'open_failed', diagnostic: view(ctx, await read(ctx)) };
  }
  return diagnosticStatus(ctx);
}

export async function submitDiagnostic(ctx: Context): Promise<DiagnosticAnswer> {
  if (!ctx.mobile) return { ok: false, error: 'unsupported', diagnostic: view(ctx, null) };
  const stopped = await change(ctx, (current) => current === null ? null : { ...current, stopped: true, report: { ...current.report, report_time: isoTime(ctx.now()) } });
  if (stopped === null) return { ok: false, error: 'no_run', diagnostic: view(ctx, null) };
  const sent = await sendDiagnostic(ctx, stopped.report);
  if (sent) await change(ctx, (current) => current?.report.run_id === stopped.report.run_id ? { ...current, sentAt: ctx.now() } : current);
  return { ok: sent, ...(sent ? {} : { error: 'send_failed' as const }), diagnostic: view(ctx, await read(ctx)) };
}
