/**
 * The owner API (/api/*): the container era's route handlers, one small function each, on D1. Every request here
 * is already authenticated; `mutate()` adds the CSRF and Origin check and reads the JSON body.
 *
 * Gone compared with the container: /api/export (the browser builds CSV and JSON from /api/analytics) and the
 * server-side review maths (/api/analytics returns raw rows; ../../docs/design.md "Reviews and exports").
 */
import { sql } from 'drizzle-orm';
import type { ActiveTimerSession, SettingsResponse, TimerSessionMode, TimerSessionStatus } from './api-types.ts';
import { importCredentialKey, isSealed, openCredential, sealCredential } from './credentials.ts';
import type { Db } from './db.ts';
import { HttpError, bad, csrfResponse, jsonResponse, methodNotAllowed, type Body, type Principal } from './http.ts';
import type { Env } from './env.ts';
import { settings } from './schema.ts';
import { analyticsDataset, dayCapacity } from './store/analytics.ts';
import { createTimeEntry, deleteTimeEntry, getEntriesByDate, getEntriesByTask, getEntriesByTaskAndDate, updateTimeEntry } from './store/entries.ts';
import {
  addCompletedFlowTask,
  getAllCompletedFlowTasks,
  getAllFlows,
  removeCompletedFlowTask,
  rolloverAllTasks,
  rolloverSelectedTasks,
  setFlowTaskIds,
} from './store/flows.ts';
import { getNote, getNotesByDate, upsertNote } from './store/notes.ts';
import { getSetting, getSettings, setSettingQuery } from './store/settings.ts';
import {
  createLocalTask,
  getAllTasks,
  getDeletedTasks,
  restoreTask,
  softDeleteTask,
  updateTaskEstimate,
  updateTaskTitle,
} from './store/tasks.ts';
import { clearActiveTimerSession, getActiveTimerSession, saveActiveTimerSession } from './store/timer-session.ts';
import { KEY_API_KEY, KEY_CLAIMED_AT, KEY_LAST_SYNC_AT, KEY_PENDING, KEY_PROJECTS, KEY_SYNC_TOKEN, runSync } from './sync.ts';

export interface ApiContext {
  readonly request: Request;
  readonly env: Env;
  readonly url: URL;
  readonly db: Db;
  readonly principal: Principal;
  /** Checks CSRF and Origin, then reads the JSON body. Every non-GET route calls it first. */
  readonly mutate: () => Promise<Body>;
  /** Outbound fetch (Todoist); the global fetch in production. */
  readonly fetcher: typeof fetch;
}

// ---- validation ------------------------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Task ids: Todoist ids, "local-<uuid>", "__flowday_misc__:<date>", "__flowday_quick__". */
const ID = /^[\x21-\x7e]{1,200}$/;
export const MAX_IDS = 2000;
export const MAX_TITLE = 2000;
export const MAX_NOTE = 100_000;

export function isDate(value: unknown): value is string {
  return typeof value === 'string' && DATE.test(value);
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function idList(value: unknown, detail: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_IDS || !value.every(isId)) bad(detail);
  return value;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 200 ? value : null;
}

function nullableInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function only(method: string, ...allowed: string[]): void {
  if (!allowed.includes(method)) throw methodNotAllowed(allowed.join(', '));
}

// ---- routes ------------------------------------------------------------------------------------------------------

const ENTRY_ROUTE = /^\/api\/entries\/([^/]{1,200})$/;

export async function api(ctx: ApiContext): Promise<Response> {
  const { request, url } = ctx;
  const entry = ENTRY_ROUTE.exec(url.pathname);
  if (entry) return entryById(ctx, decodeURIComponent(entry[1] ?? ''));
  switch (url.pathname) {
    case '/api/csrf':
      only(request.method, 'GET');
      return csrfResponse(request, ctx.env, ctx.principal);
    case '/api/tasks':
      return tasksRoute(ctx);
    case '/api/tasks/deleted':
      return deletedTasksRoute(ctx);
    case '/api/flows':
      return flowsRoute(ctx);
    case '/api/entries':
      return entriesRoute(ctx);
    case '/api/notes':
      return notesRoute(ctx);
    case '/api/settings':
      return settingsRoute(ctx);
    case '/api/sync':
      return syncRoute(ctx);
    case '/api/timer/session':
      return timerSessionRoute(ctx);
    case '/api/analytics':
      return analyticsRoute(ctx);
    default:
      throw new HttpError(404, 'not_found');
  }
}

