import {
  deadlineState,
  deadlineStatus,
  isDue,
  startStatus,
  type StatusText,
} from "./deadlines";
import { isDateCandidate, planningOutcomes } from "./planning-outcomes";
import {
  oldestUntouched,
  untouchedText,
  WAITING_LABELS,
} from "./weekly-review";
import type { Language, PlanState, PlanningTask, Stage } from "./model";

/** The Review board's lanes, left to right: Start now, Waiting, the four planning stages. */
export type LaneId = "start" | "waiting" | Exclude<Stage, "none">;
export type BoardLanes = Record<LaneId, PlanningTask[]>;

/** What a card says besides its title and area: that it waits, or that it should start. */
export type CardState = "waiting" | "start";

/**
 * Waiting wins, as in the board's lanes: a @waiting task past its deadline waits. A task should
 * start once Todofy's start window opens or its deadline passes, until it is in progress.
 */
export function cardState(
  task: PlanningTask,
  today: string,
): CardState | undefined {
  if (task.labels.some((label) => WAITING_LABELS.includes(label)))
    return "waiting";
  const state = deadlineState(task, today);
  return state && isDue(state) ? "start" : undefined;
}

/**
 * Every task in at most one lane (owner, 2026-10-16). An outcome with its own stage label stays in
 * that lane, and its card says it waits or should start. Otherwise a waiting task is in Waiting and
 * one that should start is in Start now, also when only the 7-day date rule made it a Week
 * candidate; the other date-rule candidates stay in Week. Start now lists the earliest deadline
 * first, then the higher priority; Waiting the longest untouched first.
 */
export function boardLanes(
  plan: Pick<PlanState, "tasks" | "managedLabels">,
  today: string,
): BoardLanes {
  const lanes: BoardLanes = {
    start: [],
    waiting: [],
    quarterly: [],
    monthly: [],
    weekly: [],
    committed: [],
  };
  const outcomes = planningOutcomes(plan.tasks, plan.managedLabels);
  const staged = new Set(
    outcomes
      .filter((task) => !isDateCandidate(task, plan.managedLabels))
      .map((task) => task.id),
  );
  for (const task of outcomes)
    if (staged.has(task.id) || !cardState(task, today))
      lanes[task.stage as Exclude<Stage, "none">].push(task);
  for (const task of oldestUntouched(plan.tasks, WAITING_LABELS))
    if (!staged.has(task.id)) lanes.waiting.push(task);
  lanes.start = plan.tasks
    .filter(
      (task) => !staged.has(task.id) && cardState(task, today) === "start",
    )
    .sort(
      (a, b) => a.deadline.localeCompare(b.deadline) || b.priority - a.priority,
    );
  return lanes;
}

/**
 * A card's one muted status, in parts that are shown joined by " · ": "还剩 5 天", "明天截止",
 * "今天截止" or "已过 2 天" (in --plus-danger) when it should start; "12 天未变动 · 10月22日截止"
 * or "12 天未变动" when it waits.
 */
export function cardStatus(
  task: PlanningTask,
  state: CardState,
  today: string,
  language: Language,
): StatusText[] {
  if (state === "start") return [startStatus(task.deadline, today, language)];
  const untouched = untouchedText(task, language);
  const deadline = deadlineStatus(task, today, language);
  return [
    ...(untouched ? [{ text: untouched }] : []),
    ...(deadline ? [deadline] : []),
  ];
}

/** The status as one line of text, for an accessible name. */
export function statusLine(parts: readonly StatusText[]): string {
  return parts.map((part) => part.text + (part.danger ?? "")).join(" · ");
}
