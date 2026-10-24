/** Hourly Codex runner: bounded masked claims and durable decisions, sharing the unread queue and Gmail ledger. */
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import type { ServiceHandlers, ShapeOf } from '@ziyixi/proto/http-transcoder';
import { ClassificationBatchStatusSchema, type ClassificationBatchStatus } from '@ziyixi/proto/mailsort/ui/v2/status_pb';
import {
  ClaimClassificationResponseSchema, ClassificationMessageSchema, MailsortRunnerService, Priority,
  ReportClassificationResponseSchema, RunStatus, type ClassificationMessage,
} from '@ziyixi/proto/mailsort/runner/v1/mailsort_runner_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import type { ApiContext } from './api.ts';
import { setCurrentLabels } from './feedback.ts';
import { countFlow } from './flow.ts';
import { GoogleError } from './gmail.ts';
import { cut, features, mask, summaryOf } from './mask.ts';
import { readMessage } from './mime.ts';
import { MAIL_TIME_ZONE, P1_ID, priorityGmailIds, priorityStartedAt } from './priority.ts';
import { sortError } from './reasons.ts';
import { effectiveMode, readSettings } from './settings.ts';
import { writeScope } from './session.ts';
import { utcDay, type Store } from './store.ts';
import { decisionForRecheck, fallbackP1, finishUnread, scanUnread, startUnread, unreadRechecksAll,
  unreadRechecksFallback, unreadRechecksInitial100, unreadScanning } from './unread.ts';
import { intend } from './writes.ts';

const PAGE_SIZE = 10;
const RUN_SIZE = 100;
const EXCLUDED = new Set(['SENT', 'DRAFT', 'SPAM', 'TRASH', 'CHAT']);
const PRIORITIES: Readonly<Record<number, string>> = { [Priority.P1]: 'p1', [Priority.P2]: 'p2', [Priority.P3]: 'p3', [Priority.P4]: 'p4' };

export interface RunnerState {
  readonly runId: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly state: 'running' | 'completed' | 'failed';
  readonly page: number;
  readonly listed: boolean;
  readonly model: string;
  readonly effort: string;
  readonly promptSha: string;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly usagePartial: boolean;
  readonly errorCode: string;
}
interface Selected extends Record<string, SqlStorageValue> {
  message_id: string;
  input_json: string | null;
  base_labels: string;
  priority: string | null;
  reason: string | null;
  ledger_id: string | null;
}
export function runnerState(store: Store): RunnerState | null {
  const value = store.getMeta('classification_run');
  return value === null ? null : JSON.parse(value) as RunnerState;
}
function saveRun(store: Store, run: RunnerState): void { store.setMeta('classification_run', JSON.stringify(run)); }
function counts(store: Store, runId: string): { selected: number; judged: number } {
  return store.one<{ selected: number; judged: number }>(
    `SELECT count(*) AS selected, coalesce(sum(priority IS NOT NULL), 0) AS judged FROM classification_items WHERE run_id = ?`, runId,
  ) ?? { selected: 0, judged: 0 };
}
function pendingWrites(store: Store): number {
  return store.count(`SELECT count(*) AS n FROM ledger WHERE state = 'intended' AND superseded = 0`);
}

