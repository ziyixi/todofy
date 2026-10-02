/**
 * The Todofy sink (../../docs/design.md §7, step W3; contracts/task-intent-v1): the outbox becomes Todoist tasks through
 * Todofy's "Ops" entrypoint (the TODOFY service binding), as task intents of source SOURCE_WATCH.
 *
 * - The digest: once a UTC day, at the first alarm from DIGEST_UTC_HOUR, every pending event (both policies) becomes
 *   one intent `digest-<day>` (subtasks mode): one item per watch.
 * - Urgent changes: a change confirmed on an URGENT watch becomes an intent `urgent-<change id>` (separate mode) in the
 *   same alarm, at most URGENT_INTENTS_PER_DAY a UTC day, so with the digest the app stays within the 10 intents a day
 *   Todofy records per source; one past them waits for the digest. BROKEN and auto-paused watches are only in the
 *   digest.
 *
 * What a task says (the owner decision of 2026-10-01): an item is only the owner's name for the watch, the trigger type
 * and a count, and links to the watch in this app (`https://<host>/watches/<id>`, the only host Todofy allows for this
 * source). Never the page's text, the watched URL or a summary: page content is untrusted (a page could address an
 * assistant that reads the owner's tasks), and the watched URL stays in the object.
 *
 * Delivery: `take` freezes the intent's wire JSON in the `intents` table in the transaction that marks its events
 * delivered (notify.ts), and `flush` proposes open intents with exactly those bytes until Todofy records them (an
 * intent_id with other content would be refused as a conflict): a lost answer, `unavailable` or a pause is retried
 * with the same bytes; a refusal for a reason that cannot pass (a URL off the list, a conflict) is final; after
 * INTENT_GIVE_UP_MS an intent is given up. Every outcome is a row's state and code, counted in ops-v1; logs carry
 * intent IDs, kinds, counts and codes only.
 */
import { TASK_INTENT_LIMITS, TASK_INTENT_VERSION } from '../../../contracts/task-intent-v1/task-intent-v1.ts';
import { create } from '@ziyixi/proto/protobuf';
import {
  ErrorCode,
  ErrorCodeSchema,
  Mode,
  Source,
  State,
  StateSchema,
  TaskIntentItemSchema,
  TaskIntentResultSchema,
  TaskIntentSchema,
  type TaskIntent,
  type TaskIntentItem,
  type TaskIntentResult,
  type TaskIntentService,
} from '@ziyixi/proto/todofy/taskintent/v1/task_intent_pb';
import { fromWire, toWire, wireEnum, WireJsonError, type WireObject, type WireService } from '@ziyixi/proto/wire-json';
import type { TriggerKind } from './config.ts';
import { utcDay } from './etiquette.ts';
import {
  AUTO_PAUSE_AFTER_MS,
  DAY,
  DIGEST_UTC_HOUR,
  HOUR,
  INTENT_GIVE_UP_MS,
  INTENT_RETRY_BASE_MS,
  INTENT_RETRY_MAX_MS,
  INTENT_SENDS_PER_ALARM,
  SECOND,
  URGENT_INTENTS_PER_DAY,
} from './limits.ts';
import { urgentWaiting, type NotificationSink, type SinkWants, type WatchEvent } from './notify.ts';
import type { Store } from './store.ts';

/** Todofy's named entrypoint "Ops" as this app sees it: the generated TaskIntentService (wire JSON in and out). */
export interface TodofyIntentEntrypoint extends Rpc.WorkerEntrypointBranded, WireService<typeof TaskIntentService> {}

/** What the sink calls: proposeTasks only (it never polls; a recorded intent is Todofy's). */
export type TodofyIntents = Pick<WireService<typeof TaskIntentService>, 'proposeTasks'>;

const STATES = wireEnum(StateSchema, State);
const ERROR_CODES = wireEnum(ErrorCodeSchema, ErrorCode);

// ---- the text of a task ---------------------------------------------------------------------------------------------

