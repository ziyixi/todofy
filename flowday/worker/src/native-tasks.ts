/** Native Tasks changes, read only over the named service binding. No credentials or public fetch. */
import { createHttpClient, RpcStatusError, HttpResponseError } from '@ziyixi/proto/http-client';
import { timestampMs } from '@ziyixi/proto/protobuf/wkt';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { CatalogSchema, TasksUiService, type Catalog } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import type { Task } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import { sql } from 'drizzle-orm';
import { batchSql, type Db } from './db.ts';
import type { SyncOutcome } from './sync.ts';
import {
  AUTO_SYNC_MIN_INTERVAL_MS,
  MANUAL_SYNC_MIN_INTERVAL_MS,
  KEY_CLAIMED_AT,
  KEY_LAST_SYNC_AT,
  autoInterval,
  claimSync,
  parseClaim,
  type SyncMode,
} from './sync-control.ts';
import { getSettings, setSettingSql } from './store/settings.ts';
import { hideStatement, projectRefreshStatement, upsertStatements, type TaskUpsertRow } from './store/tasks.ts';

export const KEY_TASKS_CURSOR = 'tasks_sync_cursor';
// v2: the first sync after the project refresh reads the catalog once, which heals every mirrored row.
export const KEY_TASKS_CATALOG = 'tasks_sync_catalog_v2';
export const KEY_TASKS_PENDING = 'tasks_sync_pending';
export const NATIVE_SYNC_PAGE = 100;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
class TasksReadError extends Error {}

function cachedCatalog(text: string | null | undefined): Catalog | undefined {
  if (!text) return undefined;
  try {
    return fromWire(CatalogSchema, JSON.parse(text) as unknown).message;
  } catch {
    return undefined;
  }
}

function isoTime(time: Task['createTime']): string | null {
  return time ? new Date(timestampMs(time)).toISOString() : null;
}

/** Stable imported IDs intentionally retain their existing FlowDay key and historical links. */
function nativeTaskRow(
  task: Task,
  projects: ReadonlyMap<string, { title: string; color: string }>,
  inboxId: string,
  labels: ReadonlyMap<string, string>,
): TaskUpsertRow {
  // An empty project ID is the Inbox, the same as the project marked inbox.
  const projectId = task.projectId || inboxId;
  const project = projects.get(projectId);
  return {
    id: task.id,
    todoist_id: task.id,
    title: task.title,
    description: task.descriptionPreview || task.description || null,
    project_name: project?.title ?? null,
    project_color: project?.color || null,
    priority: task.priority >= 1 && task.priority <= 4 ? 5 - task.priority : 1,
    labels: JSON.stringify(task.labelIds.map((id) => labels.get(id) ?? id)),
    estimated_mins: task.durationMinutes || null,
    is_completed: 0,
    completed_at: isoTime(task.completeTime),
    due_date: task.dueDate || null,
    parent_id: task.parentId || null,
    deadline_date: task.deadline || null,
    created_at: isoTime(task.createTime),
    todoist_project_id: projectId || null,
  };
}

function nativeClient(source: Pick<Fetcher, 'fetch'>) {
  return createHttpClient(TasksUiService, async (call) => {
    // This adapter has no task-writing operation; the entrypoint also enforces the consumer's GET allowlist.
    if (call.httpMethod !== 'GET') throw new TasksReadError('native_tasks_read_only');
    let response: Response;
    try {
      response = await source.fetch(new Request(new URL(call.url, 'https://tasks.internal'), { method: 'GET' }));
    } catch {
      throw new TasksReadError('native_tasks_unreachable');
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new TasksReadError('native_tasks_response_too_large');
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await response.arrayBuffer();
    } catch {
      throw new TasksReadError('native_tasks_read_failed');
    }
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new TasksReadError('native_tasks_response_too_large');
    return new Response(bytes, { status: response.status, headers: response.headers });
  });
}

