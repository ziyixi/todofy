/** Brief's call ledger and budget gates over the shared Model Router contract. */
import { createModelClient, modelRequest, type ModelBinding } from '@ziyixi/model-router-client';
import { buildSha, type Env, type ModeName } from './env.ts';
import { MODEL_DEADLINE_MARGIN_MS, MODEL_DEADLINE_MS, RESERVATION_RATES } from './limits.ts';
import type { Params } from './prompts.ts';
import { localDate, monthOf } from './schedule.ts';
import { isPaused } from './settings.ts';
import type { CallRow, Store } from './store.ts';

export type CallStep = 'gate' | 'pick' | 'write' | 'bisect' | 'repair' | 'entail' | 'deep_pick' | 'deep_read' | 'deep_repair';
export interface CallContext {
  readonly store: Store;
  readonly env: Pick<Env, 'MODEL_ROUTER' | 'BUILD_SHA'>;
  readonly mode: ModeName;
  readonly now: () => number;
  readonly transact: <T>(fn: () => T) => T;
  readonly timeLeft: () => number;
  readonly budgetUsd: number;
}
export interface ModelRequest {
  readonly step: CallStep;
  readonly issue: string;
  readonly model: string;
  readonly params: Params;
  readonly estimatedInputTokens: number;
  readonly deadlineMs?: number;
}
export type ModelOutcome =
  | { readonly kind: 'answer'; readonly callId: number; readonly text: string; readonly json: unknown; readonly served: string; readonly writers: readonly string[] }
  | { readonly kind: 'refusal'; readonly callId: number; readonly category: string | null; readonly served: string }
  | { readonly kind: 'invalid'; readonly callId: number; readonly code: string }
  | { readonly kind: 'failed'; readonly callId: number; readonly code: string }
  | { readonly kind: 'transient'; readonly code: string; readonly retryAfterMs: number | null }
  | { readonly kind: 'rejected'; readonly status: number; readonly errorType: string }
  | { readonly kind: 'blocked'; readonly reason: BlockedReason };
export type BlockedReason = 'paused' | 'mode_off' | 'not_configured' | 'rejected' | 'budget' | 'cutoff';
export interface RejectedState { readonly status: number; readonly type: string; readonly build: string; readonly ms: number; }
const REJECTED_KEY = 'anthropic_rejected';
export function rejectedState(store: Store): RejectedState | null { return store.getJson<RejectedState | null>(REJECTED_KEY, null); }
export function resumeCalls(store: Store): void { store.deleteMeta(REJECTED_KEY); }
export function callsStopped(store: Store, env: Pick<Env, 'MODEL_ROUTER' | 'BUILD_SHA'>): boolean {
  const state = rejectedState(store);
  if (state === null) return false;
  if (state.build !== buildSha(env)) { resumeCalls(store); return false; }
  return true;
}

/** The month's spend: the costs of finished calls, the reservations of interrupted ones, and those in flight. */
export function monthSpend(store: Store, month: string): { spent: number; reserved: number } {
  const row = store.one<{ spent: number | null; reserved: number | null }>(
    `SELECT sum(CASE WHEN state = 'open' THEN 0 ELSE cost END) AS spent, sum(CASE WHEN state = 'open' THEN reserved ELSE 0 END) AS reserved FROM calls WHERE month = ?`,
    month,
  );
  return { spent: row?.spent ?? 0, reserved: row?.reserved ?? 0 };
}

/** Today's spend (local day). */
export function daySpend(store: Store, day: string): number {
  return store.one<{ spent: number | null }>(`SELECT sum(cost) AS spent FROM calls WHERE day = ? AND state != 'open'`, day)?.spent ?? 0;
}

/**
 * Settles the calls a previous invocation left open (at the start of every alarm, before any new call): one started by
 * an older build was killed by a deploy (`killed`: no attempt used, its reservation kept); one of this build crashed
 * (`failed`: an attempt used, its reservation kept). Answers how many of each.
 */
export function settleOpenCalls(store: Store, build: string, now: number): { killed: number; crashed: number } {
  const open = store.all<{ id: number; build: string; reserved: number }>(`SELECT id, build, reserved FROM calls WHERE state = 'open'`);
  let killed = 0;
  let crashed = 0;
  for (const call of open) {
    const deploy = call.build !== build;
    store.run(`UPDATE calls SET state = ?, cost = ?, error = ?, finished_ms = ? WHERE id = ?`, deploy ? 'killed' : 'failed', call.reserved, deploy ? 'deploy_killed' : 'crashed', now, call.id);
    if (deploy) killed++;
    else crashed++;
  }
  return { killed, crashed };
}

/** Attempts of a step of an issue that count (answered, refused, invalid or failed: not killed, not transient). */
export function attemptsOf(store: Store, issue: string, step: CallStep): number {
  return store.count(`SELECT count(*) AS n FROM calls WHERE issue = ? AND step = ? AND state IN ('done', 'failed')`, issue, step);
}

/** The newest answered call of a step that its step has not read yet (`after`: the last call it read), or null. */
export function unreadAnswer(store: Store, issue: string, step: CallStep, after: number): CallRow | null {
  return store.one<CallRow>(`SELECT * FROM calls WHERE issue = ? AND step = ? AND state = 'done' AND stop = 'end_turn' AND answer != '' AND id > ? ORDER BY id DESC LIMIT 1`, issue, step, after) ?? null;
}

