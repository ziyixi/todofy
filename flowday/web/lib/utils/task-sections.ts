import { isBefore } from "date-fns";

export interface DueDateSections<T> {
  dueOnDate: T[];
  overdue: T[];
}

export function partitionTasksByDueDate<T extends { dueDate: string | null }>(
  tasks: T[],
  anchorDate: string
): DueDateSections<T> {
  const anchorStart = new Date(anchorDate + "T00:00:00");
  const nextDayStart = new Date(anchorStart.getTime() + 86_400_000);
  const dueOnDate: T[] = [];
  const overdue: T[] = [];

  for (const task of tasks) {
    if (!task.dueDate) continue;
    const due = new Date(task.dueDate + "T00:00:00");
    if (isBefore(due, anchorStart)) {
      overdue.push(task);
    } else if (isBefore(due, nextDayStart)) {
      dueOnDate.push(task);
    }
  }

  return { dueOnDate, overdue };
}
