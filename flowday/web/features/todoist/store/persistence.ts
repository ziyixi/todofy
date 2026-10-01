import { apiGetOrNull, apiSend } from "@/lib/client/http";
import { formatLocalDate } from "@/lib/utils/time";
import type { Task } from "@/lib/types/task";
import type { SettingsResponse } from "@/features/settings/contracts";
import type { SyncMode, SyncResponse } from "@/features/todoist/contracts";

/** Throws (after the banner shows it) when the deletion was not saved. */
export async function deleteTaskOnServer(taskId: string): Promise<void> {
  await apiSend("DELETE", "/api/tasks", { taskId });
}

/** Throws (after the banner shows it) when the change was not saved. */
export async function persistTaskPatch(body: {
  taskId: string;
  estimatedMins?: number | null;
  title?: string;
}): Promise<void> {
  await apiSend("PATCH", "/api/tasks", body);
}

export async function loadTasksAndSettings(): Promise<{
  tasks: Task[] | null;
  settings: SettingsResponse | null;
}> {
  const [tasks, settings] = await Promise.all([
    apiGetOrNull<Task[]>("/api/tasks"),
    apiGetOrNull<SettingsResponse>("/api/settings"),
  ]);

  return { tasks, settings };
}

/**
 * Asks the Worker to bring in Todoist's changes. The automatic sync is quiet (a failure waits for the next
 * attempt); "Sync now" shows its failure.
 */
export async function syncTasksOnServer(mode: SyncMode): Promise<SyncResponse> {
  return apiSend<SyncResponse>("POST", "/api/sync", { mode }, { quiet: mode === "auto" });
}

export async function createLocalTaskOnServer(title: string): Promise<Task | null> {
  try {
    return await apiSend<Task>("POST", "/api/tasks", { title, dueDate: formatLocalDate() });
  } catch {
    return null;
  }
}
