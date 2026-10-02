/**
 * FlowDay's owner API (proto/flowday/ui/v1): one handler per rpc of FlowDayUiService, served by the shared transcoder
 * (proto/ts/http-transcoder.ts) from ./router.ts after authentication. A handler validates what the IDL cannot (the
 * bounds of ./limits.ts, IDs and days), runs the store's queries (./store/*, which write only what changes: the D1
 * write budget) and maps the Worker's records (./model.ts) to the API's messages. Errors are RpcErrors with the
 * reasons of ./errors.ts; a failed D1 call (StorageError, ./db.ts) is UNAVAILABLE, anything else unexpected a bug,
 * INTERNAL.
 *
 * The routes this replaces (/api/tasks, /api/flows, ... until 2026-10-02) answer 410 `reload_required` (./router.ts).
 */
import { sql } from 'drizzle-orm';
import { updatePaths } from '@ziyixi/proto/field-mask';
import { FlowSchema, NoteSchema, type Flow, type Note } from '@ziyixi/proto/flowday/ui/v1/flow_pb';
import {
  ListFlowsResponseSchema,
  ListNotesResponseSchema,
  ListTasksResponseSchema,
  ListTimeEntriesResponseSchema,
  QueryAnalyticsResponseSchema,
  RolloverFlowResponseSchema,
  SyncTasksRequest_Mode,
  SyncTasksResponse_State,
  SyncTasksResponseSchema,
  type FlowDayUiService,
} from '@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb';
import { SettingsSchema, type Settings } from '@ziyixi/proto/flowday/ui/v1/settings_pb';
import { TaskSchema, type Task } from '@ziyixi/proto/flowday/ui/v1/task_pb';
import { TimeEntry_Source, TimeEntrySchema, TimerSession_Mode, TimerSession_State, TimerSessionSchema, type TimeEntry, type TimerSession } from '@ziyixi/proto/flowday/ui/v1/time_entry_pb';
import type { ServiceHandlers, ShapeOf } from '@ziyixi/proto/http-transcoder';
import { decodePageToken, encodePageToken, PageTokenError, type PageParameters } from '@ziyixi/proto/page-token';
import { create } from '@ziyixi/proto/protobuf';
import { EmptySchema, timestampDate, timestampFromMs, type Timestamp } from '@ziyixi/proto/protobuf/wkt';
import { errorDetail } from '@ziyixi/proto/rpc-status';
import { importCredentialKey, isSealed, openCredential, sealCredential } from './credentials.ts';
import { sqliteNow, type Db } from './db.ts';
import type { Env } from './env.ts';
import { flowdayError } from './errors.ts';
import {
  ANALYTICS_PAGE,
  ENTRY_PAGE,
  FLOW_PAGE,
  MAX_DAY_CAPACITY_MINUTES,
  MAX_ESTIMATE_MINUTES,
  MAX_IDS,
  MAX_LABELS,
  MAX_NOTE,
  MAX_SESSION_ID,
  MAX_TITLE,
  MAX_TODOIST_KEY,
  NOTE_PAGE,
  TASK_PAGE,
} from './limits.ts';
import type { NoteRecord, TaskRecord, TimeEntryRecord, TimerSessionRecord } from './model.ts';
import { settings as settingsTable } from './schema.ts';
import { analyticsPage, dayCapacity } from './store/analytics.ts';
import { createTimeEntry, deleteTimeEntry, getTimeEntry, listTimeEntries, updateTimeEntry, type EntryCursor } from './store/entries.ts';
import {
  addCompletedFlowTask,
  getAllCompletedFlowTasks,
  getAllFlows,
  getCompletedTaskIds,
  getFlowTaskIds,
  removeCompletedFlowTask,
  rolloverAllTasks,
  rolloverSelectedTasks,
  setFlowStatements,
} from './store/flows.ts';
import { getNote, listNotes, upsertNote } from './store/notes.ts';
import { getPlanningDays, getSetting, getSettings, planningKey, setSettingQuery, setSettingSql } from './store/settings.ts';
import { createLocalTask, getTask, listTasks, restoreTask, runStatements, softDeleteTask, updateTaskEstimate, updateTaskTitle } from './store/tasks.ts';
import { clearActiveTimerSession, getActiveTimerSession, saveActiveTimerSession } from './store/timer-session.ts';
import { KEY_API_KEY, KEY_CLAIMED_AT, KEY_LAST_SYNC_AT, KEY_PENDING, KEY_PROJECTS, KEY_SYNC_TOKEN, runSync } from './sync.ts';

