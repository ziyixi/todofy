/**
 * The Tasks sink (../../docs/design.md §7): the outbox becomes tasks in Tasks through its create-only TaskInbox (the
 * TASKS service binding, `props.source = "watch"`; proto/tasks/inbox/v1). It replaced Todofy's task intents on
 * 2026-10-21.
 *
 * - The digest: once a UTC day, at the first alarm from DIGEST_UTC_HOUR, every pending event (both policies) becomes
 *   one task `digest-<day>` with one subtask per watch.
 * - Urgent changes: each watch with a change confirmed on an URGENT watch becomes its own task `urgent-<change id>` in
 *   the same alarm, while the tasks still open (of any day) plus those created this UTC day plus one for a digest not
 *   yet frozen stay below INTENTS_PER_DAY. One past them waits for the digest. BROKEN and auto-paused watches are only
 *   in the digest.
 *
 * What a task says (the owner decision of 2026-10-01): only the owner's name for the watch, the trigger type and a
 * count, and a link to the watch in this app (`https://<host>/watches/<id>`). Never the page's text, the watched URL or
 * a summary: page content is untrusted (a page could address an assistant that reads the owner's tasks), and the
 * watched URL stays in the object.
 *
 * Delivery: `take` freezes the CreateInboxTaskRequest, with a random request_id, in the `intents` table in the
 * transaction that marks its events delivered (notify.ts), and `flush` sends what is due, the digest first, at most
 * INTENT_SENDS_PER_ALARM calls, always with the frozen bytes: TaskInbox answers a repeated request_id with its first
 * answer, so a lost answer never makes a second task. `invalid_input` is final (refused); `daily_limit` waits for the
 * next UTC day; anything else is retried with a backoff. After INTENT_GIVE_UP_MS a task still not created is given up.
 * Every outcome is a row's state and code, counted in ops-v1 (`notify_unsettled`); logs carry row IDs, kinds, counts
 * and codes only.
 *
 * The rows keep their stored names: `intents`, and `recorded` for a created task.
 */
import { CreateInboxTaskRequestSchema, CreateInboxTaskResponseSchema } from '@ziyixi/proto/tasks/inbox/v1/task_inbox_pb';
import type { CreateInboxTaskRequest, InboxSubtask, TaskInboxService } from '@ziyixi/proto/tasks/inbox/v1/task_inbox_wire';
import { fromWire, WireJsonError } from '@ziyixi/proto/wire-json';
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
  INTENTS_PER_DAY,
  SUBTASKS_MAX,
  TASK_TITLE_MAX,
} from './limits.ts';
import { eventsByIds, urgentWaiting, type NotificationSink, type SinkWants, type WatchEvent } from './notify.ts';
import type { Store } from './store.ts';

/** Tasks' named entrypoint "TaskInbox" as this app sees it: the generated TaskInboxService (wire JSON in and out). */
export interface TaskInboxEntrypoint extends Rpc.WorkerEntrypointBranded, TaskInboxService {}

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

/** One watch in a task: the owner's name for it and what happened, counted. */
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
 * A title's text: control characters, the line and paragraph separators and runs of white space become one space,
 * at most `max` code points.
 */
export function oneLine(text: string, max: number): string {
  // Only U+0000-U+001F, U+007F, U+2028, U+2029 and white space are replaced: a linear scan, whatever the input.
  // A lone surrogate becomes U+FFFD first (Tasks refuses text that is not well formed).
  // eslint-disable-next-line no-control-regex
  const flat = text.toWellFormed().replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/gu, ' ').trim();
  // Code points (an emoji sequence may be cut between its points).
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
  return oneLine([name, ...parts].join(' · '), TASK_TITLE_MAX);
}

/**
 * The owner's name for a watch as a task may carry it: '' (so the title says `监视 <id>`) when the name holds the watched
 * URL, its origin, its host or a parent domain of it (`shop.example.com`, `example.com`; a public suffix like `co.uk`
 * too, which only costs the name), compared case-insensitively on the one-line form. A name copied
 * from the URL (an older UI defaulted to the host; an owner may paste the address) would otherwise put the watched
 * site, or the whole URL with its query, into Tasks, and a host from a shared link is text the owner never wrote.
 * `host` is the stored host column (the URL's, kept by url-policy.ts). An internationalized host is compared in its
 * ASCII form only, as the URL keeps it.
 */
