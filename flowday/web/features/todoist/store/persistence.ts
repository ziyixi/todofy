import { fetchJson, fetchJsonNoStore, jsonRequestInit } from "@/lib/client/http";
import { formatLocalDate } from "@/lib/utils/time";
import type { Task } from "@/lib/types/task";
import type { SettingsResponse } from "@/features/settings/contracts";
import type { SyncResponse } from "@/features/todoist/contracts";

export async function deleteTaskOnServer(taskId: string) {
  return fetch("/api/tasks", jsonRequestInit("DELETE", { taskId }));
}

export function persistTaskPatch(body: {
  taskId: string;
  estimatedMins?: number | null;
  title?: string;
}) {
  return fetch("/api/tasks", jsonRequestInit("PATCH", body));
}

export async function loadTasksAndSettings(): Promise<{
  tasks: Task[] | null;
  settings: SettingsResponse | null;
}> {
  const [tasks, settings] = await Promise.all([
    fetchJsonNoStore<Task[]>("/api/tasks"),
    fetchJsonNoStore<SettingsResponse>("/api/settings"),
  ]);

  return { tasks, settings };
}

export async function syncTasksOnServer(): Promise<SyncResponse | null> {
  return fetchJson<SyncResponse>("/api/sync", {
    method: "POST",
    cache: "no-store",
  });
}

export async function createLocalTaskOnServer(title: string): Promise<Task | null> {
  return fetchJson<Task>(
    "/api/tasks",
    jsonRequestInit("POST", {
      title,
      dueDate: formatLocalDate(),
    })
  );
}
