/**
 * /api/test/*: the routes the Playwright suite (../../web/__tests__/ui) drives to reset and seed synthetic data.
 * They exist only when E2E_TEST_ROUTES is "true" AND the request was signed in by the loopback dev bypass
 * (http://127.0.0.1 or localhost, no cf-ray header): a production request, which always comes through Cloudflare's
 * edge, can never reach them even if the variable were set. Anywhere else they answer 404 like any unknown path.
 */
import { sql } from 'drizzle-orm';
import type { TaskPriority, TaskRecord } from './model.ts';
import type { Db } from './db.ts';
import type { Env } from './env.ts';
import { flowdayError } from './errors.ts';
import { jsonResponse, readBody, type Principal } from './http.ts';
import { createTimeEntry } from './store/entries.ts';
import { setFlowStatements } from './store/flows.ts';
import { upsertNote } from './store/notes.ts';
import { setSetting } from './store/settings.ts';
import { hideStatement, runStatements, upsertTasks } from './store/tasks.ts';

export function e2eEnabled(env: Env, principal: Principal): boolean {
  return env.E2E_TEST_ROUTES === 'true' && principal.bypassed;
}

interface TaskSeed {
  id: string;
  todoistId?: string | null;
  title: string;
  description?: string | null;
  projectName?: string | null;
  projectColor?: string | null;
  priority?: TaskPriority;
  labels?: string[];
  estimatedMins?: number | null;
  isCompleted?: boolean;
  completedAt?: string | null;
  dueDate?: string | null;
  createdAt?: string;
  deletedAt?: string | null;
}

interface SeedPayload {
  resetFirst?: boolean;
  tasks?: TaskSeed[];
  flows?: Record<string, string[]>;
  completedTasks?: Record<string, string[]>;
  notes?: { taskId: string; flowDate: string; content: string }[];
  timeEntries?: {
    id?: string;
    taskId: string;
    flowDate: string;
    startTime: string;
    endTime?: string | null;
    durationS?: number | null;
    source?: 'timer' | 'manual';
  }[];
  settings?: Record<string, string | number | boolean>;
}

const TABLES = ['flow_task_notes', 'completed_flow_tasks', 'flow_tasks', 'time_entries', 'tasks', 'settings', 'active_timer_session', 'timer_commands'];

export async function clearAll(db: Db): Promise<void> {
  await runStatements(db, TABLES.map((table) => sql.raw(`DELETE FROM ${table}`)));
}

function toTask(seed: TaskSeed): TaskRecord {
  return {
    id: seed.id,
    todoistId: seed.todoistId ?? null,
    title: seed.title,
    description: seed.description ?? null,
    projectName: seed.projectName ?? null,
    projectColor: seed.projectColor ?? null,
    priority: seed.priority ?? 1,
    labels: seed.labels ?? [],
    estimatedMins: seed.estimatedMins ?? null,
    isCompleted: seed.isCompleted ?? false,
    completedAt: seed.completedAt ?? null,
    dueDate: seed.dueDate ?? null,
    createdAt: seed.createdAt ?? new Date().toISOString(),
    deletedAt: seed.deletedAt ?? null,
  };
}

/** Seeds synthetic data. */
export async function seed(db: Db, payload: SeedPayload): Promise<void> {
  if (payload.tasks !== undefined && payload.tasks.length > 0) {
    await upsertTasks(db, payload.tasks.map(toTask));
    for (const task of payload.tasks) {
      if (task.deletedAt !== undefined && task.deletedAt !== null) {
        await db.run(sql`UPDATE tasks SET deleted_at = ${task.deletedAt} WHERE id = ${task.id}`);
      }
    }
  }
  for (const [flowDate, taskIds] of Object.entries(payload.flows ?? {})) {
    await runStatements(db, setFlowStatements(flowDate, taskIds));
  }
  for (const [flowDate, taskIds] of Object.entries(payload.completedTasks ?? {})) {
    for (const taskId of taskIds) {
      await db.run(sql`INSERT INTO completed_flow_tasks (id, flow_date, task_id) VALUES (${crypto.randomUUID()}, ${flowDate}, ${taskId})
        ON CONFLICT DO NOTHING`);
    }
  }
  for (const note of payload.notes ?? []) await upsertNote(db, note.taskId, note.flowDate, note.content);
  for (const entry of payload.timeEntries ?? []) {
    await createTimeEntry(db, {
      id: entry.id ?? crypto.randomUUID(),
      taskId: entry.taskId,
      flowDate: entry.flowDate,
      startTime: entry.startTime,
      endTime: entry.endTime ?? null,
      durationS: entry.durationS ?? null,
      source: entry.source ?? 'timer',
    });
  }
  for (const [key, value] of Object.entries(payload.settings ?? {})) await setSetting(db, key, String(value));
}

export async function e2eRoute(request: Request, db: Db, pathname: string): Promise<Response> {
  switch (`${request.method} ${pathname}`) {
    case 'GET /api/test/health':
      return jsonResponse({ ok: true });
    case 'POST /api/test/reset':
      await clearAll(db);
      return jsonResponse({ ok: true });
    case 'POST /api/test/seed': {
      const payload = (await readBody(request)) as SeedPayload;
      if (payload.resetFirst !== false) await clearAll(db);
      await seed(db, payload);
      return jsonResponse({ ok: true });
    }
    case 'POST /api/test/timer-elapsed': {
      const body = await readBody(request);
      const seconds = body['seconds'];
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 21600) throw flowdayError('BAD_REQUEST');
      await db.run(sql`UPDATE active_timer_session SET segment_wall_start = ${new Date(Date.now() - seconds * 1000).toISOString()} WHERE id = 'main' AND status = 'running'`);
      return jsonResponse({ ok: true });
    }
    case 'POST /api/test/sync-hide': {
      // What a sync does with the tasks Tasks reports completed, archived or deleted.
      const body = await readBody(request);
      const ids = Array.isArray(body['taskIds']) ? body['taskIds'].filter((value): value is string => typeof value === 'string') : [];
      return jsonResponse({ ok: true, changed: await runStatements(db, [hideStatement(ids, new Date().toISOString())]) });
    }
    default:
      throw flowdayError('NOT_FOUND');
  }
}