/** One bounded page, committed together with its cursor. An unchanged page writes only throttle timestamps. */
export async function runNativeSync({
  db,
  mode,
  source,
  now,
}: {
  db: Db;
  mode: SyncMode;
  source: Pick<Fetcher, 'fetch'>;
  now: Date;
}): Promise<SyncOutcome> {
  const at = now.getTime();
  const stored = await getSettings(db, [KEY_TASKS_CURSOR, KEY_TASKS_CATALOG, KEY_TASKS_PENDING, KEY_CLAIMED_AT, KEY_LAST_SYNC_AT]);
  const previousRaw = stored.get(KEY_CLAIMED_AT) ?? null;
  const previous = parseClaim(previousRaw);
  const previousFailed = previous !== null && !(Date.parse(stored.get(KEY_LAST_SYNC_AT) ?? '') >= previous.at);
  const failures = previousFailed ? Math.min(previous.failures + 1, 99) : 0;
  const continuing = stored.get(KEY_TASKS_PENDING) === '1' && !previousFailed;
  const automatic = continuing ? 0 : autoInterval(failures);
  const minimum = continuing ? 0 : mode === 'manual' ? MANUAL_SYNC_MIN_INTERVAL_MS : automatic;
  if (!(await claimSync(db, previousRaw, { at, failures }, minimum)))
    return {
      kind: 'ok',
      response: {
        status: 'throttled',
        changed: 0,
        fullSync: false,
        lastSyncAt: stored.get(KEY_LAST_SYNC_AT) ?? null,
        nextAutoSyncAt: (previous?.at ?? at) + automatic,
      },
    };
  const cursor = stored.get(KEY_TASKS_CURSOR) ?? '';
  const api = nativeClient(source);
  let catalog = cachedCatalog(stored.get(KEY_TASKS_CATALOG));
  let page;
  let catalogRead = false;
  try {
    page = await api.listChanges({ pageToken: cursor, pageSize: NATIVE_SYNC_PAGE });
    if (page.changes.length > NATIVE_SYNC_PAGE || !page.nextPageToken || (page.hasMore && page.nextPageToken === cursor))
      throw new TasksReadError('native_tasks_invalid_page');
    if (!catalog || page.catalogChanged) {
      catalog = await api.getCatalog({ name: 'catalog', includeTaskCounts: false });
      catalogRead = true;
    }
  } catch (error) {
    if (error instanceof TasksReadError || error instanceof RpcStatusError || error instanceof HttpResponseError) return { kind: 'tasks' };
    throw error;
  }
  const latest = new Map(page.changes.filter((change) => change.name.startsWith('tasks/')).map((change) => [change.name.slice(6), change]));
  const projects = new Map(catalog.projects.map((project) => [project.id, project]));
  const inboxId = catalog.projects.find((project) => project.inbox)?.id ?? '';
  const labels = new Map(catalog.labels.map((label) => [label.id, label.title]));
  const rows: TaskUpsertRow[] = [];
  const hidden: string[] = [];
  for (const [id, change] of latest) {
    if (change.deleted || change.task?.completed || change.task?.archived) hidden.push(id);
    else if (change.task && change.task.id === id) rows.push(nativeTaskRow(change.task, projects, inboxId, labels));
    else return { kind: 'tasks' };
  }
  const stamp = now.toISOString();
  // A changed catalog may rename or recolour a project: its tasks change in place, not only this page's.
  const writes = catalogRead
    ? [
        projectRefreshStatement(
          catalog.projects.map(({ id, title, color, inbox }) => ({ id, title, color, inbox })),
        ),
      ]
    : [];
  writes.push(...upsertStatements(rows, stamp));
  if (hidden.length) writes.push(hideStatement(hidden, stamp));
  const settings = [
    setSettingSql(KEY_TASKS_CURSOR, page.nextPageToken),
    setSettingSql(KEY_TASKS_CATALOG, JSON.stringify(toWire(CatalogSchema, catalog))),
    page.hasMore ? setSettingSql(KEY_TASKS_PENDING, '1') : sql`DELETE FROM settings WHERE key = ${KEY_TASKS_PENDING}`,
    setSettingSql(KEY_LAST_SYNC_AT, stamp),
  ];
  const results = await batchSql(db, [...writes, ...settings]);
  const changed = results.slice(0, writes.length).reduce((sum, result) => sum + result.meta.changes, 0);
  return {
    kind: 'ok',
    response: {
      status: page.hasMore ? 'partial' : 'synced',
      changed,
      fullSync: cursor === '',
      lastSyncAt: stamp,
      nextAutoSyncAt: page.hasMore ? at : at + AUTO_SYNC_MIN_INTERVAL_MS,
    },
  };
}
