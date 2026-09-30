/**
 * Sending liked papers to Todofy (docs/design.md §9, contracts/task-intent-v1): building the frozen
 * TaskIntent of one deck generation, checking it and Todofy's answers against the contract schema, and
 * the pure state machine of a send row. LabState owns the storage and the RPC.
 */
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import schema from '../../../contracts/task-intent-v1/task-intent-v1.schema.json';
import {
  TASK_INTENT_LIMITS,
  TASK_INTENT_VERSION,
  type TaskIntent,
  type TaskIntentItem,
  type TaskIntentMode,
  type TaskIntentResult,
} from '../../../contracts/task-intent-v1/task-intent-v1.ts';
import type { SendState, SendStatus } from './api-types.ts';
import { absUrl, bareId, clip, oneLine } from './arxiv.ts';
import { firstSentence } from './brief.ts';
import { iso } from './config.ts';

const SCHEMA = schema as { $defs: Record<string, unknown> };

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
export function buildIntent(deckId: string, generation: number, mode: TaskIntentMode, cards: readonly SendCard[], host: string | null): TaskIntent | null {
  const items: TaskIntentItem[] = [];
  for (const card of [...cards].sort((a, b) => a.position - b.position).slice(0, TASK_INTENT_LIMITS.itemsMax)) {
    const id = bareId(card.paper_id);
    if (id === null) return null;
    const title = clip(oneLine(card.title), TASK_INTENT_LIMITS.itemTitleMax) || id;
    const brief = card.brief === null ? '' : firstSentence(oneLine(card.brief), 120);
    items.push(brief === '' ? { title, url: absUrl(id) } : { title, url: absUrl(id), description: brief });
  }
  if (items.length === 0) return null;
  const description = host === null ? '来自 Lab 论文雷达' : `来自 Lab 论文雷达\nhttps://${host}/deck/${deckId}`;
  return {
    version: TASK_INTENT_VERSION,
    source: 'lab',
    intent_id: intentId(deckId, generation),
    mode,
    parent: { title: parentTitle(deckId, generation, items.length), description },
    items,
  };
}

/** Schema errors of a value of `$defs[name]` (empty when valid). */
export function contractErrors(name: 'TaskIntent' | 'TaskIntentRef' | 'TaskIntentResult', value: unknown): string[] {
  return validate(SCHEMA, name, value);
}

/** The intent as compact JSON when it passes the schema and the size bound, else null. */
export function freeze(intent: TaskIntent): string | null {
  if (contractErrors('TaskIntent', intent).length > 0) return null;
  const json = JSON.stringify(intent);
  return new TextEncoder().encode(json).byteLength <= TASK_INTENT_LIMITS.intentMaxBytes ? json : null;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Todofy's answer when it is a valid TaskIntentResult for this intent, else null (treated as unknown). */
export function asResult(value: unknown, intent: string): TaskIntentResult | null {
  if (contractErrors('TaskIntentResult', value).length > 0) return null;
  const result = value as TaskIntentResult;
  return result.intent_id === intent ? result : null;
}

// ---- the send row -------------------------------------------------------------------------------------

export type LabErrorCode = SendStatus['error_code'];

export interface SendRow {
  readonly deck_id: string;
  readonly generation: number;
  readonly intent_id: string;
  readonly mode: TaskIntentMode;
  readonly paper_ids: readonly string[];
  readonly payload: string | null;
  readonly payload_sha256: string;
  readonly state: SendState;
  readonly recorded: boolean;
  readonly tasks_total: number;
  readonly tasks_created: number;
  readonly error_code: LabErrorCode;
  readonly next_poll_at: number | null;
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

/** The row after a valid TaskIntentResult (from proposeTasks or taskIntentStatus). */
export function withResult(row: SendRow, result: TaskIntentResult, now: number): SendRow {
  const state: SendState = result.state === 'not_found' ? 'unknown' : result.state;
  const recorded = result.state === 'not_found' ? false : result.recorded;
  return {
    ...row,
    state,
    recorded,
    tasks_total: result.tasks_total,
    tasks_created: result.tasks_created,
    error_code: result.error_code,
    next_poll_at: nextPoll(now, row.created_at, result.retry_after_seconds, state, recorded),
    updated_at: now,
  };
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
