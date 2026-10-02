/**
 * The Todofy sink (../../docs/design.md §7, step W3; contracts/task-intent-v1): the outbox becomes Todoist tasks through
 * Todofy's "Intents" entrypoint (the TODOFY service binding, `props.source = "watch"`: proposeTasks and
 * taskIntentStatus of this source only), as task intents of source SOURCE_WATCH.
 *
 * - The digest: once a UTC day, at the first alarm from DIGEST_UTC_HOUR, every pending event (both policies) becomes
 *   one intent `digest-<day>` (subtasks mode): one item per watch.
 * - Urgent changes: a change confirmed on an URGENT watch becomes an intent `urgent-<change id>` (separate mode) in the
 *   same alarm, while Todofy's 10 intents a day per source leave room for it and for the day's digest: the intents still
 *   open (of any day) plus those Todofy recorded this UTC day plus one for a digest not yet frozen stay below
 *   INTENTS_PER_DAY (Todofy counts by the day it records, so a carried-over intent takes a slot of the day it lands in).
 *   One past them waits for the digest. BROKEN and auto-paused watches are only in the digest.
 *
 * What a task says (the owner decision of 2026-10-01): an item is only the owner's name for the watch, the trigger type
 * and a count, and links to the watch in this app (`https://<host>/watches/<id>`, the only host Todofy allows for this
 * source). Never the page's text, the watched URL or a summary: page content is untrusted (a page could address an
 * assistant that reads the owner's tasks), and the watched URL stays in the object.
 *
 * Delivery: `take` freezes the intent's wire JSON in the `intents` table in the transaction that marks its events
 * delivered (notify.ts), and `flush` works on what is due, the digest first, at most INTENT_SENDS_PER_ALARM calls:
 * - open (not recorded): proposed with exactly those bytes (an intent_id with other content would be refused as a
 *   conflict); a lost answer, `unavailable`, a pause or the day's limit is retried with the same bytes; a refusal that
 *   cannot pass (a URL off the list, a conflict) is final;
 * - held (Todofy recorded it, `pending` or `paused`): the bytes are kept and taskIntentStatus is polled every
 *   INTENT_POLL_MS (contracts/task-intent-v1 "States"); `created` or `duplicate` ends it; `failed` (Todoist refused a
 *   task, or Todofy's own attempts ran out) is proposed again with the same bytes, which re-queues only the unfinished
 *   tasks, backing off; `not_found` makes it open again.
 * After INTENT_GIVE_UP_MS an intent whose tasks do not all exist is given up. Every outcome is a row's state and code,
 * counted in ops-v1 (a failed or long-held intent raises `notify_unsettled`); logs carry intent IDs, kinds, counts and
 * codes only.
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
  TaskIntentRefSchema,
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
  INTENT_POLL_MS,
  INTENT_RETRY_BASE_MS,
  INTENT_RETRY_MAX_MS,
  INTENT_SENDS_PER_ALARM,
  INTENTS_PER_DAY,
  SECOND,
} from './limits.ts';
import { eventsByIds, urgentWaiting, type NotificationSink, type SinkWants, type WatchEvent } from './notify.ts';
import type { Store } from './store.ts';

/** Todofy's named entrypoint "Intents" as this app sees it: the generated TaskIntentService (wire JSON in and out). */
export interface TodofyIntentEntrypoint extends Rpc.WorkerEntrypointBranded, WireService<typeof TaskIntentService> {}

/** What the sink calls: proposeTasks, and taskIntentStatus for an intent Todofy holds. */
export type TodofyIntents = Pick<WireService<typeof TaskIntentService>, 'proposeTasks' | 'taskIntentStatus'>;

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

/**
 * The owner's name for a watch as a task may carry it: '' (so the title says `监视 <id>`) when the name holds the watched
 * URL, its origin, its host or a parent domain of it (`shop.example.com`, `example.com`; a public suffix like `co.uk`
 * too, which only costs the name), compared case-insensitively on the one-line form. A name copied
 * from the URL (an older UI defaulted to the host; an owner may paste the address) would otherwise put the watched
 * site, or the whole URL with its query, into Todoist, and a host from a shared link is text the owner never wrote.
 * `host` is the stored host column (the URL's, kept by url-policy.ts). An internationalized host is compared in its
 * ASCII form only, as the URL keeps it.
 */