/** The trigger types as the UI names them (web/src/format.ts TRIGGERS), in the order of watch.ui.v1's enum. */
export const TRIGGER_LABELS: Readonly<Record<TriggerKind, string>> = {
  any_change: '任何变化',
  text_appears: '出现文字',
  text_disappears: '文字消失',
  new_item: '新条目',
  number: '数值',
  availability: '供货状态',
};
const KIND_ORDER = Object.keys(TRIGGER_LABELS);

/** One watch in an intent: the owner's name for it and what happened, counted. */
export interface WatchLine {
  readonly watchId: string;
  /** The owner's display name (owner input, not page text). */
  readonly name: string;
  /** Confirmed changes by the trigger type that fired. */
  readonly changes: ReadonlyMap<TriggerKind, number>;
  readonly broken: boolean;
  readonly paused: boolean;
}

/**
 * A title's text: control characters, the line and paragraph separators and runs of white space become one space
 * (task-intent-v1 titles are one line), at most `max` code points.
 */
export function oneLine(text: string, max: number): string {
  // Only U+0000-U+001F, U+007F, U+2028, U+2029 and white space are replaced: a linear scan, whatever the input.
  // A lone surrogate becomes U+FFFD first (Todofy refuses text that is not well formed).
  // eslint-disable-next-line no-control-regex
  const flat = text.toWellFormed().replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/gu, ' ').trim();
  // Code points, as Todofy and the schema count a title's length (an emoji sequence may be cut between its points).
  const points = Array.from(flat);
  return points.length <= max ? flat : `${points.slice(0, max - 1).join('').trimEnd()}…`;
}

function changeCount(line: WatchLine): number {
  let total = 0;
  for (const n of line.changes.values()) total += n;
  return total;
}

/** `<name> · 数值 2 次变化 · 检查失效`: the owner's name, each trigger type with its count, and the watch's trouble. */
export function lineTitle(line: WatchLine): string {
  const kinds = [...line.changes].filter(([, n]) => n > 0).sort(([a, n], [b, m]) => m - n || KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
  const parts = kinds.map(([kind, n]) => `${TRIGGER_LABELS[kind]} ${String(n)} 次变化`);
  if (line.broken) parts.push('检查失效');
  if (line.paused) parts.push(`已自动暂停（失效 ${String(Math.round(AUTO_PAUSE_AFTER_MS / DAY))} 天）`);
  const name = oneLine(line.name, 120) || `监视 ${line.watchId}`;
  return oneLine([name, ...parts].join(' · '), TASK_INTENT_LIMITS.itemTitleMax);
}

/** Most changes first, then by watch ID: the same lines always give the same intent. */
export function orderLines(lines: readonly WatchLine[]): WatchLine[] {
  return [...lines].sort((a, b) => changeCount(b) - changeCount(a) || (a.watchId < b.watchId ? -1 : a.watchId > b.watchId ? 1 : 0));
}

function item(line: WatchLine, host: string): TaskIntentItem {
  return create(TaskIntentItemSchema, { title: lineTitle(line), url: `https://${host}/watches/${line.watchId}` });
}

/** The digest of `day` (subtasks: the parent and one task per watch; past 30 watches the last item names the rest). */
export function digestIntent(day: string, lines: readonly WatchLine[], host: string): TaskIntent {
  const ordered = orderLines(lines);
  const max = TASK_INTENT_LIMITS.itemsMax;
  const items =
    ordered.length <= max
      ? ordered.map((line) => item(line, host))
      : [
          ...ordered.slice(0, max - 1).map((line) => item(line, host)),
          create(TaskIntentItemSchema, { title: `另有 ${String(ordered.length - max + 1)} 个监视有变化或问题`, url: `https://${host}/` }),
        ];
  return create(TaskIntentSchema, {
    version: TASK_INTENT_VERSION,
    source: Source.WATCH,
    intentId: `digest-${day}`,
    mode: Mode.SUBTASKS,
    parent: {
      title: `网页监视 ${day} · ${String(ordered.length)} 个监视`,
      description: `只有名称、类型和次数；变化的内容请在网页监视中查看。\nhttps://${host}/`,
    },
    items,
  });
}

/** Urgent changes (separate mode: one top-level task per watch, at most 30), under the first change's ID. */
export function urgentIntent(firstChangeId: string, lines: readonly WatchLine[], host: string): TaskIntent {
  return create(TaskIntentSchema, {
    version: TASK_INTENT_VERSION,
    source: Source.WATCH,
    intentId: `urgent-${firstChangeId}`,
    mode: Mode.SEPARATE,
    parent: { title: '网页监视 · 紧急变化' },
    items: orderLines(lines)
      .slice(0, TASK_INTENT_LIMITS.itemsMax)
      .map((line) => item(line, host)),
  });
}

/** The intent's wire JSON, compact: the bytes frozen in `intents` and hashed by Todofy; null past the size bound. */
export function freezeIntent(intent: TaskIntent): string | null {
  const json = JSON.stringify(toWire(TaskIntentSchema, intent));
  return new TextEncoder().encode(json).byteLength <= TASK_INTENT_LIMITS.intentMaxBytes ? json : null;
}

/**
 * Todofy's answer for `intentId` when it reads as a TaskIntentResult of this source with a state this build knows, else
 * null (unreadable: tried again later). Read leniently (it is an output); an unknown error code reads as none.
 */
export function asResult(value: unknown, intentId: string): TaskIntentResult | null {
  let result: TaskIntentResult;
  try {
    result = fromWire(TaskIntentResultSchema, value).message;
  } catch (error) {
    if (error instanceof WireJsonError) return null;
    throw error;
  }
  const retry = result.retryAfterSeconds;
  const valid =
    result.version === TASK_INTENT_VERSION &&
    result.source === Source.WATCH &&
    result.intentId === intentId &&
    STATES.name(result.state) !== null &&
    (retry === undefined || (retry >= 1 && retry <= TASK_INTENT_LIMITS.retryAfterMaxSeconds));
  return valid ? result : null;
}

/** What one answer means for the intent: Todofy holds it, it is final otherwise, or it is tried again. */
export type Outcome =
  | { readonly kind: 'recorded'; readonly code: string }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'retry'; readonly code: string; readonly afterMs: number };

