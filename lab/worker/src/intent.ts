/**
 * Sending liked papers to Todofy (docs/design.md §9, contracts/task-intent-v1): building the frozen
 * TaskIntent of one deck generation, reading Todofy's answers, and the pure state machine of a send row.
 * LabState owns the storage and the RPC.
 *
 * The messages are the types generated from proto/todofy/taskintent/v1/task_intent.proto, written and read
 * with the wire JSON profile (proto/README.md). An intent is written with toWire: those are the bytes Lab
 * freezes and Todofy hashes. Before it is frozen it must also pass the contract's JSON Schema, whose value
 * rules (lengths, patterns, distinct items) the IDL cannot express. A result is an output, read leniently:
 * a state or error code from a newer Todofy reads as *_UNSPECIFIED and takes the default branch below (an
 * unknown state is an unreadable answer, an unknown error code no reason), and Lab applies the value rules
 * its control flow depends on (its own intent, counts, the retry hint).
 */
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import schema from '../../../contracts/task-intent-v1/task-intent-v1.schema.json';
import { TASK_INTENT_LIMITS, TASK_INTENT_VERSION } from '../../../contracts/task-intent-v1/task-intent-v1.ts';
import { create } from '@ziyixi/proto/protobuf';
import {
  ErrorCode,
  ErrorCodeSchema,
  Mode,
  ModeSchema,
  Source,
  State,
  TaskIntentItemSchema,
  TaskIntentRefSchema,
  TaskIntentResultSchema,
  TaskIntentSchema,
  type TaskIntent,
  type TaskIntentItem,
  type TaskIntentResult,
} from '@ziyixi/proto/todofy/taskintent/v1/task_intent_pb';
import { fromWire, toWire, wireEnum, WireJsonError, type WireObject } from '@ziyixi/proto/wire-json';
import type { SendMode, SendState, SendStatus } from './api-types.ts';
import { absUrl, bareId, clip, oneLine } from './arxiv.ts';
import { firstSentence } from './brief.ts';
import { iso } from './config.ts';

const SCHEMA = schema as { $defs: Record<string, unknown> };
/** The send modes (Mode) and Todofy's error codes by wire name, as D1 and the owner API carry them. */
export const SEND_MODES = wireEnum(ModeSchema, Mode);
const ERROR_CODES = wireEnum(ErrorCodeSchema, ErrorCode);

export function isSendMode(value: unknown): value is SendMode {
  return typeof value === 'string' && SEND_MODES.value(value) !== undefined;
}

export interface SendCard {
  readonly position: number;
  readonly paper_id: string;
  readonly title: string;
  readonly brief: string | null;
}

export function intentId(deckId: string, generation: number): string {
  return `deck-${deckId}-g${String(generation)}`;
}

export function parentTitle(deckId: string, generation: number, count: number): string {
  return generation === 1 ? `论文雷达 ${deckId} · ${String(count)} 篇` : `论文雷达 ${deckId}（补发）· ${String(count)} 篇`;
}

/** The TaskIntent for `cards` (deck order), or null when a card has no valid arXiv ID. */
export function buildIntent(deckId: string, generation: number, mode: SendMode, cards: readonly SendCard[], host: string | null): TaskIntent | null {
  const items: TaskIntentItem[] = [];
  for (const card of [...cards].sort((a, b) => a.position - b.position).slice(0, TASK_INTENT_LIMITS.itemsMax)) {
    const id = bareId(card.paper_id);
    if (id === null) return null;
    const title = clip(oneLine(card.title), TASK_INTENT_LIMITS.itemTitleMax) || id;
    const brief = card.brief === null ? '' : firstSentence(oneLine(card.brief), 120);
    items.push(create(TaskIntentItemSchema, brief === '' ? { title, url: absUrl(id) } : { title, url: absUrl(id), description: brief }));
  }
  const modeValue = SEND_MODES.value(mode);
  if (items.length === 0 || modeValue === undefined) return null;
  const description = host === null ? '来自 Lab 论文雷达' : `来自 Lab 论文雷达\nhttps://${host}/deck/${deckId}`;
  return create(TaskIntentSchema, {
    version: TASK_INTENT_VERSION,
    source: Source.LAB,
    intentId: intentId(deckId, generation),
    mode: modeValue,
    parent: { title: parentTitle(deckId, generation, items.length), description },
    items,
  });
}