export function taskName(name: string, uri: string, host: string): string {
  const flat = oneLine(name, 4 * TASK_TITLE_MAX).toLowerCase();
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

/** Most changes first, then by watch ID: the same lines always give the same task. */
export function orderLines(lines: readonly WatchLine[]): WatchLine[] {
  return [...lines].sort((a, b) => changeCount(b) - changeCount(a) || (a.watchId < b.watchId ? -1 : a.watchId > b.watchId ? 1 : 0));
}

const watchLink = (host: string, watchId: string): string => `https://${host}/watches/${watchId}`;

/** The digest of `day`: one task, one subtask per watch; past SUBTASKS_MAX watches the last subtask names the rest. */
export function digestTask(requestId: string, day: string, lines: readonly WatchLine[], host: string): CreateInboxTaskRequest {
  const ordered = orderLines(lines);
  const subtask = (line: WatchLine): InboxSubtask => ({ title: lineTitle(line), description: watchLink(host, line.watchId) });
  const subtasks =
    ordered.length <= SUBTASKS_MAX
      ? ordered.map(subtask)
      : [
          ...ordered.slice(0, SUBTASKS_MAX - 1).map(subtask),
          { title: `另有 ${String(ordered.length - SUBTASKS_MAX + 1)} 个监视有变化或问题`, description: `https://${host}/` },
        ];
  return {
    request_id: requestId,
    title: `网页监视 ${day} · ${String(ordered.length)} 个监视`,
    description: `只有名称、类型和次数；变化的内容请在网页监视中查看。\nhttps://${host}/`,
    subtasks,
  };
}

/** An urgent change of one watch: its own task. */
export function urgentTask(requestId: string, line: WatchLine, host: string): CreateInboxTaskRequest {
  return { request_id: requestId, title: lineTitle(line), description: `网页监视 · 紧急变化\n${watchLink(host, line.watchId)}` };
}

/** TaskInbox's text rules (tasks/worker/src/inbox.ts), in UTF-16 code units: a title of 1 to 500 once trimmed. */
function fits(title: string, description = ''): boolean {
  const trimmed = title.trim();
  return trimmed.length > 0 && trimmed.length <= 500 && description.length <= 16000;
}

/** The request's wire JSON, compact (the bytes frozen in `intents`); null when TaskInbox would refuse it. */
export function freezeTask(request: CreateInboxTaskRequest): string | null {
  try {
    fromWire(CreateInboxTaskRequestSchema, request, { strict: true });
  } catch (error) {
    if (error instanceof WireJsonError) return null;
    throw error;
  }
  const texts = [request, ...(request.subtasks ?? [])];
  return texts.every((text) => fits(text.title, text.description)) ? JSON.stringify(request) : null;
}

/**
 * An open row of the Todofy sink (a task-intent-v1 TaskIntent, never recorded by Todofy) as a request: the parent's
 * title and description, and each item as a subtask that links where the item did. Null when it does not read.
 */
export function fromIntent(payload: string, requestId: string): CreateInboxTaskRequest | null {
  let intent: { parent?: { title?: unknown; description?: unknown }; items?: unknown };
  try {
    intent = JSON.parse(payload) as typeof intent;
  } catch {
    return null;
  }
  const items = Array.isArray(intent.items) ? (intent.items as { title?: unknown; url?: unknown }[]) : [];
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const request: CreateInboxTaskRequest = {
    request_id: requestId,
    title: oneLine(text(intent.parent?.title), TASK_TITLE_MAX),
    description: text(intent.parent?.description),
    subtasks: items.slice(0, SUBTASKS_MAX).map((item) => ({ title: oneLine(text(item.title), TASK_TITLE_MAX), description: text(item.url) })),
  };
  return freezeTask(request) === null ? null : request;
}

// ---- answers ----------------------------------------------------------------------------------------------------------

/** What one call means for the row: the task exists, it is refused for good, or it is sent again later. */
export type Outcome =
  | { readonly kind: 'done'; readonly code: string }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'retry'; readonly code: string; readonly afterMs: number; readonly unrecorded: boolean };

/** The retry after `attempts` failed calls: INTENT_RETRY_BASE_MS doubling up to INTENT_RETRY_MAX_MS. */
export function backoffMs(attempts: number): number {
  return Math.min(INTENT_RETRY_MAX_MS, INTENT_RETRY_BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 10));
}

/**
 * The outcome of the `attempts`-th call: an answer (read leniently: an output) is done, `replayed` too. TaskInbox's
 * codes: invalid_input is final, daily_limit (nothing was created) waits for the next UTC day, anything else (its
 * storage, a deploy, a lost answer) is retried with the same request.
 */
export function outcomeOf(result: { readonly answer: unknown } | { readonly error: unknown }, attempts: number, now: number): Outcome {
  if ('answer' in result) {
    try {
      const answer = fromWire(CreateInboxTaskResponseSchema, result.answer).message;
      return { kind: 'done', code: answer.replayed ? 'replayed' : 'created' };
    } catch (error) {
      if (!(error instanceof WireJsonError)) throw error;
      return { kind: 'retry', code: 'unreadable', afterMs: backoffMs(attempts), unrecorded: false };
    }
  }
  const message = result.error instanceof Error ? result.error.message : '';
  if (message === 'invalid_input') return { kind: 'refused', code: 'invalid_input' };
  if (message === 'daily_limit') return { kind: 'retry', code: 'daily_limit', afterMs: Math.max((Math.floor(now / DAY) + 1) * DAY - now, INTENT_RETRY_BASE_MS), unrecorded: true };
  return { kind: 'retry', code: 'unavailable', afterMs: backoffMs(attempts), unrecorded: false };
}