/** The retry after `attempts` failed proposals: INTENT_RETRY_BASE_MS doubling up to INTENT_RETRY_MAX_MS. */
export function backoffMs(attempts: number): number {
  return Math.min(INTENT_RETRY_MAX_MS, INTENT_RETRY_BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 10));
}

/** The outcome of a readable answer to the `attempts`-th proposal. */
export function outcomeOf(result: TaskIntentResult, attempts: number, now: number): Outcome {
  const code = ERROR_CODES.name(result.errorCode) ?? STATES.name(result.state) ?? 'unknown';
  const hinted = result.retryAfterSeconds === undefined ? null : result.retryAfterSeconds * SECOND;
  if (result.recorded) {
    // pending, created, duplicate, failed or paused: Todofy holds the intent and will (or did) create the tasks. A
    // recorded rejection is a conflict: another content holds this ID, which this sink never sends.
    return result.state === State.REJECTED ? { kind: 'refused', code } : { kind: 'recorded', code: STATES.name(result.state) ?? 'recorded' };
  }
  switch (result.errorCode) {
    case ErrorCode.URL_NOT_ALLOWED:
    case ErrorCode.INTENT_CONFLICT:
      return { kind: 'refused', code };
    case ErrorCode.DAILY_LIMIT: {
      // The next UTC day by Todofy's clock (its hint), else by this one.
      const tomorrow = (Math.floor(now / DAY) + 1) * DAY - now;
      return { kind: 'retry', code, afterMs: Math.max(hinted ?? tomorrow, INTENT_RETRY_BASE_MS) };
    }
    case ErrorCode.SOURCE_NOT_ALLOWED:
      // Todofy's intake is off for this source (TASK_INTENT_SOURCES): ask again a few times a day.
      return { kind: 'retry', code, afterMs: INTENT_RETRY_MAX_MS };
    default:
      // A pause (maintenance, processing paused, Todoist paused or blocked, a backup) recorded nothing.
      return { kind: 'retry', code, afterMs: Math.max(hinted ?? backoffMs(attempts), INTENT_RETRY_BASE_MS) };
  }
}