/** Safe owner/Ops projection, read from the same durable run record. */
export function batchStatus(store: Store): ClassificationBatchStatus | undefined {
  const run = runnerState(store);
  if (run === null) return undefined;
  const current = counts(store, run.runId);
  return create(ClassificationBatchStatusSchema, {
    runId: run.runId, state: run.state, startedTime: timestampFromMs(run.startedAt),
    ...(run.completedAt > 0 ? { completedTime: timestampFromMs(run.completedAt) } : {}),
    errorCode: run.errorCode, model: run.model, effort: run.effort, promptSha: run.promptSha,
    selectedCount: current.selected, judgedCount: current.judged, pendingWriteCount: pendingWrites(store),
    ...(run.inputTokens === undefined ? {} : { inputTokens: run.inputTokens }),
    ...(run.outputTokens === undefined ? {} : { outputTokens: run.outputTokens }), usagePartial: run.usagePartial,
  });
}
function invalid(): never { throw sortError('BAD_REQUEST'); }
function skip(ctx: ApiContext, messageId: string): void {
  ctx.transact(() => { finishUnread(ctx.store, messageId, 'skipped'); ctx.store.run(`DELETE FROM pending WHERE message_id = ?`, messageId); });
}
/** Masked input and the labels needed by the existing write/undo contract; no attachments. */
async function selectMessage(ctx: ApiContext, messageId: string): Promise<ClassificationMessage | null> {
  const gmail = await ctx.gmail();
  if (typeof gmail === 'string') throw sortError('GMAIL_NOT_AUTHORIZED');
  let raw;
  try { raw = await gmail.message(messageId); }
  catch (error) {
    if (error instanceof GoogleError && error.kind === 'not_found') { skip(ctx, messageId); return null; }
    throw error;
  }
  const read = readMessage(raw.message);
  if (read === null || raw.metadataOnly || !read.labelIds.includes('UNREAD') || read.labelIds.some(id => EXCLUDED.has(id))) {
    skip(ctx, messageId); return null;
  }
  const current = read.labelIds.filter(id => priorityGmailIds(ctx.store).has(id));
  const all = unreadRechecksAll(ctx.store);
  const fallback = unreadRechecksFallback(ctx.store);
  const initial = unreadRechecksInitial100(ctx.store);
  if ((!all && !fallback && !initial && (current.length > 0 || ctx.store.decision(messageId)?.decider === 'codex')) ||
    (fallback && (!fallbackP1(ctx.store, messageId) || current.length !== 1 || current[0] !== ctx.store.label(P1_ID)?.gmail_id)) ||
    (initial && (decisionForRecheck(ctx.store, messageId) === undefined || current.length !== 1))) {
    skip(ctx, messageId); return null;
  }
  const f = await features(read);
  const maskedBody = mask(read.body, Number.MAX_SAFE_INTEGER);
  const bodyTruncated = Array.from(maskedBody).length > 12_000;
  const input = create(ClassificationMessageSchema, {
    messageId: read.id, threadId: read.threadId, receivedAt: timestampFromMs(read.receivedAt),
    subject: f.subject, sender: f.sender, snippet: f.snippet, body: cut(maskedBody, bodyTruncated ? 11_999 : 12_000), toCode: f.toCode, category: f.category,
    timeZone: MAIL_TIME_ZONE, bodyTruncated,
  });
  const run = runnerState(ctx.store) ?? invalid();
  ctx.transact(() => ctx.store.run(`INSERT OR IGNORE INTO classification_items (run_id, message_id, input_json, base_labels, selected_at)
    VALUES (?, ?, ?, ?, ?)`, run.runId, messageId, JSON.stringify(toWire(ClassificationMessageSchema, input)), JSON.stringify(read.labelIds), ctx.now));
  return input;
}