// ---- the sink -------------------------------------------------------------------------------------------------------

interface ChangeKindRow {
  id: string;
  trigger_kind: string;
  [column: string]: SqlStorageValue;
}

interface DueRow {
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

/** The start of the UTC day of `now`. */
function dayStart(now: number): number {
  return Math.floor(now / DAY) * DAY;
}

/** The start of `day`'s digest hour (UTC). */
function digestTime(now: number): number {
  return Math.floor(now / DAY) * DAY + DIGEST_UTC_HOUR * HOUR;
}

/**
 * The rows the Todofy sink left, settled before the first pass with this sink (once: meta `sink` is `tasks` after it,
 * one row read a pass). One Todofy recorded (`held`) had its tasks in Todofy's hands, which keeps no intents since
 * 2026-10-21, so it ends as expired `sink_retired` (`notify_unsettled` shows it); one never recorded (`open`) is sent
 * to Tasks as a request made from its frozen intent.
 */
export function retireTodofySink(store: Store, now: number): void {
  if (store.getMeta('sink') === 'tasks') return;
  store.run(`UPDATE intents SET state = 'expired', payload = '', event_ids = '[]', last_code = 'sink_retired', updated_at = ? WHERE state = 'held'`, now);
  for (const row of store.all<{ intent_id: string; payload: string }>(`SELECT intent_id, payload FROM intents WHERE state = 'open'`)) {
    const request = fromIntent(row.payload, crypto.randomUUID());
    if (request === null) {
      store.run(`UPDATE intents SET state = 'expired', payload = '', event_ids = '[]', last_code = 'sink_retired', updated_at = ? WHERE intent_id = ?`, now, row.intent_id);
    } else {
      store.run(`UPDATE intents SET payload = ?, next_at = ?, updated_at = ? WHERE intent_id = ?`, JSON.stringify(request), now, now, row.intent_id);
    }
  }
  store.setMeta('sink', 'tasks');
}

export class TasksSink implements NotificationSink {
  private readonly store: Store;
  private readonly tasks: Pick<TaskInboxService, 'createInboxTask'>;
  private readonly host: string;

  constructor(store: Store, tasks: Pick<TaskInboxService, 'createInboxTask'>, host: string) {
    this.store = store;
    this.tasks = tasks;
    this.host = host;
  }

  /**
   * The tasks of this source that are taken or may be taken today: the rows still open (of any day: each is created on
   * the day it goes through, which a failure can push to today) and those created this UTC day (`recorded_at`). Two
   * indexed counts.
   */
  private slotsTaken(now: number): number {
    const open = this.store.one<{ n: number }>(`SELECT count(*) AS n FROM intents WHERE state = 'open'`)?.n ?? 0;
    const created = this.store.one<{ n: number }>(`SELECT count(*) AS n FROM intents WHERE recorded_at >= ?`, dayStart(now))?.n ?? 0;
    return open + created;
  }

  private digestDone(day: string): boolean {
    return this.store.getMeta('digest_day') === day;
  }

  /** Urgent tasks that fit today: below INTENTS_PER_DAY with one slot kept for a digest not yet frozen. */
  private urgentRoom(now: number): number {
    return INTENTS_PER_DAY - this.slotsTaken(now) - (this.digestDone(utcDay(now)) ? 0 : 1);
  }

