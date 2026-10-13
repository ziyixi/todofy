import type { Area, FocusState, PlanningTask } from "./model";

export function effectiveArea(task: PlanningTask, tasks: PlanningTask[]): Area {
  if (task.area !== "unassigned") return task.area;
  const byId = new Map(tasks.map((item) => [item.id, item]));
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
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.filter(
    (task) =>
      effectiveArea(task, tasks) === area &&
      (task.stage === "none" ||
        !hasAncestor(task, byId, (ancestor) => ancestor.stage === task.stage)),
  );
}

export function topLevelBets(
  tasks: PlanningTask[],
  area: Area,
): PlanningTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.filter(
    (task) =>
      task.bet &&
      effectiveArea(task, tasks) === area &&
      !hasAncestor(task, byId, (ancestor) => ancestor.bet),
  );
}

export function executionChoices(tasks: PlanningTask[]): PlanningTask[] {
  const parents = new Set(tasks.map((task) => task.parentId).filter(Boolean));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.filter((task) => {
    if (parents.has(task.id)) return false;
    if (task.labels.includes("quick") || task.stage === "committed" || task.bet)
      return true;
    let parent = task.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const item = byId.get(parent);
      if (!item) break;
      if (item.stage === "committed" || item.bet) return true;
      parent = item.parentId;
    }
    return false;
  });
}

export function displayedTitle(title: string): string {
  return (
    title
      .replace(/^\[(?:TASK|EXP|COL)\]\s*/u, "")
      .replace(/\s*<k:[A-Za-z0-9_.:-]+>/gu, "")
      .trim() || title
  );
}

export function moveTask(ids: string[], id: string, offset: number): string[] {
  const from = ids.indexOf(id);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  const result = [...ids];
  result.splice(from, 1);
  result.splice(to, 0, id);
  return result;
}

export function startDate(deadline: string, leadDays: number): string {
  if (!deadline || leadDays <= 0) return "";
  const date = new Date(`${deadline}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return "";
  // Todoist deadline-before filters use a strict upper bound.
  date.setUTCDate(date.getUTCDate() - (leadDays - 1));
  return date.toISOString().slice(0, 10);
}

export function elapsed(focus: FocusState, now = Date.now()): number {
  const timer = focus.timer;
  if (!timer) return 0;
  return (
    timer.elapsedSeconds +
    (timer.status === "running"
      ? Math.max(0, Math.floor((now - Date.parse(timer.startedAt)) / 1000))
      : 0)
  );
}

export function duration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 3600) ? `${Math.floor(value / 3600)}:` : ""}${String(Math.floor(value / 60) % 60).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function todoistTaskUrl(id: string): string {
  return `https://app.todoist.com/app/task/${encodeURIComponent(id)}`;
}