export function taskName(name: string, uri: string, host: string): string {
  const flat = oneLine(name, 4 * TASK_INTENT_LIMITS.itemTitleMax).toLowerCase();
  if (flat === '') return '';
  const candidates = new Set<string>([oneLine(uri, 4096).toLowerCase(), host.toLowerCase()]);
  try {
    const url = new URL(uri);
    for (const value of [url.href, url.origin, url.host]) candidates.add(value.toLowerCase());
    // The host and each parent domain of two labels or more.
    const labels = url.hostname.toLowerCase().split('.');
    for (let start = 0; start <= labels.length - 2; start++) candidates.add(labels.slice(start).join('.'));
  } catch {
    // Not a URL (never stored, url-policy.ts normalizes it): the raw text and the host column still count.
  }
  for (const candidate of candidates) {
    // A host has a dot (url-policy.ts refuses single-label hosts and IP literals); a shorter text is no address.
    if (candidate.includes('.') && flat.includes(candidate)) return '';
  }
  return name;
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

/**
 * What one answer means for the intent: its tasks exist (`done`), Todofy holds it (`held`: poll it after `afterMs`, or
 * propose it again then when `failed`), it is refused for good, or it is proposed again (`retry`: not recorded).
 */
export type Outcome =
  | { readonly kind: 'done'; readonly code: string }
  | { readonly kind: 'held'; readonly code: string; readonly afterMs: number }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'retry'; readonly code: string; readonly afterMs: number };

/** The retry after `attempts` failed proposals: INTENT_RETRY_BASE_MS doubling up to INTENT_RETRY_MAX_MS. */
export function backoffMs(attempts: number): number {
  return Math.min(INTENT_RETRY_MAX_MS, INTENT_RETRY_BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 10));
}

/** The answer's hint in milliseconds, or null. */
function hintMs(result: TaskIntentResult): number | null {
  return result.retryAfterSeconds === undefined ? null : result.retryAfterSeconds * SECOND;
}

/**
 * What a recorded intent's state means, from either method: created or duplicate end it; failed is proposed again
 * (re-queuing the unfinished tasks) after a backoff; pending or paused is polled at most every INTENT_POLL_MS.
 */
function heldOutcome(result: TaskIntentResult, attempts: number): Outcome {
  const state = STATES.name(result.state) ?? 'unknown';
  if (result.state === State.CREATED || result.state === State.DUPLICATE) return { kind: 'done', code: state };
  if (result.state === State.FAILED) return { kind: 'held', code: 'failed', afterMs: backoffMs(attempts) };
  return { kind: 'held', code: state, afterMs: Math.max(hintMs(result) ?? 0, INTENT_POLL_MS) };
}

