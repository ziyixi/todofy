import { addDays } from "./domain";
import { outcomeSteps, planningOutcomes } from "./planning-outcomes";
import type { FlowDayPlan, Language, PlanState, PlanningTask } from "./model";

// The literal label names Todofy's filters already use (Must Start, Candidate If); never created here.
export const WAITING_LABELS = ["waiting", "blocked"];
export const SOMEDAY_LABELS = ["parked", "onhold"];
/** The owner's in-progress label, as Todofy's in-progress deadline query names it. */
export const ACTIVE_LABEL = "active";
const CLARIFIED_LABELS = [...WAITING_LABELS, ...SOMEDAY_LABELS, "quick"];
const DAY_MS = 86_400_000;

/** A task that waits: it has a `waiting` or `blocked` label. */
export function waits(task: PlanningTask): boolean {
  return task.labels.some((label) => WAITING_LABELS.includes(label));
}

/** Whole days since Todoist last changed the task; undefined when that is unknown. */
export function untouchedDays(
  task: PlanningTask,
  now = Date.now(),
): number | undefined {
  const changed = task.updatedAt ? Date.parse(task.updatedAt) : NaN;
  return Number.isFinite(changed)
    ? Math.max(0, Math.floor((now - changed) / DAY_MS))
    : undefined;
}

/**
 * "12 天未变动" / "No change in 12 days", in whole 24-hour periods: any Todoist edit resets it, so
 * it never claims how long the wait has been.
 */
export function untouchedText(task: PlanningTask, language: Language): string {
  const days = untouchedDays(task);
  if (days === undefined) return "";
  if (language === "zh") return days ? `${days} 天未变动` : "1 天内有变动";
  return days
    ? `No change in ${days} ${days === 1 ? "day" : "days"}`
    : "Changed within a day";
}

/** Tasks untouched the longest first; unknown ages come last. */
export function byUntouched(tasks: readonly PlanningTask[]): PlanningTask[] {
  const changed = (task: PlanningTask) =>
    task.updatedAt ? Date.parse(task.updatedAt) : Infinity;
  return [...tasks].sort((a, b) => changed(a) - changed(b) || 0);
}

/** Tasks carrying any of the labels, untouched the longest first; unknown ages come last. */
export function oldestUntouched(
  tasks: readonly PlanningTask[],
  labels: readonly string[],
): PlanningTask[] {
  return byUntouched(
    tasks.filter((task) => task.labels.some((label) => labels.includes(label))),
  );
}

/**
 * Mail tasks still to clarify: top-level tasks in Todofy's mail project with no planning stage,
 * waiting, someday or quick mark. The review task itself is not one of them.
 */
export function inboxToClarify(plan: PlanState): PlanningTask[] {
  if (!plan.inboxProjectId) return [];
  return plan.tasks.filter(
    (task) =>
      task.projectId === plan.inboxProjectId &&
      !task.parentId &&
      task.stage === "none" &&
      task.id !== plan.reviewTaskId &&
      !task.labels.some((label) => CLARIFIED_LABELS.includes(label)),
  );
}

/** Tasks with a deadline but no start-ahead choice (Todofy's missing_lead), earliest deadline first. */
export function withoutLead(tasks: readonly PlanningTask[]): PlanningTask[] {
  return tasks
    .filter((task) => task.missingLead)
    .sort((a, b) => a.deadline.localeCompare(b.deadline));
}

/** Commitments with nothing open scheduled in these days: neither the outcome nor any of its steps. */
export function unscheduledCommitments(
  plan: PlanState,
  days: readonly FlowDayPlan[],
): PlanningTask[] {
  const scheduled = new Set(
    days.flatMap((day) =>
      day.taskIds.filter((id) => !day.completedTaskIds.includes(id)),
    ),
  );
  return planningOutcomes(plan.tasks, plan.managedLabels).filter(
    (task) =>
      task.stage === "committed" &&
      !scheduled.has(task.id) &&
      !outcomeSteps(task, plan.tasks, plan.managedLabels).some((step) =>
        scheduled.has(step.id),
      ),
  );
}

/** This week's commitments, the choices Sunday's review can keep for next week. */
export function weekChoices(plan: PlanState): PlanningTask[] {
  return planningOutcomes(plan.tasks, plan.managedLabels).filter(
    (task) => task.stage === "committed",
  );
}

/** Whether `today` is the last day of the account week starting on `week`. */
export function isLastDay(week: string, today: string): boolean {
  return addDays(week, 6) === today;
}

/** The ISO week (2026-W42) of a YYYY-MM-DD date. */
export function isoWeek(date: string): string {
  const day = new Date(`${date}T12:00:00Z`);
  // The week belongs to the ISO year of its Thursday.
  day.setUTCDate(day.getUTCDate() + 3 - ((day.getUTCDay() + 6) % 7));
  const year = day.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4, 12));
  firstThursday.setUTCDate(
    firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7),
  );
  const week =
    1 + Math.round((day.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Review progress of one ISO week, kept per browser: ticked lines and someday items kept. */
export interface ReviewProgress {
  lines: number[];
  kept: string[];
}
const PROGRESS_PREFIX = "todoist-plus:review:";

export function readProgress(week: string): ReviewProgress {
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(PROGRESS_PREFIX + week) ?? "null",
    ) as Partial<ReviewProgress> | null;
    return {
      lines: Array.isArray(saved?.lines)
        ? saved.lines.filter((line) => typeof line === "number")
        : [],
      kept: Array.isArray(saved?.kept)
        ? saved.kept.filter((id) => typeof id === "string")
        : [],
    };
  } catch {
    return { lines: [], kept: [] };
  }
}

/** Saves this week's progress (IDs and line numbers only) and drops older weeks'. */
export function saveProgress(week: string, progress: ReviewProgress) {
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index--) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(PROGRESS_PREFIX) && key !== PROGRESS_PREFIX + week)
        window.localStorage.removeItem(key);
    }
    window.localStorage.setItem(
      PROGRESS_PREFIX + week,
      JSON.stringify(progress),
    );
  } catch {
    // Storage may be unavailable; the review still works for this visit.
  }
}
