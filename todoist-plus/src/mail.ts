import { addDays, displayedTitle } from "./domain";
import { pendingTask } from "./plan-updates";
import { inboxToClarify } from "./weekly-review";
import type {
  FlowDayPlan,
  FocusState,
  Language,
  MailCategory,
  MailItem,
  PlanState,
  PlanningTask,
  TaskDependency,
} from "./model";

/** Task IDs per LookupMailItems and per DeleteMailItems request, Todofy's bound. */
export const MAIL_BATCH = 200;
/** The owner's mail categories: at most this many. */
export const MAX_CATEGORIES = 4;

/** One Mailbox row: a mail Todofy summarised and its task. */
export interface MailRow {
  task: PlanningTask;
  mail: MailItem;
}

/** Todoist's API priority of a domain priority: P1 (1) is 4, P4 is 1. */
export function apiPriority(priority: number): number {
  return 5 - priority;
}

/**
 * The mail project tasks the Mailbox asks Todofy about: those the weekly review counts as still
 * to clarify. Todofy answers which of them a Mail Hero event created.
 */
export function mailboxCandidates(plan: PlanState): PlanningTask[] {
  return inboxToClarify(plan);
}

/**
 * The rows, newest first, and how many candidates are other tasks (the owner's own, reminders,
 * mail from before the ledger). Rows plus others is the weekly review's "Mail to clarify".
 */
export function mailboxRows(
  candidates: readonly PlanningTask[],
  mail: ReadonlyMap<string, MailItem | null>,
): { rows: MailRow[]; others: number } {
  const rows = candidates.flatMap((task) => {
    const item = mail.get(task.id);
    return item ? [{ task, mail: item }] : [];
  });
  rows.sort(
    (a, b) =>
      b.mail.receivedAt.localeCompare(a.mail.receivedAt) ||
      a.task.id.localeCompare(b.task.id),
  );
  return { rows, others: candidates.length - rows.length };
}

/** What the client knows of the owner's plan beyond the task itself. */
export interface PlanContext {
  tasks: readonly PlanningTask[];
  /** Every FlowDay day queue read on this visit. */
  days: readonly FlowDayPlan[];
  focus: FocusState;
  /** Cards with a write not yet confirmed (App's pending set). */
  pending: ReadonlySet<string>;
  /** Every dependency of the last complete read (ReadPlan's FULL view). */
  dependencies: readonly TaskDependency[];
}

/**
 * Whether the owner changed or planned a mail task, so that Delete all keeps it: any label, a
 * priority above P4, a date, deadline or estimate, a step, a dependency either way, a place in a
 * FlowDay day queue, a running Focus timer, or a write still on its way. Todofy checks again on a
 * fresh read, with the comments it alone sees and the dependencies as it holds them.
 */
export function touched(task: PlanningTask, context: PlanContext): boolean {
  return (
    task.labels.length > 0 ||
    task.priority !== apiPriority(4) ||
    Boolean(task.due || task.deadline || task.estimatedMinutes) ||
    context.tasks.some((other) => other.parentId === task.id) ||
    context.dependencies.some(
      (link) => link.taskId === task.id || link.prerequisiteId === task.id,
    ) ||
    [context.focus, ...context.days].some((day) =>
      day.taskIds.includes(task.id),
    ) ||
    context.focus.timer?.taskId === task.id ||
    context.pending.has(pendingTask(task.id))
  );
}

/**
 * What Delete all would delete from these rows, frozen when its confirmation opens: the oldest
 * untouched ones, at most MAIL_BATCH; the rows kept because they were touched; and how many
 * untouched ones wait for a later batch.
 */
export function deletionBatch(
  rows: readonly MailRow[],
  isTouched: (task: PlanningTask) => boolean,
): { taskIds: string[]; kept: MailRow[]; later: number } {
  const kept = rows.filter((row) => isTouched(row.task));
  const deletable = rows.filter((row) => !isTouched(row.task)).reverse();
  return {
    taskIds: deletable.slice(0, MAIL_BATCH).map((row) => row.task.id),
    kept,
    later: Math.max(0, deletable.length - MAIL_BATCH),
  };
}

/**
 * Delete all's frozen batch again, from the plan as it is now, just before it is sent (and before
 * each Try again). What Todofy cannot see, a FlowDay estimate or day, the timer or a write on its
 * way, may have touched a mail since the confirmation opened: it leaves the batch and joins the
 * kept ones. No ID is ever added, and one no longer listed stays for Todofy to settle (gone
 * already, or moved elsewhere).
 */