export const runnerHandlers: ServiceHandlers<ShapeOf<typeof MailsortRunnerService>, ApiContext> = {
  async claimClassification(request, ctx) {
    if (priorityStartedAt(ctx.store) === 0 || effectiveMode(readSettings(ctx.store), ctx.ceiling) === 'off') throw sortError('GMAIL_WRITE_NOT_ALLOWED');
    let run = runnerState(ctx.store);
    if (run === null || run.runId !== request.runId) {
      if (request.pageToken !== '') invalid();
      run = { runId: request.runId, startedAt: ctx.now, completedAt: run?.completedAt ?? 0, state: 'running', page: 0, listed: false,
        model: '', effort: '', promptSha: '', inputTokens: undefined, outputTokens: undefined, usagePartial: false, errorCode: '' };
      const started = run;
      ctx.transact(() => { startUnread(ctx.store, ctx.now); saveRun(ctx.store, started); });
    }
    const page = request.pageToken === '' ? 0 : Number(request.pageToken);
    if (!Number.isSafeInteger(page) || page < 0) invalid();
    const cacheKey = `classification-claim:${run.runId}:${String(page)}`;
    const cached = ctx.store.request(cacheKey, ctx.now);
    if (cached !== undefined) {
      const answer = fromWire(ClaimClassificationResponseSchema, JSON.parse(cached.response) as unknown).message;
      const activeRunId = run.runId;
      answer.messages = answer.messages.filter(message => ctx.store.one(`SELECT 1 AS x FROM classification_items WHERE run_id = ? AND message_id = ? AND priority IS NOT NULL`, activeRunId, message.messageId) === undefined);
      return answer;
    }
    if (run.state !== 'running' || page !== run.page) invalid();
    const gmail = await ctx.gmail();
    if (typeof gmail === 'string') throw sortError('GMAIL_NOT_AUTHORIZED');
    const messages: ClassificationMessage[] = [];
    if (unreadScanning(ctx.store)) await scanUnread(ctx.store, gmail, ctx.now, ctx.transact);
    else {
      const selected = counts(ctx.store, run.runId).selected;
      const candidates = ctx.store.all<{ message_id: string }>(`SELECT b.message_id FROM unread_batch b
        JOIN pending p ON p.message_id = b.message_id WHERE b.state = 'pending' AND b.ledger_id IS NULL AND p.not_before <= ?
        AND NOT EXISTS (SELECT 1 FROM classification_items c WHERE c.run_id = ? AND c.message_id = b.message_id)
        ORDER BY p.added_at, b.message_id LIMIT ?`, ctx.now, run.runId, Math.min(PAGE_SIZE, RUN_SIZE - selected));
      for (const candidate of candidates) {
        const input = await selectMessage(ctx, candidate.message_id);
        if (input !== null) messages.push(input);
      }
    }
    const selected = counts(ctx.store, run.runId).selected;
    const more = selected < RUN_SIZE && (unreadScanning(ctx.store) || ctx.store.one(`SELECT 1 AS x FROM unread_batch b
      JOIN pending p ON p.message_id = b.message_id WHERE b.state = 'pending' AND b.ledger_id IS NULL AND p.not_before <= ?
      AND NOT EXISTS (SELECT 1 FROM classification_items c WHERE c.run_id = ? AND c.message_id = b.message_id) LIMIT 1`, ctx.now, run.runId) !== undefined);
    const answer = create(ClaimClassificationResponseSchema, {
      runId: run.runId, evaluatedAt: timestampFromMs(run.startedAt), messages, nextPageToken: more ? String(page + 1) : '',
    });
    ctx.transact(() => {
      saveRun(ctx.store, { ...run, page: page + 1, listed: !more });
      ctx.store.putRequest(cacheKey, 'ClaimClassification', run.runId, JSON.stringify(toWire(ClaimClassificationResponseSchema, answer)), ctx.now);
    });
    return answer;
  },

  async reportClassification(request, ctx) {
    if (request.requestId === '' || !/^gpt-[a-zA-Z0-9.-]{1,80}$/.test(request.model) || request.effort !== 'medium' ||
      !/^[a-f0-9]{64}$/.test(request.promptSha) || !/^(?:[a-z][a-z0-9_]{0,63})?$/.test(request.errorCode) ||
      !(new Set<RunStatus>([RunStatus.RUNNING, RunStatus.COMPLETED, RunStatus.FAILED])).has(request.status)) invalid();
    const cached = ctx.store.request(request.requestId, ctx.now);
    const signature = JSON.stringify(toWire(MailsortRunnerService.method.reportClassification.input, request));
    if (cached !== undefined) {
      if (cached.rpc !== 'ReportClassification' || cached.resource !== signature) invalid();
      return fromWire(ReportClassificationResponseSchema, JSON.parse(cached.response) as unknown).message;
    }
    const run = runnerState(ctx.store);
    if (run === null || run.runId !== request.runId || run.state !== 'running') invalid();
    const seen = new Set<string>();
    const selected = request.results.map(result => {
      if (seen.has(result.messageId) || PRIORITIES[result.priority] === undefined || result.reason.trim() === '' || Array.from(result.reason).length > 300) invalid();
      seen.add(result.messageId);
      const item = ctx.store.one<Selected>(`SELECT * FROM classification_items WHERE run_id = ? AND message_id = ?`, run.runId, result.messageId) ?? invalid();
      const priority = PRIORITIES[result.priority] ?? invalid();
      const reason = mask(result.reason.trim(), 300);
      if (item.priority !== null && (item.priority !== priority || item.reason !== reason)) invalid();
      return { item, priority, reason };
    });
    const current = counts(ctx.store, run.runId);
    const fresh = selected.filter(({ item }) => item.priority === null);
    if (request.status === RunStatus.COMPLETED && (!run.listed || current.judged + fresh.length !== current.selected)) invalid();
    const answer = ctx.transact(() => {
      for (const { item, priority, reason } of fresh) {
        if (item.input_json === null) invalid();
        const input = fromWire(ClassificationMessageSchema, JSON.parse(item.input_json) as unknown).message;
        const label = ctx.store.label(priority) ?? invalid();
        const base = JSON.parse(item.base_labels) as string[];
        const unchanged = base.includes(label.gmail_id ?? '');
        const live = effectiveMode(readSettings(ctx.store), ctx.ceiling) === 'live' && writeScope(ctx.store);
        const apply = live && !unchanged && label.gmail_state === 'linked' && label.gmail_name_taken === 0;
        const receivedAt = input.receivedAt === undefined ? 0 : Number(input.receivedAt.seconds) * 1000;
        ctx.store.run(`INSERT OR REPLACE INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, top_label,
          decider, model, runner_effort, runner_prompt_sha, runner_reason, subject, sender, summary, current_labels)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'codex', ?, ?, ?, ?, ?, ?, ?, ?)`, item.message_id, input.threadId, receivedAt, ctx.now,
          apply || unchanged ? 'applied' : 'suggested', priority, priority, request.model,
          request.effort, request.promptSha, reason, input.subject, input.sender,
          summaryOf({ subject: input.subject, sender: input.sender, snippet: input.snippet }, 1200),
          JSON.stringify(base.flatMap(id => { const current = ctx.store.labelByGmailId(id); return current === undefined ? [] : [current.id]; })));
        ctx.store.addUsage(utcDay(ctx.now), 'decided', 1);
        let ledgerId: string | null = null;
        if (unchanged) setCurrentLabels(ctx.store, item.message_id, [priority]);
        else countFlow(ctx.store, ctx.now, 'codex', apply ? (priority === P1_ID ? 'kept_in_inbox' : 'archived') : 'suggested', priority);
        if (apply) ledgerId = intend(ctx.store, item.message_id, label, priority !== P1_ID, 'auto', ctx.now, base);
        ctx.store.run(`UPDATE classification_items SET priority = ?, reason = ?, ledger_id = ? WHERE run_id = ? AND message_id = ?`, priority, reason, ledgerId, run.runId, item.message_id);
        if (ledgerId !== null) ctx.store.run(`UPDATE unread_batch SET ledger_id = ? WHERE message_id = ?`, ledgerId, item.message_id);
        else finishUnread(ctx.store, item.message_id, 'skipped');
        ctx.store.run(`DELETE FROM pending WHERE message_id = ?`, item.message_id);
      }
      const state = request.status === RunStatus.COMPLETED ? 'completed' : request.status === RunStatus.FAILED ? 'failed' : 'running';
      saveRun(ctx.store, { ...run, state, completedAt: state === 'completed' ? ctx.now : run.completedAt,
        model: request.model, effort: request.effort, promptSha: request.promptSha,
        inputTokens: request.inputTokens ?? run.inputTokens, outputTokens: request.outputTokens ?? run.outputTokens,
        usagePartial: request.usagePartial, errorCode: state === 'failed' ? request.errorCode || 'model_failed' : '' });
      const response = create(ReportClassificationResponseSchema, { acceptedCount: fresh.length, pendingWriteCount: pendingWrites(ctx.store) });
      ctx.store.putRequest(request.requestId, 'ReportClassification', signature, JSON.stringify(toWire(ReportClassificationResponseSchema, response)), ctx.now);
      return response;
    });
    await ctx.wake();
    return answer;
  },
};