// ---- the sink -------------------------------------------------------------------------------------------------------

interface ChangeKindRow {
  id: string;
  trigger_kind: string;
  [column: string]: SqlStorageValue;
}

interface OpenIntentRow {
  intent_id: string;
  kind: 'digest' | 'urgent';
  payload: string;
  events: number;
  attempts: number;
  [column: string]: SqlStorageValue;
}

function isTriggerKind(value: string): value is TriggerKind {
  return Object.hasOwn(TRIGGER_LABELS, value);
}

/** The start of `day`'s digest hour (UTC). */
function digestTime(now: number): number {
  return Math.floor(now / DAY) * DAY + DIGEST_UTC_HOUR * HOUR;
}

export class TodofySink implements NotificationSink {
  private readonly store: Store;
  private readonly todofy: TodofyIntents;
  private readonly host: string;

  constructor(store: Store, todofy: TodofyIntents, host: string) {
    this.store = store;
    this.todofy = todofy;
    this.host = host;
  }

  /** Urgent intents frozen on `day` (UTC). */
  private urgentOn(day: string): number {
    return this.store.one<{ n: number }>(`SELECT count(*) AS n FROM intents WHERE day = ? AND kind = 'urgent'`, day)?.n ?? 0;
  }

  private digestDone(day: string): boolean {
    return this.store.getMeta('digest_day') === day;
  }

  wants(now: number): SinkWants {
    const day = utcDay(now);
    if (now >= digestTime(now) && !this.digestDone(day)) return { urgent: false, digest: true };
    return { urgent: urgentWaiting(this.store) && this.urgentOn(day) < URGENT_INTENTS_PER_DAY, digest: false };
  }

  /** The watches of `events` as lines (a deleted watch's events are taken and dropped: they were deleted with it). */
  private lines(events: readonly WatchEvent[]): { lines: WatchLine[]; taken: number[] } {
    const byWatch = new Map<string, { changes: Map<TriggerKind, number>; broken: boolean; paused: boolean }>();
    const taken: number[] = [];
    for (const event of events) {
      taken.push(event.id);
      const line = byWatch.get(event.watchId) ?? { changes: new Map<TriggerKind, number>(), broken: false, paused: false };
      byWatch.set(event.watchId, line);
      if (event.kind === 'watch_broken') line.broken = true;
      else if (event.kind === 'watch_paused') line.paused = true;
      else {
        const kind = event.changeId === null ? undefined : this.store.one<ChangeKindRow>(`SELECT id, trigger_kind FROM changes WHERE id = ?`, event.changeId)?.trigger_kind;
        const known: TriggerKind = kind !== undefined && isTriggerKind(kind) ? kind : 'any_change';
        line.changes.set(known, (line.changes.get(known) ?? 0) + 1);
      }
    }
    const lines: WatchLine[] = [];
    for (const [watchId, line] of byWatch) {
      const row = this.store.one<{ settings: string }>(`SELECT settings FROM watches WHERE id = ?`, watchId);
      if (row === undefined) continue;
      const name = (JSON.parse(row.settings) as { display_name?: unknown }).display_name;
      lines.push({ watchId, name: typeof name === 'string' ? name : '', ...line });
    }
    return { lines, taken };
  }

  private freeze(intent: TaskIntent, kind: 'digest' | 'urgent', day: string, events: number, now: number): void {
    const payload = freezeIntent(intent);
    if (payload === null) {
      console.log(JSON.stringify({ event: 'intent_too_large', kind, intent: intent.intentId, events }));
      return;
    }
    this.store.run(
      `INSERT OR IGNORE INTO intents (intent_id, kind, day, payload, events, state, attempts, next_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', 0, ?, ?, ?)`,
      intent.intentId,
      kind,
      day,
      payload,
      events,
      now,
      now,
      now,
    );
  }

