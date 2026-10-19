import type { Area, FocusState, PlanningTask } from "./model";

/** Native planning flags never derive from ordinary tags. Legacy hosts still use their labels. */
export function hasPlanningFlag(task: PlanningTask, flag: string): boolean {
  if (flag === "blocked" && task.kind) return false;
  const flags = task.planningFlags ?? task.labels;
  return flags.includes(flag) || (flag === "task" && flags.includes("quick"));
}

/** Steps, standalone tasks and Quick actions can enter the day calendar. */
export function isSchedulable(task: PlanningTask): boolean {
  return task.kind
    ? task.kind === "step" || hasPlanningFlag(task, "task")
    : true;
}

const indexes = new WeakMap<
  readonly PlanningTask[],
  Map<string, PlanningTask>
>();
/**
 * Tasks by ID, built once per task list. Every read and confirmed write replaces the list
 * instead of changing it, so the index of a list never goes stale.
 */
export function taskIndex(
  tasks: readonly PlanningTask[],
): Map<string, PlanningTask> {
  let index = indexes.get(tasks);
  if (!index) {
    index = new Map(tasks.map((task) => [task.id, task]));
    indexes.set(tasks, index);
  }
  return index;
}

export function effectiveArea(task: PlanningTask, tasks: PlanningTask[]): Area {
  if (task.area !== "unassigned") return task.area;
  const byId = taskIndex(tasks);
  const seen = new Set<string>();
  let parent = task.parentId;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const item = byId.get(parent);
    if (!item) break;
    if (item.area !== "unassigned") return item.area;
    parent = item.parentId;
  }
  return "unassigned";
}

function hasAncestor(
  task: PlanningTask,
  byId: Map<string, PlanningTask>,
  matches: (ancestor: PlanningTask) => boolean,
): boolean {
  const seen = new Set<string>();
  let parent = task.parentId;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const ancestor = byId.get(parent);
    if (!ancestor) break;
    if (matches(ancestor)) return true;
    parent = ancestor.parentId;
  }
  return false;
}

export function topLevelChoices(
  tasks: PlanningTask[],
  area: Area,
): PlanningTask[] {
  const byId = taskIndex(tasks);
  return tasks.filter(
    (task) =>
      effectiveArea(task, tasks) === area &&
      (task.stage === "none" ||
        !hasAncestor(task, byId, (ancestor) => ancestor.stage === task.stage)),
  );
}

export function displayedTitle(title: string): string {
  return (
    title
      .replace(/^\[(?:TASK|EXP|COL)\]\s*/u, "")
      // Legacy key suffixes, such as "<k:report dep:draft,data>", show in Todoist only.
      .replace(/\s*<k:[^<>]*>/gu, "")
      .trim() || title
  );
}

export function taskAncestors(
  task: PlanningTask,
  tasks: readonly PlanningTask[],
): PlanningTask[] {
  const byId = taskIndex(tasks);
  const result: PlanningTask[] = [];
  const seen = new Set([task.id]);
  let parent = byId.get(task.parentId);
  while (parent && !seen.has(parent.id)) {
    result.unshift(parent);
    seen.add(parent.id);
    parent = byId.get(parent.parentId);
  }
  return result;
}

export function formattedMinutes(minutes: number): string {
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
    : `${minutes}m`;
}

export function taskFamilyColor(
  task: PlanningTask,
  tasks: PlanningTask[],
): string {
  const root = taskAncestors(task, tasks)[0] ?? task;
  const colors = [
    "#4379ad",
    "#8d65ab",
    "#b27a3b",
    "#39877e",
    "#ab6681",
    "#6a8344",
  ];
  let hash = 0;
  for (const character of root.id)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length]!;
}

export function startDate(
  deadline: string,
  leadDays: number,
  native = false,
): string {
  if (!deadline || leadDays <= 0) return "";
  const date = new Date(`${deadline}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return "";
  // Todoist deadline-before filters use a strict upper bound.
  date.setUTCDate(date.getUTCDate() - (leadDays - (native ? 0 : 1)));
  return date.toISOString().slice(0, 10);
}

export function elapsed(focus: FocusState, now = Date.now()): number {
  const timer = focus.timer;
  if (!timer) return 0;
  const seconds =
    timer.elapsedSeconds +
    (timer.status === "running"
      ? Math.max(0, Math.floor((now - Date.parse(timer.startedAt)) / 1000))
      : 0);
  return timer.mode === "pomodoro" && timer.targetSeconds
    ? Math.min(seconds, timer.targetSeconds)
    : seconds;
}

export function duration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 3600) ? `${Math.floor(value / 3600)}:` : ""}${String(Math.floor(value / 60) % 60).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

/** The calendar date `days` after a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
