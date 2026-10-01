import {
  getSetting,
  setSetting,
} from "@/lib/db/queries/settings";
import {
  markOrphanedTodoistTasksDeleted,
  upsertTasks,
} from "@/lib/db/queries/tasks";
import { fetchTodoistTasks, fetchTodoistProjects } from "./api";
import { todoistColorToHex } from "./colors";
import type { Task, TaskPriority } from "@/lib/types/task";

export async function syncTodoistToDb(): Promise<{ taskCount: number; error?: string }> {
  const apiKey = getSetting("todoist_api_key");
  if (!apiKey) {
    return { taskCount: 0, error: "No Todoist API key configured" };
  }

  const [apiTasks, apiProjects] = await Promise.all([
    fetchTodoistTasks(apiKey),
    fetchTodoistProjects(apiKey),
  ]);

  // Build project lookup
  const projectMap = new Map(
    apiProjects.map((p) => [p.id, { name: p.name, color: todoistColorToHex(p.color) }])
  );

  // Transform to our Task type
  const transformedTasks: Task[] = apiTasks.map((t) => {
    const project = projectMap.get(t.project_id);
    let estimatedMins: number | null = null;
    if (t.duration) {
      if (t.duration.unit === "minute") {
        estimatedMins = t.duration.amount;
      } else if (t.duration.unit === "day") {
        estimatedMins = t.duration.amount * 480; // 8-hour workday
      }
    }

    // Extract just the date portion from due.date (could be "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS")
    let dueDate: string | null = null;
    if (t.due?.date) {
      dueDate = t.due.date.slice(0, 10);
    }

    return {
      id: t.id,
      todoistId: t.id,
      title: t.content,
      description: t.description || null,
      projectName: project?.name ?? null,
      projectColor: project?.color ?? null,
      priority: (t.priority as TaskPriority) || 1,
      labels: t.labels ?? [],
      estimatedMins,
      isCompleted: t.is_completed,
      completedAt: t.completed_at,
      dueDate,
      createdAt: t.created_at,
      deletedAt: null,
    };
  });

  // Persist current Todoist state, then reconcile: any task we previously
  // tracked from Todoist that no longer appears in the response was either
  // deleted or completed in Todoist. Mark it sync-deleted so it disappears
  // from FlowDay's UI; if it ever reappears, upsertTasks auto-restores it.
  upsertTasks(transformedTasks);
  markOrphanedTodoistTasksDeleted(apiTasks.map((t) => t.id));
  setSetting("last_sync_at", new Date().toISOString());

  return { taskCount: transformedTasks.length };
}
