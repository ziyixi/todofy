import type { Task } from "@/lib/types/task";
import { partitionTasksByDueDate } from "./task-sections";

export const QUICK_TASK_LABEL = "quick";
export const QUICK_TASK_PLACEHOLDER_ID = "__flowday_quick__";

export function isQuickTask(task: Pick<Task, "labels">): boolean {
  return task.labels.some(
    (label) => label.trim().toLowerCase() === QUICK_TASK_LABEL
  );
}

export function isQuickTaskPlaceholderId(taskId: string): boolean {
  return taskId === QUICK_TASK_PLACEHOLDER_ID;
}

export function getQuickTasksForDate(tasks: Task[], date: string): Task[] {
  const candidates = tasks.filter(
    (task) => !task.deletedAt && !task.isCompleted && isQuickTask(task)
  );
  const { dueOnDate, overdue } = partitionTasksByDueDate(candidates, date);
  return [...overdue, ...dueOnDate];
}

export function buildQuickTaskPlaceholder(quickTasks: Task[] = []): Task {
  const estimatedMins = quickTasks.reduce(
    (total, task) => total + (task.estimatedMins ?? 0),
    0
  );

  return {
    id: QUICK_TASK_PLACEHOLDER_ID,
    todoistId: null,
    title: "Quick",
    description: null,
    projectName:
      quickTasks.length > 0
        ? `${quickTasks.length} quick ${quickTasks.length === 1 ? "task" : "tasks"}`
        : "Quick tasks",
    projectColor: null,
    priority: 1,
    labels: [QUICK_TASK_LABEL],
    estimatedMins: estimatedMins > 0 ? estimatedMins : null,
    isCompleted: false,
    completedAt: null,
    dueDate: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}