/** What every handler gets: ./router.ts authenticated the owner (and the transcoder checked CSRF) before routing. */
export interface ApiContext {
  readonly env: Env;
  /** The metered D1 database of this request. */
  readonly db: Db;
  /** Outbound fetch (Todoist); the global fetch in production. */
  readonly fetcher: typeof fetch;
  /** The clock (tests pass a fixed one). */
  readonly now: () => Date;
}

function bad(): never {
  throw flowdayError('BAD_REQUEST');
}

function notFound(): never {
  throw flowdayError('NOT_FOUND');
}

// ---- values ------------------------------------------------------------------------------------------------------

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Task IDs in fields: Todoist IDs, "local-<uuid>", "__flowday_misc__:<day>", "__flowday_quick__" (printable ASCII). */
const ID = /^[\x21-\x7e]{1,200}$/;
/**
 * A resource ID in a name: the same without `/` (AIP-122) and `%`. A name of several segments keeps an encoded `/`
 * as `%2F` (proto/ts/http-path.ts), so an ID sent with one is refused instead of naming another task.
 */
const RESOURCE_ID = /^[\x21-\x24\x26-\x2e\x30-\x7e]{1,200}$/;

/** A real calendar day, `YYYY-MM-DD`. */
export function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().startsWith(value);
}

export function isId(value: string): boolean {
  return ID.test(value);
}

function day(value: string): string {
  return isDay(value) ? value : bad();
}

function id(value: string): string {
  return isId(value) ? value : bad();
}

function idList(values: readonly string[]): string[] {
  if (values.length > MAX_IDS || !values.every(isId)) bad();
  return [...values];
}

/** The resource ID of `<collection>/<id>` (BAD_REQUEST for anything else). */
function resourceId(name: string, collection: string): string {
  const prefix = `${collection}/`;
  const value = name.startsWith(prefix) ? name.slice(prefix.length) : '';
  return RESOURCE_ID.test(value) ? value : bad();
}

/** The day and task of `flows/{day}/notes/{task}`. */
function noteName(name: string): { flowDate: string; taskId: string } {
  const parts = name.split('/');
  if (parts.length !== 4 || parts[0] !== 'flows' || parts[2] !== 'notes') bad();
  const taskId = parts[3] ?? '';
  if (!RESOURCE_ID.test(taskId)) bad();
  return { flowDate: day(parts[1] ?? ''), taskId };
}

/** The masked fields an update replaces: `*` becomes `all`; output-only `ignored` paths are dropped; others refused. */
function maskOf(mask: { readonly paths: readonly string[] } | undefined, all: readonly string[], ignored: readonly string[] = []): Set<string> {
  let paths: '*' | readonly string[];
  try {
    paths = updatePaths(mask);
  } catch {
    bad();
  }
  if (paths === '*') return new Set(all);
  const out = new Set<string>();
  for (const path of paths) {
    if (all.includes(path)) out.add(path);
    else if (!ignored.includes(path)) bad();
  }
  return out;
}

// ---- times -------------------------------------------------------------------------------------------------------

const SQLITE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
/** 0001-01-01T00:00:00Z and 9999-12-31T23:59:59.999Z: the years RFC 3339 can write. */
const MIN_MS = -62135596800000;
const MAX_MS = 253402300799999;

/**
 * A stored time as a Timestamp: the ISO strings the UI and Todoist wrote (any fraction digits, any offset) and
 * SQLite's `YYYY-MM-DD HH:MM:SS` (UTC, the created_at default). Anything else, from an older copy, is unset rather
 * than a refused answer.
 */
export function storedTime(text: string | null | undefined): Timestamp | undefined {
  if (text === null || text === undefined || text === '') return undefined;
  const ms = Date.parse(SQLITE_TIME.test(text) ? `${text.replace(' ', 'T')}Z` : text);
  return Number.isFinite(ms) && ms >= MIN_MS && ms <= MAX_MS ? timestampFromMs(ms) : undefined;
}

