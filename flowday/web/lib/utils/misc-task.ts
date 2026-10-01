import type { Task } from "@/lib/types/task";

export const MISC_TASK_ID_PREFIX = "__flowday_misc__:";
export const MISC_TASK_TITLE = "Misc time";
export const MISC_TASK_PROJECT_NAME = "Misc";

export function buildMiscTaskId(flowDate: string): string {
  return `${MISC_TASK_ID_PREFIX}${flowDate}`;
}

export function isMiscTaskId(taskId: string | null | undefined): taskId is string {
  return typeof taskId === "string" && taskId.startsWith(MISC_TASK_ID_PREFIX);
}

export function getMiscTaskDate(taskId: string | null | undefined): string | null {
  if (!isMiscTaskId(taskId)) return null;
  const flowDate = taskId.slice(MISC_TASK_ID_PREFIX.length);
  return /^\d{4}-\d{2}-\d{2}$/.test(flowDate) ? flowDate : null;
}

export function buildMiscTaskTitle(flowDate: string): string {
  return `${MISC_TASK_TITLE} · ${flowDate}`;
}

export function buildMiscTask(taskId: string): Task | null {
  const flowDate = getMiscTaskDate(taskId);
  if (!flowDate) return null;

  return {
    id: taskId,
    todoistId: null,
    title: buildMiscTaskTitle(flowDate),
    description: null,
    projectName: MISC_TASK_PROJECT_NAME,
    projectColor: null,
    priority: 1,
    labels: [],
    estimatedMins: null,
    isCompleted: false,
    completedAt: null,
    dueDate: flowDate,
    createdAt: `${flowDate}T00:00:00.000Z`,
    deletedAt: null,
  };
}
