/**
 * The only code that calls the Claude API (../../docs/design.md §5, §7, §8, §13): through the official TypeScript SDK,
 * given the key explicitly (its default credential chain does not exist in Workers), with `maxRetries: 0` (the alarm
 * chain retries) and `timeout: 120_000` (it covers only the time to response headers). Every call streams
 * (`client.beta.messages.stream`) and reads `finalMessage()`; the stream has its own deadline, since nothing in the SDK
 * bounds a stalled body: an AbortSignal at min(13 minutes, the alarm's time left minus a minute), and a stall watchdog
 * that aborts when no byte (pings included) arrived for STREAM_STALL_MS.
 *
 * Before a call: the deployment's mode is not `off` and the owner has not paused the brief (both read at the moment of
 * the call, so the emergency stops of design §15 stop an issue already running), the key is set, the calls are not
 * stopped (`anthropic_rejected`), and its reservation (the estimated input and `max_tokens` at the dearest model that
 * may serve it) fits under the month's budget with every reservation in flight. An attempt row commits with the
 * build's BUILD_SHA and the reservation; `message_start`'s usage and model are stored when they arrive; the final
 * message is stored at once (its usage, request ID, serving model, stop reason, and its text when it parses as JSON)
 * and its cost replaces the reservation.
 *
 * Outcomes (design §7):
 * - `end_turn` with JSON: `answer` (the caller validates its shape: `invalid` when it does not hold); text that is no
 *   JSON is `invalid` (`not_json`), an attempt used;
 * - `refusal`: the whole chain declined (Opus 5.5's fallbacks run server-side; Haiku has none);
 * - `max_tokens`, a mid-stream error (an `overloaded_error` after HTTP 200 arrives as an APIError without status), the
 *   deadline, a stall, a timeout to headers: `failed`, one attempt used, the reservation kept (what a dead call
 *   generated cannot be counted from what streamed);
 * - 408, 409, 429, 529 or 5xx before the stream, or no connection: `transient`, no attempt, nothing charged;
 * - any other 4xx before the stream (400, 401, 402, 403, 404, 413): `rejected`: every model call stops at once until
 *   the key changes (the object keeps a SHA-256 prefix of it, never the key), a new build deploys, or the owner calls
 *   ResumeModelCalls. Its status and error type are kept, never the message's text.
 *
 * Opus calls ask for the server-side fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`): a
 * decline is retried on the model Anthropic routes that category to, inside the same call. The answer is every text
 * block joined in order: a fallback during the stream leaves the declined model's partial text, a `fallback` block,
 * then the fallback model's continuation.
 */
import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type { BetaMessage, BetaRawMessageStreamEvent, MessageCreateParamsBase } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { anthropicKey, buildSha, type Env, type ModeName } from './env.ts';
import { FALLBACK_BETA, MODEL_DEADLINE_MARGIN_MS, MODEL_DEADLINE_MS, SDK_TIMEOUT_MS, STREAM_STALL_MS } from './limits.ts';
import { costOfUsage, reservationOf } from './prices.ts';
import { localDate, monthOf } from './schedule.ts';
import { isPaused } from './settings.ts';
import type { CallRow, Store } from './store.ts';

export type CallStep = 'gate' | 'pick' | 'write' | 'bisect' | 'repair' | 'entail' | 'deep_pick' | 'deep_read' | 'deep_repair';

export interface CallContext {
  readonly store: Store;
  readonly env: Pick<Env, 'ANTHROPIC_API_KEY' | 'BUILD_SHA'>;
  /** The deployment's mode (BRIEF_MODE): `off` makes no call. */
  readonly mode: ModeName;
  /** The fetch the SDK uses (the platform's, or the tests' fake upstream). */
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly transact: <T>(fn: () => T) => T;
  /** Wall time left in the invocation (the alarm's 15 minutes). */
  readonly timeLeft: () => number;
  /** Settings.monthly_budget_usd. */
  readonly budgetUsd: number;
  /** The stall watchdog's silence (STREAM_STALL_MS; the unit tests shorten it). */
  readonly stallMs?: number;
}