/** A Timestamp as the Worker stores times: `toISOString()`, which is what the UI always sent. */
function timeText(timestamp: Timestamp): string {
  return timestampDate(timestamp).toISOString();
}

// ---- page tokens -------------------------------------------------------------------------------------------------

function pageSize(requested: number, max: number): number {
  return requested <= 0 || requested > max ? max : requested;
}

/** The cursor of a page token (undefined for the first page); BAD_REQUEST for a token of other parameters. */
function cursorOf(token: string, parameters: PageParameters): unknown {
  if (token === '') return undefined;
  try {
    return decodePageToken(token, parameters);
  } catch (error) {
    if (error instanceof PageTokenError) bad();
    throw error;
  }
}

function entryCursorOf(value: unknown, byDay: boolean): EntryCursor | null {
  if (value === undefined) return null;
  const { d, s, i } = (typeof value === 'object' && value !== null ? value : {}) as { d?: unknown; s?: unknown; i?: unknown };
  if (typeof s !== 'string' || typeof i !== 'string' || (byDay ? typeof d !== 'string' : d !== undefined)) bad();
  return byDay ? { flowDate: d as string, startTime: s, id: i } : { startTime: s, id: i };
}

function entryToken(cursor: EntryCursor | null, parameters: PageParameters): string {
  if (cursor === null) return '';
  return encodePageToken(cursor.flowDate === undefined ? { s: cursor.startTime, i: cursor.id } : { d: cursor.flowDate, s: cursor.startTime, i: cursor.id }, parameters);
}

// ---- records to messages -----------------------------------------------------------------------------------------

export function taskMessage(task: TaskRecord): Task {
  return create(TaskSchema, {
    name: `tasks/${task.id}`,
    todoistId: task.todoistId ?? '',
    title: task.title,
    description: task.description ?? '',
    projectDisplayName: task.projectName ?? '',
    projectColor: task.projectColor ?? '',
    priority: task.priority,
    labels: task.labels,
    ...(task.estimatedMins === null ? {} : { estimatedMinutes: task.estimatedMins }),
    completed: task.isCompleted,
    completeTime: storedTime(task.completedAt),
    dueDate: task.dueDate ?? '',
    createTime: storedTime(task.createdAt),
    deleteTime: storedTime(task.deletedAt),
  });
}

export function flowMessage(flowDate: string, taskIds: string[], completedTaskIds: string[], planningCompleted: boolean): Flow {
  return create(FlowSchema, { name: `flows/${flowDate}`, taskIds, completedTaskIds, planningCompleted });
}

function noteMessage(note: NoteRecord): Note {
  return create(NoteSchema, { name: `flows/${note.flowDate}/notes/${note.taskId}`, content: note.content, updateTime: storedTime(note.updatedAt) });
}

export function timeEntryMessage(entry: TimeEntryRecord): TimeEntry {
  return create(TimeEntrySchema, {
    name: `timeEntries/${entry.id}`,
    taskId: entry.taskId,
    flowDate: entry.flowDate,
    startTime: storedTime(entry.startTime),
    endTime: storedTime(entry.endTime),
    ...(entry.durationS === null ? {} : { durationSeconds: entry.durationS }),
    source: entry.source === 'manual' ? TimeEntry_Source.MANUAL : TimeEntry_Source.TIMER,
    createTime: storedTime(entry.createdAt),
  });
}

const STATES = { idle: TimerSession_State.IDLE, running: TimerSession_State.RUNNING, paused: TimerSession_State.PAUSED } as const;
const MODES = { countup: TimerSession_Mode.COUNT_UP, pomodoro: TimerSession_Mode.POMODORO } as const;

/** The empty session: no task, IDLE (what GetTimerSession answers when nothing is stored). */
const EMPTY_SESSION: Omit<TimerSessionRecord, 'updatedAt'> = {
  taskId: null,
  flowDate: null,
  status: 'idle',
  timerMode: 'countup',
  pomodoroTargetS: null,
  segmentWallStart: null,
  sessionSavedS: 0,
  pomodoroFinishedTaskId: null,
  pomodoroFinishedFlowDate: null,
  pomodoroFinishedTargetS: null,
};