/** Reserves at the rates of limits.ts, calls the Router, and settles its outcome. */
export async function callModel(ctx: CallContext, request: ModelRequest): Promise<ModelOutcome> {
  if (ctx.mode === 'off') return { kind: 'blocked', reason: 'mode_off' };
  if (isPaused(ctx.store)) return { kind: 'blocked', reason: 'paused' };
  const binding: ModelBinding | undefined = ctx.env.MODEL_ROUTER;
  const rates = RESERVATION_RATES[request.model];
  if (!binding || rates === undefined) return { kind: 'blocked', reason: 'not_configured' };
  if (callsStopped(ctx.store, ctx.env)) return { kind: 'blocked', reason: 'rejected' };
  const client = createModelClient(binding);
  const build = buildSha(ctx.env);
  const startedAt = ctx.now();
  const day = localDate(startedAt);
  const month = monthOf(day);
  const reserved = (request.estimatedInputTokens * rates.input + request.params.parameters.maxOutputTokens * rates.output) / 1_000_000;
  const callId = ctx.transact(() => {
    const { spent, reserved: inFlight } = monthSpend(ctx.store, month);
    if (spent + inFlight + reserved > ctx.budgetUsd) return null;
    const attempt = attemptsOf(ctx.store, request.issue, request.step) + 1;
    ctx.store.insert('calls', { issue: request.issue, step: request.step, attempt, build, model: request.model, state: 'open', reserved, day, month, started_ms: startedAt });
    return ctx.store.one<{ id: number }>(`SELECT last_insert_rowid() AS id`)?.id ?? 0;
  });
  if (callId === null) return { kind: 'blocked', reason: 'budget' };
  const fail = (code: string, cost = reserved): ModelOutcome => {
    ctx.store.run(`UPDATE calls SET state = 'failed', cost = ?, error = ?, finished_ms = ? WHERE id = ?`, cost, code, ctx.now(), callId);
    return { kind: 'failed', callId, code };
  };
  const timeout = Math.max(1000, Math.min(request.deadlineMs ?? MODEL_DEADLINE_MS, ctx.timeLeft() - MODEL_DEADLINE_MARGIN_MS, 840_000));
  const options = { model: request.model, instructions: request.params.instructions, ...request.params.parameters, outputSchemaJson: request.params.outputSchemaJson };
  let result;
  try { result = await client.generate(modelRequest(request.params.input, options, timeout)); }
  catch { return fail('model_connection_interrupted'); }
  const usage = result.usage;
  const cost = usage?.available && usage.billingKind === 'api' && usage.estimatedCostMicrousd !== undefined ? usage.estimatedCostMicrousd / 1_000_000 : reserved;
  const writers = result.contributingModels;
  ctx.store.run(`UPDATE calls SET served = ?, input = ?, output = ?, cache_write = ?, cache_read = ?, request_id = ?, writers = ? WHERE id = ?`,
    result.model, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, usage?.cacheWriteTokens ?? 0, usage?.cachedInputTokens ?? 0, result.name.split('/')[1] ?? '', JSON.stringify(writers), callId);
  if (result.error && result.error.reason !== 'MODEL_REFUSED' && result.error.reason !== 'MODEL_OUTPUT_LIMIT') {
    const error = result.error;
    if (['MODEL_RATE_LIMIT', 'MODEL_QUOTA', 'MODEL_SPEND_LIMIT'].includes(error.reason)) {
      ctx.store.run(`UPDATE calls SET state = 'released', cost = 0, error = ?, finished_ms = ? WHERE id = ?`, error.reason, ctx.now(), callId);
      return { kind: 'transient', code: error.reason, retryAfterMs: error.retryAfterSeconds > 0 ? error.retryAfterSeconds * 1000 : null };
    }
    if ([3, 7, 9, 16].includes(error.code)) {
      ctx.transact(() => {
        ctx.store.run(`UPDATE calls SET state = 'released', cost = 0, error = ?, finished_ms = ? WHERE id = ?`, error.reason, ctx.now(), callId);
        ctx.store.setJson(REJECTED_KEY, { status: error.code, type: error.reason, build, ms: ctx.now() } satisfies RejectedState);
        ctx.store.pushError('anthropic_rejected');
      });
      return { kind: 'rejected', status: error.code, errorType: error.reason };
    }
    return fail(error.reason, cost);
  }
  const stop = result.error?.reason === 'MODEL_REFUSED' ? 'refusal' : result.error?.reason === 'MODEL_OUTPUT_LIMIT' ? 'max_tokens' : !result.error ? 'end_turn' : 'interrupted';
  const answer = stop === 'end_turn' ? readAnswer(callId, result.output, result.model, writers) : null;
  ctx.store.run(`UPDATE calls SET state = 'done', cost = ?, stop = ?, refusal = ?, answer = ?, finished_ms = ? WHERE id = ?`,
    cost, stop, stop === 'refusal' ? 'MODEL_REFUSED' : '', answer?.kind === 'answer' ? result.output : '', ctx.now(), callId);
  if (stop === 'refusal') return { kind: 'refusal', callId, category: null, served: result.model };
  if (stop === 'max_tokens') return { kind: 'invalid', callId, code: 'max_tokens' };
  return answer ?? { kind: 'invalid', callId, code: `stop_${stop}` };
}

/** The app validates JSON and then each pipeline step validates its own business shape. */
export function readAnswer(callId: number, text: string, served: string, writers: readonly string[]): ModelOutcome {
  try { return { kind: 'answer', callId, text, json: JSON.parse(text) as unknown, served, writers }; }
  catch { return { kind: 'invalid', callId, code: 'not_json' }; }
}
export function markRead(store: Store, callId: number): void { store.run(`UPDATE calls SET answer = '' WHERE id = ?`, callId); }
