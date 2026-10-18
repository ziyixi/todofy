import { addDays, hasPlanningFlag, isSchedulable } from "./domain";
import { localDate } from "./mail";
import {
  committedOutcomes,
  isParked,
  outcomeSteps,
  PARKED_LABEL,
} from "./planning-outcomes";
import type { FlowDayPlan, Language, PlanState, PlanningTask } from "./model";

// The literal label names Todofy's filters already use (Must Start, Candidate If); never created here.
export const WAITING_LABELS = ["waiting", "blocked"];
export const SOMEDAY_LABELS = [PARKED_LABEL, "onhold"];
/** The owner's in-progress label, as Todofy's in-progress deadline query names it. */
export const ACTIVE_LABEL = "active";
/** The owner's quick-task label, as the native Quick / Ops filter names it. */
export const QUICK_LABEL = "quick";
const CLARIFIED_LABELS = [...WAITING_LABELS, ...SOMEDAY_LABELS, QUICK_LABEL];
const DAY_MS = 86_400_000;

/** A task explicitly marked waiting or blocked. */
export function waits(task: PlanningTask): boolean {
  return WAITING_LABELS.some((flag) => hasPlanningFlag(task, flag));
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
    tasks.filter((task) => labels.some((flag) => hasPlanningFlag(task, flag))),
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
      !CLARIFIED_LABELS.some((flag) => hasPlanningFlag(task, flag)),
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
  return committedOutcomes(plan).filter(
    (task) =>
      !scheduled.has(task.id) &&
      !outcomeSteps(task, plan.tasks, plan.managedLabels).some((step) =>
        scheduled.has(step.id),
      ),
  );
}

/** This week's commitments, the choices Sunday's review can keep for next week. */
export function weekChoices(plan: PlanState): PlanningTask[] {
  return committedOutcomes(plan);
}

/**
 * The tasks the native Quick / Ops filter (@quick & (no date | 3 days)) shows, read as widely as
 * Todofy's gate does before it hides that filter: the literal `quick` label, and no due date, or a
 * due day or a deadline at most two days after `today` (the account's date), overdue included. A
 * due time in a fixed zone (ending in Z) counts on its day in the account's time zone. Dated ones
 * first, by day, then the undated; the higher priority first within each.
 */
export function quickTasks(
  plan: Pick<PlanState, "tasks" | "timezone">,
  today: string,
): PlanningTask[] {
  const last = addDays(today, 2);
  const dueDay = (due: string) =>
    due.endsWith("Z") ? localDate(due, plan.timezone) : due.slice(0, 10);
  return plan.tasks
    .filter(
      (task) =>
        hasPlanningFlag(task, QUICK_LABEL) &&
        (!task.due ||
          dueDay(task.due) <= last ||
          (Boolean(task.deadline) && task.deadline <= last)),
    )
    .map((task) => ({ task, day: task.due ? dueDay(task.due) : "" }))
    .sort(
      (a, b) =>
        Number(!a.day) - Number(!b.day) ||
        a.day.localeCompare(b.day) ||
        b.task.priority - a.task.priority,
    )
    .map(({ task }) => task);
}

/**
 * Week's Quick tasks: none already queued open in a shown day (the calendar has it), among the
 * next steps shown above, or set aside (Review's Parked lane has it).
 */
export function quickTray(
  plan: Pick<
    PlanState,
    "tasks" | "timezone" | "availableLabels" | "nativePlanning"
  >,
  today: string,
  days: readonly FlowDayPlan[],
  steps: readonly PlanningTask[],
): PlanningTask[] {
  const queued = new Set(
    days.flatMap((day) =>
      day.taskIds.filter((id) => !day.completedTaskIds.includes(id)),
    ),
  );
  const shown = new Set(steps.map((task) => task.id));
  return quickTasks(plan, today).filter(
    (task) =>
      isSchedulable(task) &&
      !queued.has(task.id) &&
      !shown.has(task.id) &&
      !isParked(task, plan),
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

/** Review progress of one account week: ticked lines and someday items kept. IDs only. */
export interface ReviewProgress {
  lines: number[];
  kept: string[];
}
