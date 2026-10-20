import type { Area, DayPlan, FocusEntry, FocusTaskInfo } from "./model";

/** Logged seconds, in all and by the area each record kept. */
export interface Totals {
  total: number;
  work: number;
  personal: number;
  unassigned: number;
}
/** A week's or month's totals, with the steps completed and how long they took against their estimate. */
export interface RangeStats extends Totals {
  /** Steps completed from the days' queues. */
  stepsDone: number;
  /**
   * The time logged on completed steps that have an estimate and records, as a percentage of those
   * estimates; absent when no completed step has both.
   */
  ratio?: number;
}
/** Where the time went: records grouped by their task's immediate parent. */
export interface TimeGroup {
  /** The parent's ID, or the task's own when it has none. */
  id: string;
  title: string;
  seconds: number;
  /** The area of the group's latest record. */
  area: Area;
}

function totals(entries: readonly FocusEntry[]): Totals {
  const sum: Totals = { total: 0, work: 0, personal: 0, unassigned: 0 };
  for (const entry of entries) {
    sum.total += entry.seconds;
    sum[entry.area] += entry.seconds;
  }
  return sum;
}

/** One day's logged time by area. */
export function dayTotals(day: DayPlan): Totals {
  return totals(day.entries);
}

/**
 * Totals over the days given, the steps completed from their queues, and the time those steps took
 * against their estimates. A step completed on two days (a recurring one) counts as done twice and
 * its estimate twice, against all its records in the range.
 */
export function weekStats(
  days: readonly DayPlan[],
  tasks: Record<string, FocusTaskInfo>,
): RangeStats {
  const entries = days.flatMap((day) => day.entries);
  const done = new Map<string, number>();
  for (const id of days.flatMap((day) => day.completedTaskIds))
    done.set(id, (done.get(id) ?? 0) + 1);
  let estimated = 0;
  let logged = 0;
  for (const [id, times] of done) {
    const minutes = tasks[id]?.estimatedMinutes;
    const seconds = entries
      .filter((entry) => entry.taskId === id)
      .reduce((sum, entry) => sum + entry.seconds, 0);
    if (!minutes || !seconds) continue;
    estimated += minutes * 60 * times;
    logged += seconds;
  }
  return {
    ...totals(entries),
    stepsDone: days.reduce((sum, day) => sum + day.completedTaskIds.length, 0),
    ...(estimated ? { ratio: Math.round((logged / estimated) * 100) } : {}),
  };
}

/** A month's stats: only its own days count, never the neighbouring days its calendar shows. */
export function monthStats(
  days: readonly DayPlan[],
  month: string,
  tasks: Record<string, FocusTaskInfo>,
): RangeStats {
  return weekStats(
    days.filter((day) => day.date.slice(0, 7) === month),
    tasks,
  );
}

/**
 * The days' records grouped by their task's immediate parent, the largest first. A task without a
 * parent is its own group. The parent is often the outcome, but not always.
 */
export function groups(
  days: readonly DayPlan[],
  tasks: Record<string, FocusTaskInfo>,
): TimeGroup[] {
  const byId = new Map<string, TimeGroup>();
  // Records come day by day, each day's in the order the sessions began.
  for (const entry of days.flatMap((day) => day.entries)) {
    const task = tasks[entry.taskId];
    const id = task?.parentId || entry.taskId;
    const title = (task?.parentId ? task.parentTitle : task?.title) ?? "";
    const group = byId.get(id) ?? { id, title, seconds: 0, area: entry.area };
    group.seconds += entry.seconds;
    group.area = entry.area;
    byId.set(id, group);
  }
  return [...byId.values()].sort((a, b) => b.seconds - a.seconds);
}
