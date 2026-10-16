import { startDate, taskIndex } from "./domain";
import { words } from "./i18n";
import { monthDay, readableDate, shortDay } from "./PlanningCalendar";
import type { FlowDayPlan, Language, PlanState, PlanningTask } from "./model";

/** The owner's literal in-progress label, as Todofy's Active Deadlines filter names it; never created. */
export const ACTIVE_LABEL = "active";

/**
 * Where a task with a deadline stands in its life: in progress, past its deadline, in its start
 * window or without a start-ahead choice. Todofy's must_start and missing_lead decide the last
 * three unchanged; `days` is calendar days to the deadline, negative once it has passed.
 */
export interface DeadlineState {
  kind: "active" | "past" | "window" | "noLead";
  days: number;
}

const DAY_MS = 86_400_000;
/** Whole calendar days from `today` to `date`, both YYYY-MM-DD. */
function daysUntil(date: string, today: string): number {
  return Math.round(
    (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) /
      DAY_MS,
  );
}

const inProgress = (task: PlanningTask) =>
  task.labels.includes(ACTIVE_LABEL) && !task.labels.includes("blocked");

/**
 * The first matching row of the design's table (§1.1): undefined for no deadline, a parked task,
 * or one whose start window has not opened yet, which only its details mention.
 */
export function deadlineState(
  task: PlanningTask,
  today: string,
): DeadlineState | undefined {
  if (!task.deadline || task.labels.includes("parked")) return undefined;
  const days = daysUntil(task.deadline, today);
  if (inProgress(task)) return { kind: "active", days };
  if (task.mustStart) return { kind: days < 0 ? "past" : "window", days };
  if (task.missingLead) return { kind: "noLead", days };
  return undefined;
}

export interface DeadlineRow {
  task: PlanningTask;
  state: DeadlineState;
}
/** The Deadlines list: earliest deadline first, then the higher priority (the API's 4 is P1). */
export function deadlineRows(
  tasks: readonly PlanningTask[],
  today: string,
): DeadlineRow[] {
  const rows: DeadlineRow[] = [];
  for (const task of tasks) {
    const state = deadlineState(task, today);
    if (state) rows.push({ task, state });
  }
  return rows.sort(
    (a, b) =>
      a.task.deadline.localeCompare(b.task.deadline) ||
      b.task.priority - a.task.priority,
  );
}

/** Something that should have started: past its deadline or in its start window. */
export function isDue(state: DeadlineState): boolean {
  return state.kind === "past" || state.kind === "window";
}

/** "Mark in progress" writes the literal label only where the account already has it. */
export function canMarkActive(plan: Pick<PlanState, "availableLabels">) {
  return plan.availableLabels.some((label) => label.label === ACTIVE_LABEL);
}

/**
 * Due tasks with nothing open planned in these queues: neither the task nor any of its steps.
 * Each task is counted once.
 */
export function unplannedDue(
  tasks: readonly PlanningTask[],
  days: readonly FlowDayPlan[],
  today: string,
): { past: number; window: number } {
  const scheduled = new Set(
    days.flatMap((day) =>
      day.taskIds.filter((id) => !day.completedTaskIds.includes(id)),
    ),
  );
  const byId = taskIndex(tasks);
  // A task is planned once it or any open descendant is in a queue.
  const planned = new Set<string>();
  for (const id of scheduled) {
    const seen = new Set<string>();
    for (
      let task = byId.get(id);
      task && !seen.has(task.id);
      task = byId.get(task.parentId)
    ) {
      seen.add(task.id);
      planned.add(task.id);
    }
  }
  const counts = { past: 0, window: 0 };
  for (const task of tasks) {
    const state = deadlineState(task, today);
    if (state && isDue(state) && !planned.has(task.id))
      counts[state.kind as "past" | "window"]++;
  }
  return counts;
}

/** A status in two parts, so that only the "days past" part is drawn in --plus-danger. */
export interface StatusText {
  text: string;
  /** Appended after the text in --plus-danger. */
  danger?: string;
}