export function recheckedBatch(
  taskIds: readonly string[],
  tasks: readonly PlanningTask[],
  isTouched: (task: PlanningTask) => boolean,
): { taskIds: string[]; touched: PlanningTask[] } {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const touched = taskIds.flatMap((id) => {
    const task = byId.get(id);
    return task && isTouched(task) ? [task] : [];
  });
  const left = new Set(touched.map((task) => task.id));
  return { taskIds: taskIds.filter((id) => !left.has(id)), touched };
}

function localParts(iso: string, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}
const ZH_DAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const EN_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * When a mail arrived, in the account's time zone: the time today, Yesterday, the weekday within
 * the past six days, the day this year, else the day and year; `full` (for its title) always has
 * the weekday and the time.
 */
export function mailTime(
  iso: string,
  timezone: string,
  today: string,
  language: Language,
): { short: string; full: string } {
  const { date, time } = localParts(iso, timezone);
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const thisYear = date.slice(0, 4) === today.slice(0, 4);
  const zh = language === "zh";
  const dayText = zh
    ? `${thisYear ? "" : `${year}年`}${month}月${day}日`
    : `${EN_MONTHS[month - 1]} ${day}${thisYear ? "" : `, ${year}`}`;
  const full = zh
    ? `${dayText}${ZH_DAYS[weekday]} ${time}`
    : `${EN_DAYS[weekday]}, ${dayText}, ${time}`;
  let short = dayText;
  if (date >= today) short = time;
  else if (date === addDays(today, -1)) short = zh ? "昨天" : "Yesterday";
  else if (date >= addDays(today, -6))
    short = (zh ? ZH_DAYS : EN_DAYS)[weekday]!;
  return { short, full };
}

/**
 * A Todofy summary as plain paragraphs of lines, for display only: without bold, underline and
 * code marks or a heading's #, list marks kept. It is never read as HTML or as links.
 */
export function summaryParagraphs(text: string): string[][] {
  return text
    .split(/\n[ \t]*\n/u)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) =>
          line
            .replace(/\*\*|__|`/gu, "")
            .replace(/^\s*#+\s*/u, "")
            .trimEnd(),
        )
        .filter((line) => line.trim()),
    )
    .filter((lines) => lines.length);
}

/**
 * The labels a category may use, by ID with the name shown: Work and Personal (the two area
 * labels, by their domain names) first, then every other current label but the planning stages',
 * the retired Bets', a lead window's and the in-progress one, which Plus writes by other means.
 */
export function categoryLabels(
  plan: Pick<PlanState, "availableLabels" | "managedLabels">,
  names: { work: string; personal: string },
): { id: string; name: string }[] {
  const areas = new Map(
    plan.managedLabels
      .filter((binding) => binding.role === "office" || binding.role === "home")
      .map((binding) => [
        binding.id,
        binding.role === "office" ? names.work : names.personal,
      ]),
  );
  const reserved = new Set(
    plan.managedLabels
      .filter((binding) => !areas.has(binding.id))
      .map((binding) => binding.id),
  );
  const areaLabels = [...areas].map(([id, name]) => ({ id, name }));
  const others = plan.availableLabels
    .filter(
      (label) =>
        !areas.has(label.id) &&
        !reserved.has(label.id) &&
        label.label !== "active",
    )
    .map((label) => ({ id: label.id, name: label.label }));
  return [...areaLabels, ...others];
}

/** A category's generated name, "Work · P2" or "quick · P4"; undefined once its label is gone. */
export function categoryName(
  category: Pick<MailCategory, "labelId" | "priority">,
  labels: readonly { id: string; name: string }[],
): string | undefined {
  const label = labels.find((choice) => choice.id === category.labelId);
  return label && `${label.name} · P${category.priority}`;
}

/**
 * A row's accessible name: its title, brief and time, as the row reads. The brief's closing
 * punctuation goes, so that the comma before the time does not follow it.
 */
export function rowName(
  row: MailRow,
  time: string,
  language: Language,
): string {
  const brief = row.mail.brief.replace(/[。．.！!？?]+$/u, "");
  return [displayedTitle(row.task.title), brief, time]
    .filter(Boolean)
    .join(language === "zh" ? "，" : ", ");
}