  wants(now: number): SinkWants {
    if (now >= digestTime(now) && !this.digestDone(utcDay(now))) return { urgent: false, digest: true };
    return { urgent: urgentWaiting(this.store) && this.urgentRoom(now) > 0, digest: false };
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

  /** Freezes `request` with the outbox rows it took; false when TaskInbox would refuse it. */
  private freeze(intentId: string, request: CreateInboxTaskRequest, kind: 'digest' | 'urgent', day: string, eventIds: readonly number[], now: number): boolean {
    const payload = freezeTask(request);
    if (payload === null) {
      console.log(JSON.stringify({ event: 'task_refused_locally', kind, intent: intentId, events: eventIds.length }));
      return false;
    }
    this.store.run(
      `INSERT OR IGNORE INTO intents (intent_id, kind, day, payload, event_ids, events, state, attempts, next_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?)`,
      intentId,
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
      // Open rows Tasks surely never created (never sent, or every answer was daily_limit) are folded into this digest:
      // their events join it and they end as superseded, so a day of refusals leaves one task to send, not ten. A row
      // whose answer was lost may have its task already: it is left alone (folding it could repeat a task).
      const folded = this.store.all<{ intent_id: string; event_ids: string }>(
        `SELECT intent_id, event_ids FROM intents WHERE state = 'open' AND known_unrecorded = 1 ORDER BY intent_id`,
      );
      const own = new Set(events.map((event) => event.id));
      const carried = eventsByIds(
        this.store,
        folded.flatMap((row) => (JSON.parse(row.event_ids) as number[]).filter((id) => !own.has(id))),
      );
      const { lines, taken } = this.lines([...events, ...carried]);
      const frozen = lines.length === 0 || this.freeze(`digest-${day}`, digestTask(crypto.randomUUID(), day, lines, this.host), 'digest', day, taken, now);
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
    // Urgent: confirmed changes only (a broken or paused watch is never urgent), one task per watch, as many watches as
    // today's room; the others wait.
    const room = this.urgentRoom(now);
    const byWatch = new Map<string, WatchEvent[]>();
    for (const event of events) {
      if (event.policy !== 'urgent' || event.kind !== 'change_confirmed' || event.changeId === null) continue;
      const list = byWatch.get(event.watchId);
      if (list !== undefined) list.push(event);
      else if (byWatch.size < room) byWatch.set(event.watchId, [event]);
    }
    const taken: number[] = [];
    for (const watchEvents of byWatch.values()) {
      const { lines, taken: ids } = this.lines(watchEvents);
      const [line] = lines;
      const first = watchEvents.map((event) => event.changeId ?? '').sort()[0];
      if (line !== undefined && first !== undefined) this.freeze(`urgent-${first}`, urgentTask(crypto.randomUUID(), line, this.host), 'urgent', day, ids, now);
      taken.push(...ids);
    }
    return taken;
  }

  async flush(now: number): Promise<void> {
    this.store.run(
      `UPDATE intents SET state = 'expired', payload = '', last_code = 'gave_up', updated_at = ? WHERE state = 'open' AND created_at <= ?`,
      now,
      now - INTENT_GIVE_UP_MS,
    );
    // The digest first: it is the one task a day that must fit (urgent ones wait for a slot).
    const due = this.store.all<DueRow>(
      `SELECT intent_id, kind, payload, events, attempts FROM intents
       WHERE state = 'open' AND next_at <= ? ORDER BY kind = 'digest' DESC, next_at, intent_id LIMIT ?`,
      now,
      INTENT_SENDS_PER_ALARM,
    );
    for (const row of due) await this.send(row, now);
  }

  /** One call for a due row, with its frozen request. */
  private async send(row: DueRow, now: number): Promise<void> {
    const attempts = row.attempts + 1;
    let result: { answer: unknown } | { error: unknown };
    try {
      result = { answer: await this.tasks.createInboxTask(JSON.parse(row.payload) as CreateInboxTaskRequest) };
    } catch (error) {
      result = { error };
    }
    const outcome = outcomeOf(result, attempts, now);
    if (outcome.kind === 'retry') {
      // Still open; once an answer may have created the task it is never folded into a digest.
      this.store.run(
        `UPDATE intents SET attempts = ?, next_at = ?, last_code = ?, known_unrecorded = known_unrecorded * ?, updated_at = ?
         WHERE intent_id = ? AND state = 'open'`,
        attempts,
        now + outcome.afterMs,
        outcome.code,
        outcome.unrecorded ? 1 : 0,
        now,
        row.intent_id,
      );
    } else {
      // The task exists (or will never be created): the owner's names leave this table.
      this.store.run(
        `UPDATE intents SET state = ?, payload = '', event_ids = '[]', attempts = ?, last_code = ?,
           recorded_at = CASE WHEN ? THEN ? ELSE recorded_at END, updated_at = ? WHERE intent_id = ? AND state = 'open'`,
        outcome.kind === 'done' ? 'recorded' : 'refused',
        attempts,
        outcome.code,
        outcome.kind === 'done' ? 1 : 0,
        now,
        now,
        row.intent_id,
      );
    }
    // IDs, kinds, counts and codes only.
    console.log(JSON.stringify({ event: 'task', intent: row.intent_id, kind: row.kind, events: row.events, attempts, outcome: outcome.kind, code: outcome.code }));
  }

  nextAt(now: number): number | null {
    const retry = this.store.one<{ at: number | null }>(`SELECT min(next_at) AS at FROM intents WHERE state = 'open'`)?.at ?? null;
    const digest = this.digestDone(utcDay(now)) ? digestTime(now) + DAY : Math.max(digestTime(now), now);
    return retry === null ? digest : Math.min(retry, digest);
  }
}