function daysWord(days: number, language: Language) {
  return language === "zh"
    ? `${days} 天`
    : `${days} ${days === 1 ? "day" : "days"}`;
}
/** "已过 2 天" / "2 days past". */
function pastText(days: number, language: Language) {
  return language === "zh"
    ? `已过 ${daysWord(-days, language)}`
    : `${daysWord(-days, language)} past`;
}
/** "今天截止", "明天截止" or "还剩 5 天". */
function leftText(days: number, language: Language) {
  if (days === 0) return language === "zh" ? "今天截止" : "Deadline today";
  if (days === 1) return language === "zh" ? "明天截止" : "Deadline tomorrow";
  return language === "zh"
    ? `还剩 ${daysWord(days, language)}`
    : `${daysWord(days, language)} left`;
}
/** "已过截止 2 天" / "2 days past deadline". */
function pastDeadlineText(days: number, language: Language) {
  return language === "zh"
    ? `已过截止 ${daysWord(-days, language)}`
    : `${daysWord(-days, language)} past deadline`;
}
/** "已到启动窗口 · 还剩 5 天" / "Start window open · 5 days left". */
function windowText(days: number, language: Language) {
  return `${language === "zh" ? "已到启动窗口" : "Start window open"} · ${leftText(days, language)}`;
}
/** "进行中 · 还剩 12 天", or "进行中 · " and "已过 3 天" in --plus-danger. */
function activeStatus(days: number, language: Language): StatusText {
  const prefix = language === "zh" ? "进行中 · " : "In progress · ";
  return days < 0
    ? { text: prefix, danger: pastText(days, language) }
    : { text: prefix + leftText(days, language) };
}
/** "10月22日截止" / "Deadline Oct 22", or today and tomorrow in words. */
function deadlineDateText(
  deadline: string,
  today: string,
  language: Language,
): string {
  const days = daysUntil(deadline, today);
  if (days === 0 || days === 1) return leftText(days, language);
  return language === "zh"
    ? `${monthDay(deadline, language)}截止`
    : `Deadline ${monthDay(deadline, language)}`;
}

/** One row's status in the Deadlines list. */
export function rowStatus(
  { task, state }: DeadlineRow,
  today: string,
  language: Language,
): StatusText {
  if (state.kind === "past")
    return { text: "", danger: pastText(state.days, language) };
  if (state.kind === "window") return { text: leftText(state.days, language) };
  // A @blocked task can be past its deadline without a start-ahead choice.
  if (state.kind === "noLead")
    return state.days < 0
      ? { text: "", danger: pastText(state.days, language) }
      : { text: deadlineDateText(task.deadline, today, language) };
  return activeStatus(state.days, language);
}

/** The deadline's full date, for a status's tooltip: "截止日期：10月20日周二". */
export function deadlineTitle(deadline: string, language: Language): string {
  return language === "zh"
    ? `截止日期：${readableDate(deadline, language)}`
    : `Deadline: ${readableDate(deadline, language)}`;
}

/**
 * What a status adds for screen readers: the deadline's weekday where the status already shows
 * its date ("11月30日截止，周一"), otherwise its full date ("2 days past, Sun, Oct 11").
 */
export function spokenDeadline(
  status: StatusText,
  deadline: string,
  language: Language,
): string {
  const shown = (status.text + (status.danger ?? "")).includes(
    monthDay(deadline, language),
  );
  const date = shown
    ? shortDay(deadline, language)
    : readableDate(deadline, language);
  return (language === "zh" ? "，" : ", ") + date;
}

/** "12 天未变动 · 10月22日截止" in Waiting, or "已过截止 2 天" in --plus-danger once past. */
export function waitingDeadline(
  task: PlanningTask,
  today: string,
  language: Language,
): StatusText | undefined {
  if (!task.deadline) return undefined;
  const days = daysUntil(task.deadline, today);
  if (days < 0) return { text: "", danger: pastDeadlineText(days, language) };
  return { text: deadlineDateText(task.deadline, today, language) };
}

/**
 * The sentence under a task's deadline fields, from the values shown there: the start window's
 * date before it opens, then how long is left, past or in progress. None without a deadline, or
 * without a start-ahead choice, which the select already says.
 */
export function detailStatus(
  task: PlanningTask,
  deadline: string,
  leadDays: number,
  today: string,
  language: Language,
): StatusText | undefined {
  if (!deadline) return undefined;
  const days = daysUntil(deadline, today);
  if (inProgress(task)) return activeStatus(days, language);
  if (days < 0) return { text: "", danger: pastDeadlineText(days, language) };
  if (!leadDays) return undefined;
  const start = startDate(deadline, leadDays);
  if (today < start)
    return {
      text: `${words(language).starts}: ${readableDate(start, language)}`,
    };
  return { text: windowText(days, language) };
}

/**
 * A due card's start-window mark, which its icon's tooltip and the end of its accessible name say:
 * "已到启动窗口 · 还剩 5 天" or "已过截止 2 天".
 */
export function cardTitle(state: DeadlineState, language: Language): string {
  if (state.kind === "past") return pastDeadlineText(state.days, language);
  return windowText(state.days, language);
}

/** The quiet Focus line: "1 项已过截止、1 项已到启动窗口，这周还没有安排". */
export function unplannedText(
  counts: { past: number; window: number },
  language: Language,
): string {
  const zh = language === "zh";
  const parts = [
    counts.past > 0 &&
      (zh ? `${counts.past} 项已过截止` : `${counts.past} past deadline`),
    counts.window > 0 &&
      (zh
        ? `${counts.window} 项已到启动窗口`
        : `${counts.window} in ${counts.window === 1 ? "its" : "their"} start window`),
  ].filter(Boolean);
  return zh
    ? `${parts.join("、")}，这周还没有安排`
    : `${parts.join(" and ")}, not planned this week`;
}