  take(events: readonly WatchEvent[], wants: SinkWants, now: number): readonly number[] {
    const day = utcDay(now);
    if (wants.digest) {
      const { lines, taken } = this.lines(events);
      if (lines.length > 0) this.freeze(digestIntent(day, lines, this.host), 'digest', day, taken.length, now);
      this.store.setMeta('digest_day', day);
      return taken;
    }
    // Urgent: confirmed changes only (a broken or paused watch is never urgent), as many watches as one intent holds.
    const urgent: WatchEvent[] = [];
    const watches = new Set<string>();
    for (const event of events) {
      if (event.policy !== 'urgent' || event.kind !== 'change_confirmed' || event.changeId === null) continue;
      if (!watches.has(event.watchId) && watches.size >= TASK_INTENT_LIMITS.itemsMax) continue;
      watches.add(event.watchId);
      urgent.push(event);
    }
    const { lines, taken } = this.lines(urgent);
    const first = urgent.map((event) => event.changeId ?? '').sort()[0];
    if (lines.length > 0 && first !== undefined) this.freeze(urgentIntent(first, lines, this.host), 'urgent', day, taken.length, now);
    return taken;
  }

  async flush(now: number): Promise<void> {
    this.store.run(
      `UPDATE intents SET state = 'expired', payload = '', last_code = 'gave_up', updated_at = ? WHERE state = 'open' AND created_at <= ?`,
      now,
      now - INTENT_GIVE_UP_MS,
    );
    const due = this.store.all<OpenIntentRow>(
      `SELECT intent_id, kind, payload, events, attempts FROM intents WHERE state = 'open' AND next_at <= ? ORDER BY next_at, intent_id LIMIT ?`,
      now,
      INTENT_SENDS_PER_ALARM,
    );
    for (const row of due) await this.send(row, now);
  }

  private async send(row: OpenIntentRow, now: number): Promise<void> {
    const attempts = row.attempts + 1;
    let outcome: Outcome;
    try {
      const answer = await this.todofy.proposeTasks(JSON.parse(row.payload) as WireObject);
      const result = asResult(answer, row.intent_id);
      outcome = result === null ? { kind: 'retry', code: 'unreadable', afterMs: backoffMs(attempts) } : outcomeOf(result, attempts, now);
    } catch (error) {
      // `new Error(code)` crosses RPC intact. invalid_input from a Todofy that does not know this source yet (or a bug
      // here): ask again a few times a day until given up. Anything else (unavailable, busy, a deploy) is retried.
      const code = error instanceof Error && error.message === 'invalid_input' ? 'invalid_input' : 'unavailable';
      outcome = { kind: 'retry', code, afterMs: code === 'invalid_input' ? INTENT_RETRY_MAX_MS : backoffMs(attempts) };
    }
    if (outcome.kind === 'retry') {
      this.store.run(
        `UPDATE intents SET attempts = ?, next_at = ?, last_code = ?, updated_at = ? WHERE intent_id = ? AND state = 'open'`,
        attempts,
        now + outcome.afterMs,
        outcome.code,
        now,
        row.intent_id,
      );
    } else {
      // Todofy holds the text now (or will never take it): the owner's names leave this table.
      this.store.run(
        `UPDATE intents SET state = ?, payload = '', attempts = ?, last_code = ?, updated_at = ? WHERE intent_id = ? AND state = 'open'`,
        outcome.kind,
        attempts,
        outcome.code,
        now,
        row.intent_id,
      );
    }
    // IDs, kinds, counts and codes only.
    console.log(JSON.stringify({ event: 'intent', intent: row.intent_id, kind: row.kind, events: row.events, attempts, outcome: outcome.kind, code: outcome.code }));
  }

  nextAt(now: number): number | null {
    const retry = this.store.one<{ at: number | null }>(`SELECT min(next_at) AS at FROM intents WHERE state = 'open'`)?.at ?? null;
    const digest = this.digestDone(utcDay(now)) ? digestTime(now) + DAY : Math.max(digestTime(now), now);
    return retry === null ? digest : Math.min(retry, digest);
  }
}