/** The outcome of a readable answer to the `attempts`-th proposal. */
export function outcomeOf(result: TaskIntentResult, attempts: number, now: number): Outcome {
  const code = ERROR_CODES.name(result.errorCode) ?? STATES.name(result.state) ?? 'unknown';
  const hinted = hintMs(result);
  if (result.recorded) {
    // A recorded rejection is a conflict: another content holds this ID, which this sink never sends.
    return result.state === State.REJECTED ? { kind: 'refused', code } : heldOutcome(result, attempts);
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

/**
 * The outcome of a readable taskIntentStatus answer for a held intent (`attempts` proposals so far): `not_found`
 * (Todofy has no record, e.g. after a restore) makes it open again, to be proposed with the same bytes.
 */
export function statusOutcome(result: TaskIntentResult, attempts: number): Outcome {
  if (result.state === State.NOT_FOUND) return { kind: 'retry', code: 'not_found', afterMs: INTENT_RETRY_BASE_MS };
  if (!result.recorded) return { kind: 'held', code: STATES.name(result.state) ?? 'unknown', afterMs: INTENT_POLL_MS };
  // A recorded rejection cannot come from a status read of this sink's own intent: poll again later.
  if (result.state === State.REJECTED) return { kind: 'held', code: 'rejected', afterMs: INTENT_POLL_MS };
  return heldOutcome(result, attempts);
}

// ---- the sink -------------------------------------------------------------------------------------------------------

interface ChangeKindRow {
  id: string;
  trigger_kind: string;
  [column: string]: SqlStorageValue;
}

interface DueIntentRow {
  intent_id: string;
  kind: 'digest' | 'urgent';
  state: 'open' | 'held';
  payload: string;
  events: number;
  attempts: number;
  last_code: string | null;
  [column: string]: SqlStorageValue;
}

function isTriggerKind(value: string): value is TriggerKind {
  return Object.hasOwn(TRIGGER_LABELS, value);
}

/** The start of the UTC day of `now`. */
function dayStart(now: number): number {
  return Math.floor(now / DAY) * DAY;
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

  /**
   * The slots of Todofy's daily limit that are taken or may be taken today: the intents still open (of any day: each
   * takes a slot of the day Todofy records it, which a pause can push to today) and those Todofy recorded this UTC day
   * (`recorded_at`). Two indexed counts.
   */
  private slotsTaken(now: number): number {
    const open = this.store.one<{ n: number }>(`SELECT count(*) AS n FROM intents WHERE state = 'open'`)?.n ?? 0;
    const recorded = this.store.one<{ n: number }>(`SELECT count(*) AS n FROM intents WHERE recorded_at >= ?`, dayStart(now))?.n ?? 0;
    return open + recorded;
  }

  private digestDone(day: string): boolean {
    return this.store.getMeta('digest_day') === day;
  }

  wants(now: number): SinkWants {
    const day = utcDay(now);
    if (now >= digestTime(now) && !this.digestDone(day)) return { urgent: false, digest: true };
    // Room for an urgent intent: below Todofy's limit with one slot kept for a digest not yet frozen today.
    return { urgent: urgentWaiting(this.store) && this.slotsTaken(now) + (this.digestDone(day) ? 0 : 1) < INTENTS_PER_DAY, digest: false };
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
      const row = this.store.one<{ settings: string; host: string }>(`SELECT settings, host FROM watches WHERE id = ?`, watchId);
      if (row === undefined) continue;
      const settings = JSON.parse(row.settings) as { display_name?: unknown; uri?: unknown };
      const name = typeof settings.display_name === 'string' ? settings.display_name : '';
      // Never the watched site: a name that holds its URL or host becomes `监视 <id>` (taskName).
      lines.push({ watchId, name: taskName(name, typeof settings.uri === 'string' ? settings.uri : '', row.host), ...line });
    }
    return { lines, taken };
  }

  /** Freezes `intent` with the outbox rows it took; false when it is over the contract's size bound. */
  private freeze(intent: TaskIntent, kind: 'digest' | 'urgent', day: string, eventIds: readonly number[], now: number): boolean {
    const payload = freezeIntent(intent);
    if (payload === null) {
      console.log(JSON.stringify({ event: 'intent_too_large', kind, intent: intent.intentId, events: eventIds.length }));
      return false;
    }
    this.store.run(
      `INSERT OR IGNORE INTO intents (intent_id, kind, day, payload, event_ids, events, state, attempts, next_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?)`,
      intent.intentId,
      kind,
      day,
      payload,
      JSON.stringify(eventIds),
      eventIds.length,
      now,
      now,
      now,
    );
    return true;
  }

  take(events: readonly WatchEvent[], wants: SinkWants, now: number): readonly number[] {
    const day = utcDay(now);
    if (wants.digest) {
      // Open intents Todofy surely never recorded (never sent, or every answer said so: a pause, the day's limit) are
      // folded into this digest: their events join it and they end as superseded. So a pause across the digest hour
      // leaves one intent to send, not ten, and the day it ends Todofy's limit still has room for each day's digest.
      // An intent whose answer was lost may be recorded already: it is left alone (folding it could repeat a task).
      const folded = this.store.all<{ intent_id: string; event_ids: string }>(
        `SELECT intent_id, event_ids FROM intents WHERE state = 'open' AND known_unrecorded = 1 ORDER BY intent_id`,
      );
      const own = new Set(events.map((event) => event.id));
      const carried = eventsByIds(
        this.store,
        folded.flatMap((row) => (JSON.parse(row.event_ids) as number[]).filter((id) => !own.has(id))),
      );
      const { lines, taken } = this.lines([...events, ...carried]);
      const frozen = lines.length === 0 || this.freeze(digestIntent(day, lines, this.host), 'digest', day, taken, now);
      if (frozen) {
        for (const row of folded) {
          this.store.run(
            `UPDATE intents SET state = 'superseded', payload = '', event_ids = '[]', last_code = ?, updated_at = ? WHERE intent_id = ? AND state = 'open'`,
            `digest-${day}`,
            now,
            row.intent_id,
          );
        }
      }
      this.store.setMeta('digest_day', day);
      return taken.filter((id) => own.has(id));
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
    if (lines.length > 0 && first !== undefined) this.freeze(urgentIntent(first, lines, this.host), 'urgent', day, taken, now);
    return taken;
  }

  async flush(now: number): Promise<void> {
    this.store.run(
      `UPDATE intents SET state = 'expired', payload = '', last_code = 'gave_up', updated_at = ? WHERE state IN ('open', 'held') AND created_at <= ?`,
      now,
      now - INTENT_GIVE_UP_MS,
    );
    // The digest first: it is the one intent a day that must fit in Todofy's limit (urgent ones wait for a slot).
    const due = this.store.all<DueIntentRow>(
      `SELECT intent_id, kind, state, payload, events, attempts, last_code FROM intents
       WHERE state IN ('open', 'held') AND next_at <= ? ORDER BY kind = 'digest' DESC, next_at, intent_id LIMIT ?`,
      now,
      INTENT_SENDS_PER_ALARM,
    );
    for (const row of due) await this.send(row, now);
  }

  /** One call for a due intent: a proposal (open, or held and failed) or a status poll (held). */
  private async send(row: DueIntentRow, now: number): Promise<void> {
    const propose = row.state === 'open' || row.last_code === 'failed';
    const attempts = propose ? row.attempts + 1 : row.attempts;
    let outcome: Outcome;
    // Whether this call's answer said for sure that nothing was recorded (a lost or unreadable answer does not).
    let known = false;
    try {
      if (propose) {
        const result = asResult(await this.todofy.proposeTasks(JSON.parse(row.payload) as WireObject), row.intent_id);
        outcome = result === null ? { kind: 'retry', code: 'unreadable', afterMs: backoffMs(attempts) } : outcomeOf(result, attempts, now);
        known = result !== null;
      } else {
        const ref = toWire(TaskIntentRefSchema, create(TaskIntentRefSchema, { version: TASK_INTENT_VERSION, source: Source.WATCH, intentId: row.intent_id }));
        const result = asResult(await this.todofy.taskIntentStatus(ref), row.intent_id);
        outcome = result === null ? { kind: 'held', code: 'unreadable', afterMs: INTENT_POLL_MS } : statusOutcome(result, attempts);
        known = result !== null;
      }
    } catch (error) {
      // `new Error(code)` crosses RPC intact. invalid_input from a Todofy that does not know this source yet (or a bug
      // here): ask again a few times a day until given up. Anything else (unavailable, busy, a deploy) is retried.
      const code = error instanceof Error && error.message === 'invalid_input' ? 'invalid_input' : 'unavailable';
      const afterMs = code === 'invalid_input' ? INTENT_RETRY_MAX_MS : backoffMs(Math.max(attempts, 1));
      // A failed call changes nothing about who holds the intent: an open one stays open, a held one held.
      outcome = row.state === 'open' ? { kind: 'retry', code, afterMs } : { kind: 'held', code: row.last_code === 'failed' ? 'failed' : code, afterMs };
    }
    switch (outcome.kind) {
      case 'retry':
        // Still open; once an answer was lost it may be recorded already, so it is never folded into a digest.
        this.store.run(
          `UPDATE intents SET state = 'open', attempts = ?, next_at = ?, last_code = ?, known_unrecorded = known_unrecorded * ?, updated_at = ?
           WHERE intent_id = ? AND state = ?`,
          attempts,
          now + outcome.afterMs,
          outcome.code,
          row.state === 'open' && known ? 1 : 0,
          now,
          row.intent_id,
          row.state,
        );
        break;
      case 'held':
        // Todofy holds it: the bytes stay (a failed intent is proposed again with exactly them). `recorded_at` is the
        // first such answer (Todofy's daily limit counted it that day).
        this.store.run(
          `UPDATE intents SET state = 'held', attempts = ?, next_at = ?, last_code = ?, recorded_at = coalesce(recorded_at, ?), updated_at = ?
           WHERE intent_id = ? AND state = ?`,
          attempts,
          now + outcome.afterMs,
          outcome.code,
          now,
          now,
          row.intent_id,
          row.state,
        );
        break;
      default:
        // Its tasks exist (or it will never be taken): the owner's names leave this table.
        this.store.run(
          `UPDATE intents SET state = ?, payload = '', event_ids = '[]', attempts = ?, last_code = ?,
             recorded_at = CASE WHEN ? THEN coalesce(recorded_at, ?) ELSE recorded_at END, updated_at = ? WHERE intent_id = ? AND state = ?`,
          outcome.kind === 'done' ? 'recorded' : 'refused',
          attempts,
          outcome.code,
          outcome.kind === 'done' ? 1 : 0,
          now,
          now,
          row.intent_id,
          row.state,
        );
    }
    // IDs, kinds, counts and codes only.
    console.log(
      JSON.stringify({ event: 'intent', intent: row.intent_id, kind: row.kind, call: propose ? 'propose' : 'status', events: row.events, attempts, outcome: outcome.kind, code: outcome.code }),
    );
  }

  nextAt(now: number): number | null {
    const retry = this.store.one<{ at: number | null }>(`SELECT min(next_at) AS at FROM intents WHERE state IN ('open', 'held')`)?.at ?? null;
    const digest = this.digestDone(utcDay(now)) ? digestTime(now) + DAY : Math.max(digestTime(now), now);
    return retry === null ? digest : Math.min(retry, digest);
  }
}