export interface ModelRequest {
  readonly step: CallStep;
  /** The issue date, or the round's local day for the gate. */
  readonly issue: string;
  readonly model: string;
  /** The request without `model`, `stream` and the fallback options (prompts.ts builds it). */
  readonly params: Omit<MessageCreateParamsBase, 'model' | 'stream' | 'betas' | 'fallbacks'>;
  readonly estimatedInputTokens: number;
  /** The stream's deadline, at most MODEL_DEADLINE_MS (shorter for the gate and the log). */
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

/**
 * Why no call was made: the owner paused the brief, the deployment is off, no key, the calls are stopped, the month's
 * budget; `cutoff` is the pipeline's own (an issue makes no call past its send cutoff, pipeline.ts).
 */
export type BlockedReason = 'paused' | 'mode_off' | 'not_configured' | 'rejected' | 'budget' | 'cutoff';

/** The stopped state after a refusal that repeats. */
export interface RejectedState {
  readonly status: number;
  readonly type: string;
  /** The first 12 hex characters of the key's SHA-256. */
  readonly key: string;
  readonly build: string;
  readonly ms: number;
}

const REJECTED_KEY = 'anthropic_rejected';

export async function keyPrefix(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return Array.from(digest.slice(0, 6), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The stored rejected state, or null. */
export function rejectedState(store: Store): RejectedState | null {
  return store.getJson<RejectedState | null>(REJECTED_KEY, null);
}

/** Lifts the stop (设置 → 恢复调用). */
export function resumeCalls(store: Store): void {
  store.deleteMeta(REJECTED_KEY);
}

/**
 * Whether calls are stopped now. A stop lifts itself when the key changed or a new build deployed since (design §7).
 */
export async function callsStopped(store: Store, env: Pick<Env, 'ANTHROPIC_API_KEY' | 'BUILD_SHA'>): Promise<boolean> {
  const state = rejectedState(store);
  const key = anthropicKey(env);
  if (state === null || key === null) return false;
  if (state.build !== buildSha(env) || state.key !== (await keyPrefix(key))) {
    resumeCalls(store);
    return false;
  }
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

/** A fetch that reports every chunk of a response body (the stall watchdog's heartbeat, pings included). */
function watchedFetch(base: typeof fetch, onBytes: () => void): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    onBytes();
    if (response.body === null) return response;
    const beat = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onBytes();
        controller.enqueue(chunk);
      },
    });
    return new Response(response.body.pipeThrough(beat), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** The answer's text: every text block joined in order (a fallback's partial text and its continuation). */
export function answerText(message: Pick<BetaMessage, 'content'>): string {
  return message.content
    .filter((block): block is Extract<BetaMessage['content'][number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** The models whose text is in the answer: the declined ones before each fallback block, and the one that served. */
export function writersOf(message: Pick<BetaMessage, 'content' | 'model'>): string[] {
  const writers: string[] = [];
  let textSince = false;
  for (const block of message.content) {
    if (block.type === 'text' && block.text !== '') textSince = true;
    if (block.type === 'fallback') {
      if (textSince && !writers.includes(block.from.model)) writers.push(block.from.model);
      textSince = false;
    }
  }
  if (!writers.includes(message.model)) writers.push(message.model);
  return writers;
}

const TRANSIENT = new Set([408, 409, 429, 529]);

/** An API error with its default type arguments (instanceof alone would type them `any`). */
function isApiError(error: unknown): error is APIError {
  return error instanceof APIError;
}

function retryAfter(headers: Headers | undefined): number | null {
  const value = headers?.get('retry-after');
  if (value === null || value === undefined) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

/** One model call: the gates, the attempt row, the stream with its deadline, and the outcome's bookkeeping. */
export async function callModel(ctx: CallContext, request: ModelRequest): Promise<ModelOutcome> {
  if (ctx.mode === 'off') return { kind: 'blocked', reason: 'mode_off' };
  if (isPaused(ctx.store)) return { kind: 'blocked', reason: 'paused' };
  const key = anthropicKey(ctx.env);
  if (key === null) return { kind: 'blocked', reason: 'not_configured' };
  if (await callsStopped(ctx.store, ctx.env)) return { kind: 'blocked', reason: 'rejected' };
  const build = buildSha(ctx.env);
  const startedAt = ctx.now();
  const day = localDate(startedAt);
  const month = monthOf(day);
  const reserved = reservationOf(request.model, request.estimatedInputTokens, request.params.max_tokens);
  const callId = ctx.transact(() => {
    const { spent, reserved: inFlight } = monthSpend(ctx.store, month);
    if (spent + inFlight + reserved > ctx.budgetUsd) return null;
    const attempt = attemptsOf(ctx.store, request.issue, request.step) + 1;
    ctx.store.insert('calls', { issue: request.issue, step: request.step, attempt, build, model: request.model, state: 'open', reserved, day, month, started_ms: startedAt });
    return ctx.store.one<{ id: number }>(`SELECT last_insert_rowid() AS id`)?.id ?? 0;
  });
  if (callId === null) return { kind: 'blocked', reason: 'budget' };

  const deadline = Math.max(1000, Math.min(request.deadlineMs ?? MODEL_DEADLINE_MS, ctx.timeLeft() - MODEL_DEADLINE_MARGIN_MS));
  const controller = new AbortController();
  // Why our own signal aborted the stream (a holder: the timers set it after this function's checks were written).
  const abort: { why: 'deadline' | 'stall' | null } = { why: null };
  const deadlineTimer = setTimeout(() => {
    abort.why = 'deadline';
    controller.abort();
  }, deadline);
  const stall: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
  const beat = (): void => {
    if (stall.timer !== null) clearTimeout(stall.timer);
    stall.timer = setTimeout(() => {
      abort.why ??= 'stall';
      controller.abort();
    }, ctx.stallMs ?? STREAM_STALL_MS);
  };
  const opus = request.model.startsWith('claude-opus');
  const client = new Anthropic({ apiKey: key, fetch: watchedFetch(ctx.fetch, beat), maxRetries: 0, timeout: SDK_TIMEOUT_MS });
  const progress = { started: false };
  let message: BetaMessage;
  let requestId: string;
  try {
    const stream = client.beta.messages.stream(
      { ...request.params, model: request.model, ...(opus ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}) },
      { signal: controller.signal },
    );
    stream.on('streamEvent', (event: BetaRawMessageStreamEvent) => {
      if (event.type !== 'message_start') return;
      progress.started = true;
      const usage = event.message.usage;
      ctx.store.run(
        `UPDATE calls SET served = ?, input = ?, cache_write = ?, cache_read = ? WHERE id = ? AND state = 'open'`,
        event.message.model,
        usage.input_tokens,
        usage.cache_creation_input_tokens ?? 0,
        usage.cache_read_input_tokens ?? 0,
        callId,
      );
    });
    message = await stream.finalMessage();
    requestId = stream.request_id ?? '';
  } catch (error) {
    const now = ctx.now();
    const fail = (code: string): ModelOutcome => {
      ctx.store.run(`UPDATE calls SET state = 'failed', cost = reserved, error = ?, finished_ms = ? WHERE id = ?`, code, now, callId);
      return { kind: 'failed', callId, code };
    };
    const release = (code: string): void => {
      ctx.store.run(`UPDATE calls SET state = 'released', cost = 0, error = ?, finished_ms = ? WHERE id = ?`, code, now, callId);
    };
    if (abort.why !== null || error instanceof APIUserAbortError) return fail(abort.why ?? 'aborted');
    if (error instanceof APIConnectionTimeoutError) return fail('headers_timeout');
    if (error instanceof APIConnectionError) {
      release('connection');
      return { kind: 'transient', code: 'connection', retryAfterMs: null };
    }
    if (isApiError(error)) {
      const apiError = error;
      const status = apiError.status;
      if (status === undefined || progress.started) return fail(`stream_${apiError.type ?? 'error'}`);
      if (TRANSIENT.has(status) || status >= 500) {
        release(`http_${String(status)}`);
        // Request ID, status and error type only: never the message's text.
        console.log(JSON.stringify({ event: 'claude_transient', request_id: apiError.requestID ?? null, status, type: apiError.type ?? null }));
        return { kind: 'transient', code: `http_${String(status)}`, retryAfterMs: retryAfter(apiError.headers) };
      }
      const errorType = apiError.type ?? 'unknown';
      release(`http_${String(status)}`);
      const prefix = await keyPrefix(key);
      ctx.transact(() => {
        ctx.store.setJson(REJECTED_KEY, { status, type: errorType, key: prefix, build, ms: now } satisfies RejectedState);
        ctx.store.pushError('anthropic_rejected');
      });
      console.log(JSON.stringify({ event: 'claude_rejected', request_id: apiError.requestID ?? null, status, type: errorType }));
      return { kind: 'rejected', status, errorType };
    }
    return fail('unexpected');
  } finally {
    clearTimeout(deadlineTimer);
    if (stall.timer !== null) clearTimeout(stall.timer);
  }

  const { cost, tokens } = costOfUsage(message.usage, request.model, message.model);
  const text = answerText(message);
  const writers = writersOf(message);
  const stop = message.stop_reason ?? '';
  const category = message.stop_details?.category ?? null;
  const answer = stop === 'end_turn' ? readAnswer(callId, text, message.model, writers) : null;
  ctx.store.run(
    `UPDATE calls SET state = 'done', served = ?, cost = ?, input = ?, output = ?, cache_write = ?, cache_read = ?, request_id = ?, stop = ?, refusal = ?, writers = ?, answer = ?, finished_ms = ? WHERE id = ?`,
    message.model,
    cost,
    tokens.input,
    tokens.output,
    tokens.cacheWrite,
    tokens.cacheRead,
    requestId,
    stop,
    stop === 'refusal' ? (category ?? 'null') : '',
    JSON.stringify(writers),
    // Kept for the step to read after a crash only when it parses: an answer that does not is an attempt used, and is
    // never read again (unreadAnswer would hand the same bad text to every later try).
    answer?.kind === 'answer' ? text : '',
    ctx.now(),
    callId,
  );
  if (stop === 'refusal') return { kind: 'refusal', callId, category, served: message.model };
  if (stop === 'max_tokens') return { kind: 'invalid', callId, code: 'max_tokens' };
  return answer ?? { kind: 'invalid', callId, code: `stop_${stop || 'none'}` };
}

/** An answered call's JSON (a stored answer read again after a crash goes through here too). */
export function readAnswer(callId: number, text: string, served: string, writers: readonly string[]): ModelOutcome {
  try {
    return { kind: 'answer', callId, text, json: JSON.parse(text) as unknown, served, writers };
  } catch {
    return { kind: 'invalid', callId, code: 'not_json' };
  }
}

/** Marks an answered call's answer as read by its step (the text is kept for the archive's cost breakdown only). */
export function markRead(store: Store, callId: number): void {
  store.run(`UPDATE calls SET answer = '' WHERE id = ?`, callId);
}
