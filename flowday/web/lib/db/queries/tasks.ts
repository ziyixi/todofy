import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { getDb } from "../index";
import { completedFlowTasks, flowTasks, tasks } from "../schema";
import { buildMiscTask, isMiscTaskId } from "@/lib/utils/misc-task";
import {
  buildQuickTaskPlaceholder,
  isQuickTaskPlaceholderId,
} from "@/lib/utils/quick-task";
import type { Task, TaskPriority } from "@/lib/types/task";
import { mapTaskRow, type TaskRow, runDbTransaction } from "./shared";

export function getAllTasks(): Task[] {
  const db = getDb();
  const rows = db.select().from(tasks).where(isNull(tasks.deletedAt)).all();
  return rows.map((row) => mapTaskRow(row as TaskRow));
}

// Only returns rows the user deleted in FlowDay itself (or legacy NULL source
// from pre-migration soft-deletes — safer default than hiding them). Sync
// soft-deletes are excluded: the user can restore them in Todoist directly,
// and surfacing every Todoist deletion here overflows the trash dialog.
export function getDeletedTasks(): Task[] {
  const db = getDb();
  const rows = db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.deletedAt),
        or(isNull(tasks.deletedSource), ne(tasks.deletedSource, "sync"))
      )
    )
    .all();
  return rows.map((row) => mapTaskRow(row as TaskRow));
}

export function softDeleteTask(taskId: string): boolean {
  const db = getDb();
  const result = db
    .update(tasks)
    .set({ deletedAt: new Date().toISOString(), deletedSource: "local" })
    .where(eq(tasks.id, taskId))
    .run();
  return result.changes > 0;
}

export function restoreTask(taskId: string): boolean {
  const db = getDb();
  const result = db
    .update(tasks)
    .set({ deletedAt: null, deletedSource: null })
    .where(eq(tasks.id, taskId))
    .run();
  return result.changes > 0;
}

// Marks Todoist-sourced tasks that no longer appear in the latest sync as
// deleted with source='sync'. These auto-restore in upsertTasks if Todoist
// starts returning them again. Returns the number of rows newly marked.
export function markOrphanedTodoistTasksDeleted(activeTodoistIds: string[]): number {
  const db = getDb();
  const now = new Date().toISOString();
  const baseConditions = [isNotNull(tasks.todoistId), isNull(tasks.deletedAt)];
  const result = db
    .update(tasks)
    .set({ deletedAt: now, deletedSource: "sync" })
    .where(
      and(
        ...baseConditions,
        activeTodoistIds.length > 0
          ? notInArray(tasks.todoistId, activeTodoistIds)
          : sql`1=1`
      )
    )
    .run();
  return result.changes;
}

export function removeTaskFromFlows(taskId: string): void {
  const db = getDb();
  db.delete(flowTasks).where(eq(flowTasks.taskId, taskId)).run();
  db.delete(completedFlowTasks).where(eq(completedFlowTasks.taskId, taskId)).run();
}

export function updateTaskEstimate(
  taskId: string,
  estimatedMins: number | null
): boolean {
  const db = getDb();
  const result = db
    .update(tasks)
    .set({ estimatedMins })
    .where(eq(tasks.id, taskId))
    .run();
  return result.changes > 0;
}

export function updateTaskTitle(taskId: string, title: string): boolean {
  const db = getDb();
  const result = db.update(tasks).set({ title }).where(eq(tasks.id, taskId)).run();
  return result.changes > 0;
}

export function upsertTasks(taskList: Task[]): void {
  const db = getDb();
  const now = new Date().toISOString();

  runDbTransaction(() => {
    for (const task of taskList) {
      db.insert(tasks)
        .values({
          id: task.id,
          todoistId: task.todoistId,
          title: task.title,
          description: task.description,
          projectName: task.projectName,
          projectColor: task.projectColor,
          priority: task.priority,
          labels: JSON.stringify(task.labels),
          estimatedMins: task.estimatedMins,
          isCompleted: task.isCompleted ? 1 : 0,
          completedAt: task.completedAt,
          dueDate: task.dueDate,
          createdAt: task.createdAt,
          syncedAt: now,
        })
        .onConflictDoUpdate({
          target: tasks.id,
          set: {
            todoistId: task.todoistId,
            title: task.title,
            description: task.description,
            projectName: task.projectName,
            projectColor: task.projectColor,
            priority: task.priority,
            labels: JSON.stringify(task.labels),
            // Preserve local estimate when Todoist has no duration;
            // if Todoist provides one, it takes precedence.
            estimatedMins:
              task.estimatedMins != null
                ? task.estimatedMins
                : sql`${tasks.estimatedMins}`,
            isCompleted: task.isCompleted ? 1 : 0,
            completedAt: task.completedAt,
            dueDate: task.dueDate,
            syncedAt: now,
            // Auto-restore sync-deleted tasks when Todoist returns them.
            deletedAt: sql`CASE WHEN ${tasks.deletedSource} = 'sync' THEN NULL ELSE ${tasks.deletedAt} END`,
            deletedSource: sql`CASE WHEN ${tasks.deletedSource} = 'sync' THEN NULL ELSE ${tasks.deletedSource} END`,
          },
        })
        .run();
    }
  });
}

export function createLocalTask(input: {
  title: string;
  priority?: number;
  dueDate?: string;
  estimatedMins?: number;
  labels?: string[];
  description?: string;
}): Task {
  const db = getDb();
  const id = `local-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  db.insert(tasks)
    .values({
      id,
      todoistId: null,
      title: input.title,
      description: input.description ?? null,
      projectName: null,
      projectColor: null,
      priority: input.priority ?? 1,
      labels: JSON.stringify(input.labels ?? []),
      estimatedMins: input.estimatedMins ?? null,
      isCompleted: 0,
      completedAt: null,
      dueDate: input.dueDate ?? null,
      createdAt: now,
      syncedAt: null,
      deletedAt: null,
    })
    .run();
  return {
    id,
    todoistId: null,
    title: input.title,
    description: input.description ?? null,
    projectName: null,
    projectColor: null,
    priority: (input.priority ?? 1) as TaskPriority,
    labels: input.labels ?? [],
    estimatedMins: input.estimatedMins ?? null,
    isCompleted: false,
    completedAt: null,
    dueDate: input.dueDate ?? null,
    createdAt: now,
    deletedAt: null,
  };
}

export function getTasksByIds(ids: string[]): Task[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const rows = db.select().from(tasks).where(inArray(tasks.id, ids)).all();
  const persisted = rows.map((row) => mapTaskRow(row as TaskRow));
  const persistedIds = new Set(persisted.map((task) => task.id));
  const syntheticMisc = ids
    .filter((id) => isMiscTaskId(id) && !persistedIds.has(id))
    .map((id) => buildMiscTask(id))
    .filter((task): task is Task => task != null);
  const syntheticQuick = ids
    .filter((id) => isQuickTaskPlaceholderId(id) && !persistedIds.has(id))
    .map(() => buildQuickTaskPlaceholder());
  return [...persisted, ...syntheticMisc, ...syntheticQuick];
}