async function tasksRoute(ctx: ApiContext): Promise<Response> {
  const { db } = ctx;
  switch (ctx.request.method) {
    case 'GET':
      return jsonResponse(await getAllTasks(db));
    case 'POST': {
      const body = await ctx.mutate();
      const title = body['title'];
      if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_TITLE) bad('title is required');
      const estimate = body['estimatedMins'];
      const labels = body['labels'];
      const task = await createLocalTask(db, {
        title: title.trim(),
        priority: typeof body['priority'] === 'number' ? body['priority'] : undefined,
        dueDate: isDate(body['dueDate']) ? body['dueDate'] : undefined,
        estimatedMins: typeof estimate === 'number' && Number.isFinite(estimate) && estimate >= 0 ? Math.round(estimate) : undefined,
        labels: Array.isArray(labels) ? labels.filter((label): label is string => typeof label === 'string').slice(0, 50) : undefined,
        description: typeof body['description'] === 'string' ? body['description'].slice(0, MAX_TITLE) : undefined,
      });
      return jsonResponse(task, 201);
    }
    case 'PATCH': {
      const body = await ctx.mutate();
      const taskId = body['taskId'];
      if (!isId(taskId)) bad('taskId required');
      const title = body['title'];
      let newTitle: string | null = null;
      if (typeof title === 'string') {
        if (title.trim() === '') bad('title cannot be empty');
        if (title.length > MAX_TITLE) bad('title is too long');
        newTitle = title.trim();
      }
      let estimate: number | null | undefined;
      if ('estimatedMins' in body) {
        const raw = body['estimatedMins'];
        estimate = raw === null || raw === '' ? null : Number(raw);
        if (estimate !== null && (Number.isNaN(estimate) || estimate < 0 || estimate > 100_000)) bad('Invalid estimatedMins');
      }
      if (newTitle !== null) await updateTaskTitle(db, taskId, newTitle);
      if (estimate !== undefined) await updateTaskEstimate(db, taskId, estimate === null ? null : Math.round(estimate));
      return jsonResponse({ success: true });
    }
    case 'DELETE': {
      const body = await ctx.mutate();
      const taskId = body['taskId'];
      if (!isId(taskId)) bad('taskId required');
      await softDeleteTask(db, taskId);
      return jsonResponse({ success: true });
    }
    default:
      throw methodNotAllowed('GET, POST, PATCH, DELETE');
  }
}

async function deletedTasksRoute(ctx: ApiContext): Promise<Response> {
  only(ctx.request.method, 'GET', 'POST');
  if (ctx.request.method === 'GET') return jsonResponse(await getDeletedTasks(ctx.db));
  const body = await ctx.mutate();
  const taskId = body['taskId'];
  if (!isId(taskId)) bad('taskId required');
  await restoreTask(ctx.db, taskId);
  return jsonResponse({ success: true });
}

async function flowsRoute(ctx: ApiContext): Promise<Response> {
  const { db } = ctx;
  only(ctx.request.method, 'GET', 'PUT');
  if (ctx.request.method === 'GET') {
    const [flows, completedTasks] = await Promise.all([getAllFlows(db), getAllCompletedFlowTasks(db)]);
    return jsonResponse({ flows, completedTasks });
  }
  const body = await ctx.mutate();
  if (!isDate(body['date'])) bad('date is required');
  const date = body['date'];
  switch (body['action']) {
    case 'setFlow':
      await setFlowTaskIds(db, date, idList(body['taskIds'], 'taskIds array required'));
      break;
    case 'addCompleted':
    case 'removeCompleted': {
      const taskId = body['taskId'];
      if (!isId(taskId)) bad('taskId required');
      if (body['action'] === 'addCompleted') await addCompletedFlowTask(db, date, taskId);
      else await removeCompletedFlowTask(db, date, taskId);
      break;
    }
    case 'rollover': {
      const { fromDate, toDate } = body;
      if (!isDate(fromDate) || !isDate(toDate)) bad('fromDate and toDate required');
      await rolloverAllTasks(db, fromDate, toDate);
      break;
    }
    case 'rolloverSelected': {
      const { fromDate, toDate, taskIds } = body;
      if (!isDate(fromDate) || !isDate(toDate) || !Array.isArray(taskIds)) bad('fromDate, toDate, and taskIds required');
      await rolloverSelectedTasks(db, fromDate, toDate, idList(taskIds, 'fromDate, toDate, and taskIds required'));
      break;
    }
    default:
      bad('Unknown action');
  }
  return jsonResponse({ success: true });
}