/** Schema errors of a wire value of `$defs[name]` (empty when valid). */
export function contractErrors(name: 'TaskIntent' | 'TaskIntentRef' | 'TaskIntentResult', value: unknown): string[] {
  return validate(SCHEMA, name, value);
}

/** The intent's wire JSON, compact, when it passes the schema and the size bound, else null. */
export function freeze(intent: TaskIntent): string | null {
  const wire = toWire(TaskIntentSchema, intent);
  if (contractErrors('TaskIntent', wire).length > 0) return null;
  const json = JSON.stringify(wire);
  return new TextEncoder().encode(json).byteLength <= TASK_INTENT_LIMITS.intentMaxBytes ? json : null;
}

/** The TaskIntentRef that asks Todofy about `intent`, in wire JSON. */
export function statusRef(intent: string): WireObject {
  return toWire(TaskIntentRefSchema, create(TaskIntentRefSchema, { version: TASK_INTENT_VERSION, source: Source.LAB, intentId: intent }));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lab's state for a known TaskIntentResult state; null for one this build does not know (the default branch). */
function sendState(state: State): SendState | null {
  switch (state) {
    case State.PENDING:
      return 'pending';
    case State.CREATED:
      return 'created';
    case State.DUPLICATE:
      return 'duplicate';
    case State.PAUSED:
      return 'paused';
    case State.FAILED:
      return 'failed';
    case State.REJECTED:
      return 'rejected';
    case State.NOT_FOUND:
      // Todofy never recorded it: Lab does not know whether it was sent.
      return 'unknown';
    default:
      return null;
  }
}

function within(value: number, low: number, high: number): boolean {
  return value >= low && value <= high;
}

/**
 * Todofy's answer when it reads as a TaskIntentResult for this intent with a state Lab knows, else null
 * (treated as unknown: Lab asks again later). Read leniently; an unknown error code reads as none.
 */
export function asResult(value: unknown, intent: string): TaskIntentResult | null {
  let result: TaskIntentResult;
  try {
    result = fromWire(TaskIntentResultSchema, value).message;
  } catch (error) {
    if (error instanceof WireJsonError) return null;
    throw error;
  }
  const { tasksMax, retryAfterMaxSeconds } = TASK_INTENT_LIMITS;
  const retry = result.retryAfterSeconds;
  const valid =
    result.version === TASK_INTENT_VERSION &&
    result.source === Source.LAB &&
    result.intentId === intent &&
    sendState(result.state) !== null &&
    within(result.tasksTotal, 0, tasksMax) &&
    within(result.tasksCreated, 0, tasksMax) &&
    (retry === undefined || within(retry, 1, retryAfterMaxSeconds)) &&
    // Todofy always stamps a result; a lenient read takes null for "unset".
    result.updatedAt !== undefined;
  return valid ? result : null;
}

// ---- the send row -------------------------------------------------------------------------------------

export type LabErrorCode = SendStatus['error_code'];

export interface SendRow {
  readonly deck_id: string;
  readonly generation: number;
  readonly intent_id: string;
  readonly mode: SendMode;
  readonly paper_ids: readonly string[];
  readonly payload: string | null;
  readonly payload_sha256: string;
  readonly state: SendState;
  readonly recorded: boolean;
  readonly tasks_total: number;
  readonly tasks_created: number;
  readonly error_code: LabErrorCode;
  readonly next_poll_at: number | null;
  /** Start of the current attempt (the first send, a retry or a re-propose): the fast poll window counts from it. */
  readonly created_at: number;
  readonly updated_at: number;
}

/** Todofy holds nothing for this generation: the next send may rebuild it (same intent_id, new content). */
export function unfrozen(row: Pick<SendRow, 'state' | 'recorded'>): boolean {
  return !row.recorded && (row.state === 'paused' || row.state === 'rejected');
}

/** Done: no poll, and a new send starts the next generation. */
export function completed(row: Pick<SendRow, 'state'>): boolean {
  return row.state === 'created' || row.state === 'duplicate';
}

/** States refreshed by GET …/send when their poll time has come. */
export function pollable(row: Pick<SendRow, 'state' | 'recorded'>): boolean {
  return row.state === 'pending' || row.state === 'unknown' || row.state === 'sending' || (row.state === 'paused' && row.recorded);
}

export const POLL_MIN_MS = TASK_INTENT_LIMITS.statusMinIntervalSeconds * 1000;
export const POLL_SLOW_MS = 60_000;
/** After this long without settling, polls slow down to once a minute. */
export const POLL_FAST_WINDOW_MS = 120_000;

export function nextPoll(now: number, createdAt: number, retryAfterSeconds: number | null, state: SendState, recorded: boolean): number | null {
  if (!pollable({ state, recorded })) return null;
  const hinted = Math.max(POLL_MIN_MS, (retryAfterSeconds ?? 0) * 1000);
  const slow = state === 'paused' || now - createdAt > POLL_FAST_WINDOW_MS;
  return now + (slow ? Math.max(hinted, POLL_SLOW_MS) : hinted);
}

/** The row after a TaskIntentResult that `asResult` accepted (from proposeTasks or taskIntentStatus). */
export function withResult(row: SendRow, result: TaskIntentResult, now: number): SendRow {
  const state = sendState(result.state) ?? 'unknown';
  const recorded = result.state === State.NOT_FOUND ? false : result.recorded;
  return {
    ...row,
    state,
    recorded,
    tasks_total: result.tasksTotal,
    tasks_created: result.tasksCreated,
    // A code this build does not know reads as ERROR_CODE_UNSPECIFIED: no reason, never a guessed one.
    error_code: ERROR_CODES.name(result.errorCode),
    next_poll_at: nextPoll(now, row.created_at, result.retryAfterSeconds ?? null, state, recorded),
    updated_at: now,
  };
}

/**
 * A retry of a `failed` generation answered `paused` (recorded): Todofy holds a pause and re-queued nothing, so
 * after the pause the intent is still failed. Keep it failed with the pause as its reason (no poll).
 */
export function heldRetry(row: SendRow): SendRow {
  if (row.state !== 'paused' || !row.recorded) return row;
  return { ...row, state: 'failed', next_poll_at: null };
}

/** The row after the RPC itself rejected (or answered something that is not a valid result). */
export function withRejection(row: SendRow, code: string, now: number): SendRow {
  if (code === 'invalid_input') {
    // A Lab bug: Todofy refused the input and recorded nothing. Never resent unchanged (unfrozen).
    return { ...row, state: 'rejected', recorded: false, error_code: 'invalid_input', next_poll_at: null, updated_at: now };
  }
  const error: LabErrorCode = code === 'busy' ? 'busy' : 'unavailable';
  // Unknown whether Todofy recorded it: keep the content frozen, ask taskIntentStatus next.
  return { ...row, state: 'unknown', recorded: row.recorded, error_code: error, next_poll_at: nextPoll(now, row.created_at, null, 'unknown', row.recorded), updated_at: now };
}

export function sendStatus(row: SendRow): SendStatus {
  return {
    generation: row.generation,
    intent_id: row.intent_id,
    mode: row.mode,
    state: row.state,
    recorded: row.recorded,
    items: row.paper_ids.length,
    tasks_total: row.tasks_total,
    tasks_created: row.tasks_created,
    error_code: row.error_code,
    frozen: !unfrozen(row),
    poll_after: row.next_poll_at === null ? null : iso(row.next_poll_at),
    updated_at: iso(row.updated_at),
  };
}