function sessionMessage(session: TimerSessionRecord | null): TimerSession {
  const s = session ?? { ...EMPTY_SESSION, updatedAt: null };
  return create(TimerSessionSchema, {
    name: 'timerSession',
    taskId: s.taskId ?? '',
    flowDate: s.flowDate ?? '',
    state: STATES[s.status],
    mode: MODES[s.timerMode],
    ...(s.pomodoroTargetS === null ? {} : { pomodoroTargetSeconds: s.pomodoroTargetS }),
    segmentStartTime: storedTime(s.segmentWallStart),
    savedSeconds: s.sessionSavedS,
    finishedPomodoroTaskId: s.pomodoroFinishedTaskId ?? '',
    finishedPomodoroFlowDate: s.pomodoroFinishedFlowDate ?? '',
    ...(s.pomodoroFinishedTargetS === null ? {} : { finishedPomodoroTargetSeconds: s.pomodoroFinishedTargetS }),
    updateTime: storedTime(s.updatedAt),
  });
}

async function readSettings(db: Db): Promise<Settings> {
  const values = await getSettings(db, [KEY_API_KEY, KEY_LAST_SYNC_AT, 'day_capacity_mins']);
  return create(SettingsSchema, {
    name: 'settings',
    // Only a sealed key counts (a plaintext one from an older copy is never used).
    todoistApiKeySet: isSealed(values.get(KEY_API_KEY)),
    dayCapacityMinutes: dayCapacity(values.get('day_capacity_mins') ?? null),
    lastSyncTime: storedTime(values.get(KEY_LAST_SYNC_AT)),
  });
}

async function readFlow(db: Db, flowDate: string): Promise<Flow> {
  const [taskIds, completed, planning] = await Promise.all([getFlowTaskIds(db, flowDate), getCompletedTaskIds(db, flowDate), getSetting(db, planningKey(flowDate))]);
  return flowMessage(flowDate, taskIds, completed, planning === 'true');
}

async function existingTask(db: Db, name: string) {
  const stored = await getTask(db, resourceId(name, 'tasks'));
  return stored ?? notFound();
}

// ---- handlers ----------------------------------------------------------------------------------------------------

/** The task fields an update may replace. */
const TASK_MASK = ['title', 'estimated_minutes'] as const;
const TASK_IGNORED = ['name', 'todoist_id', 'project_display_name', 'project_color', 'completed', 'complete_time', 'create_time', 'delete_time'];

function title(value: string): string {
  const trimmed = value.trim();
  return trimmed === '' || value.length > MAX_TITLE ? bad() : trimmed;
}

function minutes(value: number): number {
  return value < 0 || value > MAX_ESTIMATE_MINUTES ? bad() : value;
}

/** The timer session fields an update may replace (every field the UI sets). */
const SESSION_MASK = [
  'task_id',
  'flow_date',
  'state',
  'mode',
  'pomodoro_target_seconds',
  'segment_start_time',
  'saved_seconds',
  'finished_pomodoro_task_id',
  'finished_pomodoro_flow_date',
  'finished_pomodoro_target_seconds',
] as const;

function sessionId(value: string): string | null {
  if (value.length > MAX_SESSION_ID) bad();
  return value === '' ? null : value;
}

function sessionDay(value: string): string | null {
  if (value !== '' && !isDay(value)) bad();
  return value === '' ? null : value;
}

/** The record of `message`'s masked fields over `base`. */
function sessionRecord(message: TimerSession, base: Omit<TimerSessionRecord, 'updatedAt'>, mask: ReadonlySet<string>): Omit<TimerSessionRecord, 'updatedAt'> {
  const out = { ...base };
  if (mask.has('task_id')) out.taskId = sessionId(message.taskId);
  if (mask.has('flow_date')) out.flowDate = sessionDay(message.flowDate);
  if (mask.has('state')) out.status = message.state === TimerSession_State.RUNNING ? 'running' : message.state === TimerSession_State.PAUSED ? 'paused' : 'idle';
  if (mask.has('mode')) out.timerMode = message.mode === TimerSession_Mode.POMODORO ? 'pomodoro' : 'countup';
  if (mask.has('pomodoro_target_seconds')) out.pomodoroTargetS = message.pomodoroTargetSeconds ?? null;
  if (mask.has('segment_start_time')) out.segmentWallStart = message.segmentStartTime === undefined ? null : timeText(message.segmentStartTime);
  if (mask.has('saved_seconds')) out.sessionSavedS = Math.max(message.savedSeconds, 0);
  if (mask.has('finished_pomodoro_task_id')) out.pomodoroFinishedTaskId = sessionId(message.finishedPomodoroTaskId);
  if (mask.has('finished_pomodoro_flow_date')) out.pomodoroFinishedFlowDate = sessionDay(message.finishedPomodoroFlowDate);
  if (mask.has('finished_pomodoro_target_seconds')) out.pomodoroFinishedTargetS = message.finishedPomodoroTargetSeconds ?? null;
  return out;
}