async function entriesRoute(ctx: ApiContext): Promise<Response> {
  const { db, url } = ctx;
  only(ctx.request.method, 'GET', 'POST');
  if (ctx.request.method === 'GET') {
    const taskId = url.searchParams.get('taskId');
    const date = url.searchParams.get('date');
    if (taskId !== null && !isId(taskId)) bad('Invalid taskId');
    if (date !== null && !isDate(date)) bad('Invalid date');
    if (taskId !== null && date !== null) return jsonResponse(await getEntriesByTaskAndDate(db, taskId, date));
    if (taskId !== null) return jsonResponse(await getEntriesByTask(db, taskId));
    if (date !== null) return jsonResponse(await getEntriesByDate(db, date));
    bad("At least 'taskId' or 'date' query parameter is required");
  }
  const body = await ctx.mutate();
  const { taskId, flowDate, startTime, endTime, durationS, source } = body;
  if (!isId(taskId) || !isDate(flowDate) || !isTimestamp(startTime)) bad('taskId, flowDate, and startTime are required');
  if (endTime !== undefined && endTime !== null && !isTimestamp(endTime)) bad('Invalid endTime');
  if (durationS !== undefined && durationS !== null && !(typeof durationS === 'number' && Number.isFinite(durationS) && durationS >= 0)) bad('Invalid durationS');
  if (source !== undefined && source !== 'timer' && source !== 'manual') bad('Invalid source');
  const created = {
    id: crypto.randomUUID(),
    taskId,
    flowDate,
    startTime,
    endTime: typeof endTime === 'string' ? endTime : null,
    durationS: typeof durationS === 'number' ? Math.round(durationS) : null,
    source: source === 'manual' ? ('manual' as const) : ('timer' as const),
  };
  await createTimeEntry(db, created);
  return jsonResponse(created, 201);
}

async function entryById(ctx: ApiContext, id: string): Promise<Response> {
  if (!isId(id)) throw new HttpError(404, 'not_found', 'Entry not found');
  only(ctx.request.method, 'PUT', 'DELETE');
  const body = await ctx.mutate();
  if (ctx.request.method === 'DELETE') {
    if (!(await deleteTimeEntry(ctx.db, id))) throw new HttpError(404, 'not_found', 'Entry not found');
    return jsonResponse({ success: true });
  }
  const { startTime, endTime } = body;
  if (!isTimestamp(startTime) || !isTimestamp(endTime)) bad('startTime and endTime are required');
  const durationS = Math.floor((Date.parse(endTime) - Date.parse(startTime)) / 1000);
  if (!(await updateTimeEntry(ctx.db, id, { startTime, endTime, durationS }))) throw new HttpError(404, 'not_found', 'Entry not found');
  return jsonResponse({ id, startTime, endTime, durationS });
}

async function notesRoute(ctx: ApiContext): Promise<Response> {
  const { db, url } = ctx;
  only(ctx.request.method, 'GET', 'PUT');
  if (ctx.request.method === 'GET') {
    const taskId = url.searchParams.get('taskId');
    const date = url.searchParams.get('date');
    if (date === null || !isDate(date)) bad('date query param required');
    if (taskId !== null) {
      if (!isId(taskId)) bad('Invalid taskId');
      return jsonResponse((await getNote(db, taskId, date)) ?? { taskId, flowDate: date, content: '' });
    }
    return jsonResponse(await getNotesByDate(db, date));
  }
  const body = await ctx.mutate();
  const { taskId, flowDate, content } = body;
  if (!isId(taskId) || !isDate(flowDate) || typeof content !== 'string') bad('taskId, flowDate, and content are required');
  if (content.length > MAX_NOTE) bad('The note is too long');
  return jsonResponse(await upsertNote(db, taskId, flowDate, content));
}

