import {
  createLocalTask,
  deleteTask,
  loadSettings,
  loadTasks,
  syncTasks,
  updateTaskEstimate,
  updateTaskTitle,
  type SettingsView,
  type SyncMode,
  type SyncResult,
} from "@/lib/client/flowday-api";
import { formatLocalDate } from "@/lib/utils/time";
import type { Task } from "@/lib/types/task";

/** Throws (after the banner shows it) when the deletion was not saved. */
export async function deleteTaskOnServer(taskId: string): Promise<void> {
  await deleteTask(taskId);
}

/** Throws (after the banner shows it) when the change was not saved. */
export async function persistTaskPatch(body: {
  taskId: string;
  estimatedMins?: number | null;
  title?: string;
}): Promise<void> {
  if (body.title !== undefined) await updateTaskTitle(body.taskId, body.title);
  if (body.estimatedMins !== undefined) await updateTaskEstimate(body.taskId, body.estimatedMins);
}

export async function loadTasksAndSettings(): Promise<{
  tasks: Task[] | null;
  settings: SettingsView | null;
}> {
  const [tasks, settings] = await Promise.all([loadTasks(), loadSettings()]);
  return { tasks, settings };
}

/**
 * Asks the Worker to bring in Todoist's changes. The automatic sync is quiet (a failure waits for the next
 * attempt); "Sync now" shows its failure.
 */
export async function syncTasksOnServer(mode: SyncMode): Promise<SyncResult> {
  return syncTasks(mode);
}

export async function createLocalTaskOnServer(title: string): Promise<Task | null> {
  try {
    return await createLocalTask(title, formatLocalDate());
  } catch {
    return null;
  }
}