export const handlers: ServiceHandlers<ShapeOf<typeof FlowDayUiService>, ApiContext> = {
  // ---- tasks ----

  async getTask(request, { db }) {
    return taskMessage((await existingTask(db, request.name)).task);
  },

  async listTasks(request, { db }) {
    const parameters = { show_deleted: request.showDeleted };
    const cursor = cursorOf(request.pageToken, parameters);
    if (cursor !== undefined && !(typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor > 0)) bad();
    const page = await listTasks(db, { afterRowid: cursor ?? 0, limit: pageSize(request.pageSize, TASK_PAGE), showDeleted: request.showDeleted });
    return create(ListTasksResponseSchema, {
      tasks: page.tasks.map(taskMessage),
      nextPageToken: page.nextRowid === null ? '' : encodePageToken(page.nextRowid, parameters),
    });
  },

  async createTask(request, { db, now }) {
    const input = request.task ?? bad();
    const labels = input.labels.slice(0, MAX_LABELS);
    const created = await createLocalTask(
      db,
      `local-${request.requestId === '' ? crypto.randomUUID() : request.requestId}`,
      {
        title: title(input.title),
        priority: input.priority,
        ...(input.dueDate === '' ? {} : { dueDate: day(input.dueDate) }),
        ...(input.estimatedMinutes === undefined ? {} : { estimatedMins: minutes(input.estimatedMinutes) }),
        labels,
        ...(input.description === '' ? {} : { description: input.description.slice(0, MAX_TITLE) }),
      },
      now(),
    );
    return taskMessage(created.task);
  },

  async updateTask(request, { db }) {
    const input = request.task ?? bad();
    const mask = maskOf(request.updateMask, TASK_MASK, TASK_IGNORED);
    const taskId = resourceId(input.name, 'tasks');
    const newTitle = mask.has('title') ? title(input.title) : null;
    // An unset estimate clears it.
    const newEstimate = mask.has('estimated_minutes') ? (input.estimatedMinutes === undefined ? null : minutes(input.estimatedMinutes)) : undefined;
    const stored = (await getTask(db, taskId)) ?? notFound();
    // Each write changes only a value that differs (none for a repeat).
    if (newTitle !== null) await updateTaskTitle(db, taskId, newTitle);
    if (newEstimate !== undefined) await updateTaskEstimate(db, taskId, newEstimate);
    return taskMessage({ ...stored.task, ...(newTitle === null ? {} : { title: newTitle }), ...(newEstimate === undefined ? {} : { estimatedMins: newEstimate }) });
  },

  async deleteTask(request, { db, now }) {
    const stored = await existingTask(db, request.name);
    // AIP-164: deleting a task deleted in FlowDay already is NOT_FOUND, with the deleted task.
    if (stored.deletedSource === 'local') throw flowdayError('NOT_FOUND', [errorDetail(TaskSchema, taskMessage(stored.task))]);
    const at = now();
    await softDeleteTask(db, stored.task.id, at);
    return taskMessage({ ...stored.task, deletedAt: at.toISOString() });
  },

  async undeleteTask(request, { db }) {
    const stored = await existingTask(db, request.name);
    if (stored.task.deletedAt === null && stored.deletedSource === null) throw flowdayError('TASK_NOT_DELETED', [errorDetail(TaskSchema, taskMessage(stored.task))]);
    await restoreTask(db, stored.task.id);
    return taskMessage({ ...stored.task, deletedAt: null });
  },

  async syncTasks(request, { db, env, fetcher, now }) {
    const mode = request.mode === SyncTasksRequest_Mode.MANUAL ? 'manual' : 'auto';
    const outcome = await runSync({ db, mode, credentialKey: env.CREDENTIAL_KEY, fetcher, now: now() });
    switch (outcome.kind) {
      case 'ok': {
        const result = outcome.response;
        const state = result.status === 'synced' ? SyncTasksResponse_State.SYNCED : result.status === 'partial' ? SyncTasksResponse_State.PARTIAL : SyncTasksResponse_State.THROTTLED;
        return create(SyncTasksResponseSchema, {
          state,
          changedTaskCount: result.changed,
          fullSync: result.fullSync,
          lastSyncTime: storedTime(result.lastSyncAt),
          nextAutoSyncTime: timestampFromMs(result.nextAutoSyncAt),
        });
      }
      case 'no_key':
        throw flowdayError('TODOIST_KEY_MISSING');
      case 'key_unreadable':
        throw flowdayError('TODOIST_KEY_UNREADABLE');
      case 'not_configured':
        throw flowdayError('NOT_CONFIGURED');
      case 'todoist':
        throw flowdayError(outcome.failure === 'unauthorized' ? 'TODOIST_UNAUTHORIZED' : 'TODOIST_UNAVAILABLE');
    }
  },

  // ---- flows ----

  async getFlow(request, { db }) {
    return readFlow(db, day(resourceId(request.name, 'flows')));
  },

  async listFlows(request, { db }) {
    const cursor = cursorOf(request.pageToken, {});
    if (cursor !== undefined && !(typeof cursor === 'string' && isDay(cursor))) bad();
    const [flows, completed, planning] = await Promise.all([getAllFlows(db), getAllCompletedFlowTasks(db), getPlanningDays(db)]);
    const days = [...new Set([...Object.keys(flows), ...Object.keys(completed), ...planning])].filter((flowDate) => cursor === undefined || flowDate > cursor).sort();
    const limit = pageSize(request.pageSize, FLOW_PAGE);
    const page = days.slice(0, limit);
    const last = page.at(-1);
    return create(ListFlowsResponseSchema, {
      flows: page.map((flowDate) => flowMessage(flowDate, flows[flowDate] ?? [], completed[flowDate] ?? [], planning.has(flowDate))),
      nextPageToken: days.length > limit && last !== undefined ? encodePageToken(last, {}) : '',
    });
  },

  async updateFlow(request, { db }) {
    const input = request.flow ?? bad();
    const flowDate = day(resourceId(input.name, 'flows'));
    const mask = maskOf(request.updateMask, ['task_ids', 'planning_completed'], ['name', 'completed_task_ids']);
    // One atomic batch; each statement writes only what differs (UpdateFlow of the same list writes nothing).
    const statements = mask.has('task_ids') ? setFlowStatements(flowDate, idList(input.taskIds)) : [];
    if (mask.has('planning_completed')) {
      statements.push(input.planningCompleted ? setSettingSql(planningKey(flowDate), 'true') : sql`DELETE FROM settings WHERE key = ${planningKey(flowDate)}`);
    }
    await runStatements(db, statements);
    return readFlow(db, flowDate);
  },

  async completeFlowTask(request, { db }) {
    const flowDate = day(resourceId(request.name, 'flows'));
    await addCompletedFlowTask(db, flowDate, id(request.taskId));
    return readFlow(db, flowDate);
  },

  async reopenFlowTask(request, { db }) {
    const flowDate = day(resourceId(request.name, 'flows'));
    await removeCompletedFlowTask(db, flowDate, id(request.taskId));
    return readFlow(db, flowDate);
  },

  async rolloverFlow(request, { db }) {
    const fromDate = day(resourceId(request.name, 'flows'));
    const toDate = day(resourceId(request.destination, 'flows'));
    if (request.taskIds.length === 0) await rolloverAllTasks(db, fromDate, toDate);
    else await rolloverSelectedTasks(db, fromDate, toDate, idList(request.taskIds));
    const [flow, destinationFlow] = await Promise.all([readFlow(db, fromDate), readFlow(db, toDate)]);
    return create(RolloverFlowResponseSchema, { flow, destinationFlow });
  },

  // ---- notes ----

  async getNote(request, { db }) {
    const { flowDate, taskId } = noteName(request.name);
    return noteMessage((await getNote(db, taskId, flowDate)) ?? { taskId, flowDate, content: '', updatedAt: null });
  },

  async listNotes(request, { db }) {
    const flowDate = day(resourceId(request.parent, 'flows'));
    const parameters = { parent: request.parent };
    const cursor = cursorOf(request.pageToken, parameters);
    if (cursor !== undefined && !(typeof cursor === 'string' && isId(cursor))) bad();
    const page = await listNotes(db, flowDate, cursor ?? '', pageSize(request.pageSize, NOTE_PAGE));
    const last = page.notes.at(-1);
    return create(ListNotesResponseSchema, {
      notes: page.notes.map(noteMessage),
      nextPageToken: page.more && last !== undefined ? encodePageToken(last.taskId, parameters) : '',
    });
  },

  async updateNote(request, { db, now }) {
    const input = request.note ?? bad();
    const { flowDate, taskId } = noteName(input.name);
    maskOf(request.updateMask, ['content'], ['name', 'update_time']);
    if (input.content.length > MAX_NOTE) bad();
    return noteMessage(await upsertNote(db, taskId, flowDate, input.content, now()));
  },

  // ---- time entries ----

  async getTimeEntry(request, { db }) {
    return timeEntryMessage((await getTimeEntry(db, resourceId(request.name, 'timeEntries'))) ?? notFound());
  },

  async listTimeEntries(request, { db }) {
    const taskId = request.taskId === '' ? null : id(request.taskId);
    const flowDate = request.flowDate === '' ? null : day(request.flowDate);
    if (taskId === null && flowDate === null) bad();
    const parameters = { task_id: request.taskId, flow_date: request.flowDate };
    const after = entryCursorOf(cursorOf(request.pageToken, parameters), false);
    const page = await listTimeEntries(db, { taskId, flowDate, after, limit: pageSize(request.pageSize, ENTRY_PAGE) });
    const last = page.entries.at(-1);
    return create(ListTimeEntriesResponseSchema, {
      timeEntries: page.entries.map(timeEntryMessage),
      nextPageToken: page.more && last !== undefined ? entryToken({ startTime: last.startTime, id: last.id }, parameters) : '',
    });
  },

  async createTimeEntry(request, { db, now }) {
    const input = request.timeEntry ?? bad();
    const entryId = request.requestId === '' ? crypto.randomUUID() : request.requestId;
    const start = input.startTime ?? bad();
    const durationS = input.durationSeconds ?? null;
    if (durationS !== null && durationS < 0) bad();
    const at = now();
    const entry = {
      id: entryId,
      taskId: id(input.taskId),
      flowDate: day(input.flowDate),
      startTime: timeText(start),
      endTime: input.endTime === undefined ? null : timeText(input.endTime),
      durationS,
      source: input.source === TimeEntry_Source.MANUAL ? ('manual' as const) : ('timer' as const),
    };
    // A repeated request (the same request_id) finds the entry the first one stored and writes nothing.
    if (!(await createTimeEntry(db, entry, at))) return timeEntryMessage((await getTimeEntry(db, entryId)) ?? notFound());
    return timeEntryMessage({ ...entry, createdAt: sqliteNow(at) });
  },

  async updateTimeEntry(request, { db }) {
    const input = request.timeEntry ?? bad();
    const entryId = resourceId(input.name, 'timeEntries');
    const mask = maskOf(request.updateMask, ['start_time', 'end_time'], ['name', 'create_time']);
    const stored = (await getTimeEntry(db, entryId)) ?? notFound();
    const startTime = mask.has('start_time') ? timeText(input.startTime ?? bad()) : stored.startTime;
    const endTime = mask.has('end_time') ? timeText(input.endTime ?? bad()) : (stored.endTime ?? bad());
    const durationMs = Date.parse(endTime) - Date.parse(startTime);
    if (!(durationMs >= 0)) bad();
    const durationS = Math.floor(durationMs / 1000);
    if (!(await updateTimeEntry(db, entryId, { startTime, endTime, durationS }))) notFound();
    return timeEntryMessage({ ...stored, startTime, endTime, durationS });
  },

  async deleteTimeEntry(request, { db }) {
    if (!(await deleteTimeEntry(db, resourceId(request.name, 'timeEntries')))) notFound();
    return create(EmptySchema);
  },

  // ---- the timer session ----

  async getTimerSession(request, { db }) {
    if (request.name !== 'timerSession') notFound();
    return sessionMessage(await getActiveTimerSession(db));
  },

  async updateTimerSession(request, { db, now }) {
    const input = request.timerSession ?? bad();
    const mask = maskOf(request.updateMask, SESSION_MASK, ['name', 'update_time']);
    // A partial mask keeps the other stored fields (one read); the UI always replaces the whole session.
    const base = mask.size === SESSION_MASK.length ? EMPTY_SESSION : ((await getActiveTimerSession(db)) ?? EMPTY_SESSION);
    const session = sessionRecord(input, base, mask);
    const at = now();
    await saveActiveTimerSession(db, session, at);
    return sessionMessage({ ...session, updatedAt: at.toISOString() });
  },

  async clearTimerSession(request, { db }) {
    if (request.name !== 'timerSession') notFound();
    await clearActiveTimerSession(db);
    return sessionMessage(null);
  },

  // ---- settings ----

  async getSettings(request, { db }) {
    if (request.name !== 'settings') notFound();
    return readSettings(db);
  },

  async updateSettings(request, { db, env }) {
    const input = request.settings ?? bad();
    if (input.name !== 'settings') notFound();
    const mask = maskOf(request.updateMask, ['todoist_api_key', 'day_capacity_minutes'], ['name', 'todoist_api_key_set', 'last_sync_time']);
    const writes = [];
    if (mask.has('day_capacity_minutes') && (input.dayCapacityMinutes < 0 || input.dayCapacityMinutes > MAX_DAY_CAPACITY_MINUTES)) bad();
    if (mask.has('todoist_api_key')) {
      const key = input.todoistApiKey.trim();
      if (key === '' || key.length > MAX_TODOIST_KEY) bad();
      // The key is stored only sealed under CREDENTIAL_KEY (./credentials.ts); saving the same key writes nothing.
      const credentialKey = await importCredentialKey(env.CREDENTIAL_KEY);
      if (credentialKey === null) throw flowdayError('NOT_CONFIGURED');
      if ((await openCredential(credentialKey, KEY_API_KEY, await getSetting(db, KEY_API_KEY))) !== key) {
        // A new key may be another account: the next sync starts over with a full sync, right away.
        writes.push(
          setSettingQuery(db, KEY_API_KEY, await sealCredential(credentialKey, KEY_API_KEY, key)),
          db.delete(settingsTable).where(sql`${settingsTable.key} IN (${KEY_SYNC_TOKEN}, ${KEY_PROJECTS}, ${KEY_CLAIMED_AT}, ${KEY_PENDING})`),
        );
      }
    }
    if (mask.has('day_capacity_minutes')) writes.push(setSettingQuery(db, 'day_capacity_mins', String(input.dayCapacityMinutes)));
    const [first, ...rest] = writes;
    if (first !== undefined) await db.batch([first, ...rest]);
    return readSettings(db);
  },

  // ---- analytics ----

  async queryAnalytics(request, { db }) {
    if ((request.startDate === '') !== (request.endDate === '')) bad();
    const range = request.startDate === '' ? null : { start: day(request.startDate), end: day(request.endDate) };
    if (range !== null && range.start > range.end) bad();
    const parameters = { start_date: request.startDate, end_date: request.endDate };
    const cursor = entryCursorOf(cursorOf(request.pageToken, parameters), range !== null);
    const page = await analyticsPage(db, range, cursor, pageSize(request.pageSize, ANALYTICS_PAGE));
    // The (day, task) rows as one Flow per day, both lists in their stored order.
    const flows = new Map<string, Flow>();
    const flowOf = (flowDate: string): Flow => {
      let flow = flows.get(flowDate);
      if (flow === undefined) {
        flow = flowMessage(flowDate, [], [], false);
        flows.set(flowDate, flow);
      }
      return flow;
    };
    for (const row of page.flows) flowOf(row.flowDate).taskIds.push(row.taskId);
    for (const row of page.completed) flowOf(row.flowDate).completedTaskIds.push(row.taskId);
    return create(QueryAnalyticsResponseSchema, {
      timeEntries: page.entries.map(timeEntryMessage),
      nextPageToken: entryToken(page.next, parameters),
      flows: [...flows.keys()].sort().map((flowDate) => flowOf(flowDate)),
      tasks: page.tasks.map(taskMessage),
      dayCapacityMinutes: page.dayCapacityMins,
    });
  },
};