async function settingsRoute(ctx: ApiContext): Promise<Response> {
  const { db, url } = ctx;
  only(ctx.request.method, 'GET', 'PUT');
  if (ctx.request.method === 'GET') {
    const today = url.searchParams.get('today');
    const planningKey = isDate(today) ? `planning_completed:${today}` : null;
    const keys = [KEY_API_KEY, KEY_LAST_SYNC_AT, 'day_capacity_mins', ...(planningKey === null ? [] : [planningKey])];
    const values = await getSettings(db, keys);
    // Only a sealed key counts (a plaintext one from an older copy is never used).
    const hasKey = isSealed(values.get(KEY_API_KEY));
    const body: SettingsResponse = {
      todoist_api_key: hasKey ? '••••••••' : null,
      has_api_key: hasKey,
      last_sync_at: values.get(KEY_LAST_SYNC_AT) ?? null,
      day_capacity_mins: dayCapacity(values.get('day_capacity_mins') ?? null),
      planning_completed_today: planningKey !== null && values.get(planningKey) === 'true',
    };
    return jsonResponse(body);
  }
  const body = await ctx.mutate();
  const writes = [];
  if ('todoist_api_key' in body) {
    const key = body['todoist_api_key'];
    if (typeof key !== 'string' || key.trim() === '' || key.trim().length > 200) bad('API key is required');
    // The key is stored only sealed under CREDENTIAL_KEY (./credentials.ts); saving the same key writes nothing.
    const credentialKey = await importCredentialKey(ctx.env.CREDENTIAL_KEY);
    if (credentialKey === null) throw new HttpError(503, 'not_configured');
    if ((await openCredential(credentialKey, KEY_API_KEY, await getSetting(db, KEY_API_KEY))) !== key.trim()) {
      // A new key may be another account: the next sync starts over with a full sync, right away.
      writes.push(
        setSettingQuery(db, KEY_API_KEY, await sealCredential(credentialKey, KEY_API_KEY, key.trim())),
        db.delete(settings).where(sql`${settings.key} IN (${KEY_SYNC_TOKEN}, ${KEY_PROJECTS}, ${KEY_CLAIMED_AT}, ${KEY_PENDING})`),
      );
    }
  }
  if ('day_capacity_mins' in body) {
    const mins = Number(body['day_capacity_mins']);
    if (Number.isNaN(mins) || mins < 0 || mins > 1440) bad('Invalid capacity value');
    writes.push(setSettingQuery(db, 'day_capacity_mins', String(mins)));
  }
  if ('planning_completed_date' in body && isDate(body['planning_completed_date'])) {
    writes.push(setSettingQuery(db, `planning_completed:${body['planning_completed_date']}`, 'true'));
  }
  const [first, ...rest] = writes;
  if (first !== undefined) await ctx.db.batch([first, ...rest]);
  return jsonResponse({ success: true });
}

async function syncRoute(ctx: ApiContext): Promise<Response> {
  only(ctx.request.method, 'POST');
  const body = await ctx.mutate();
  const mode = body['mode'] === 'manual' ? 'manual' : 'auto';
  const outcome = await runSync({ db: ctx.db, mode, credentialKey: ctx.env.CREDENTIAL_KEY, fetcher: ctx.fetcher });
  switch (outcome.kind) {
    case 'ok':
      return jsonResponse(outcome.response);
    case 'no_key':
      throw new HttpError(400, 'no_todoist_key');
    case 'key_unreadable':
      throw new HttpError(400, 'todoist_key_unreadable');
    case 'not_configured':
      throw new HttpError(503, 'not_configured');
    case 'todoist':
      throw outcome.failure === 'unauthorized' ? new HttpError(502, 'todoist_unauthorized') : new HttpError(502, 'todoist_unavailable');
  }
}

const STATUSES: readonly TimerSessionStatus[] = ['idle', 'running', 'paused'];
const MODES: readonly TimerSessionMode[] = ['countup', 'pomodoro'];

async function timerSessionRoute(ctx: ApiContext): Promise<Response> {
  const { db } = ctx;
  switch (ctx.request.method) {
    case 'GET':
      return jsonResponse({ session: await getActiveTimerSession(db) });
    case 'PUT': {
      const body = await ctx.mutate();
      const session: Omit<ActiveTimerSession, 'updatedAt'> = {
        taskId: nullableString(body['taskId']),
        flowDate: nullableString(body['flowDate']),
        status: STATUSES.includes(body['status'] as TimerSessionStatus) ? (body['status'] as TimerSessionStatus) : 'idle',
        timerMode: MODES.includes(body['timerMode'] as TimerSessionMode) ? (body['timerMode'] as TimerSessionMode) : 'countup',
        pomodoroTargetS: nullableInt(body['pomodoroTargetS']),
        segmentWallStart: nullableString(body['segmentWallStart']),
        sessionSavedS: Math.max(nullableInt(body['sessionSavedS']) ?? 0, 0),
        pomodoroFinishedTaskId: nullableString(body['pomodoroFinishedTaskId']),
        pomodoroFinishedFlowDate: nullableString(body['pomodoroFinishedFlowDate']),
        pomodoroFinishedTargetS: nullableInt(body['pomodoroFinishedTargetS']),
      };
      await saveActiveTimerSession(db, session);
      return jsonResponse({ success: true });
    }
    case 'DELETE':
      await ctx.mutate();
      await clearActiveTimerSession(db);
      return jsonResponse({ success: true });
    default:
      throw methodNotAllowed('GET, PUT, DELETE');
  }
}

async function analyticsRoute(ctx: ApiContext): Promise<Response> {
  only(ctx.request.method, 'GET');
  const start = ctx.url.searchParams.get('start');
  const end = ctx.url.searchParams.get('end');
  if (start === null && end === null) return jsonResponse(await analyticsDataset(ctx.db, null, null));
  if (!isDate(start) || !isDate(end) || start > end) bad('start and end dates (YYYY-MM-DD) required');
  return jsonResponse(await analyticsDataset(ctx.db, start, end));
}

