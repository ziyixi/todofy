import type {
  GtdReport,
  GtdTaskProgress,
} from "@ziyixi/proto/tasks/ui/v1/gtd_pb";
import {
  addDays,
  formattedMinutes,
  mondayOf,
  monthStart,
} from "@ziyixi/planning-ui/domain";

export type GtdTab = "overview" | "completion" | "time";
export type GtdPeriod = "week" | "month";
export function reportRange(period: GtdPeriod, day: string): [string, string] {
  return period === "week"
    ? [mondayOf(day), addDays(mondayOf(day), 6)]
    : [monthStart(day), addDays(monthStart(day, 1), -1)];
}
export function dateRangeLabel(
  start: string,
  end: string,
  period: GtdPeriod,
): string {
  const format = (day: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(
      new Date(`${day}T12:00:00Z`),
    );
  if (period === "month")
    return format(start, { month: "long", year: "numeric" });
  const first = format(start, {
    month: "short",
    day: "numeric",
    ...(start.slice(0, 4) !== end.slice(0, 4) ? { year: "numeric" } : {}),
  });
  const last = format(end, {
    ...(start.slice(0, 7) !== end.slice(0, 7) ? { month: "short" } : {}),
    day: "numeric",
  });
  return `${first} – ${last}, ${end.slice(0, 4)}`;
}
export const loggedTime = (seconds: number) =>
  formattedMinutes(Math.floor(seconds / 60));
export const percentage = (done: number, all: number) =>
  all ? Math.round((done / all) * 100) : 0;
export const areaLabel = (area: string) =>
  area === "work" ? "Work" : area === "personal" ? "Personal" : "No area";
export function completedDayLabel(day: string, today: string): string {
  if (!day) return "Not completed";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    weekday: "short",
    ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}),
  }).format(new Date(`${day}T12:00:00Z`));
}
/** A presentation group keeps a Step's parent visible even if only the Step occurred in this range. */
export interface ProgressGroup {
  id: string;
  title: string;
  task?: GtdTaskProgress;
  steps: GtdTaskProgress[];
}
export function progressGroups(
  report: GtdReport,
  routine = false,
): ProgressGroup[] {
  const byId = new Map<string, ProgressGroup>();
  const selected = report.tasks.filter((task) => task.routine === routine);
  for (const task of selected.filter(
    (item) =>
      item.kind === "task" && (item.planned || item.completionCount > 0),
  ))
    byId.set(task.taskId, {
      id: task.taskId,
      title: task.title,
      task,
      steps: [],
    });
  for (const step of selected.filter(
    (item) =>
      item.kind === "step" && (item.planned || item.completionCount > 0),
  )) {
    const id = step.parentId || step.taskId;
    const parent = byId.get(id) ?? {
      id,
      title: step.parentTitle || step.title,
      task: selected.find((item) => item.taskId === id && item.kind === "task"),
      steps: [],
    };
    parent.steps.push(step);
    byId.set(id, parent);
  }
  return [...byId.values()].sort(
    (a, b) =>
      Number(Boolean(b.task?.completed)) - Number(Boolean(a.task?.completed)) ||
      a.title.localeCompare(b.title),
  );
}
