import {
  deadlineState,
  deadlineStatus,
  isDue,
  startStatus,
  type StatusText,
} from "./deadlines";
import {
  dependencyIndex,
  waitingForStatus,
  waitingTasks,
} from "./dependencies";
import { isDateCandidate, planningOutcomes } from "./planning-outcomes";
import { untouchedText, waits } from "./weekly-review";
import type { Language, PlanState, PlanningTask, Stage } from "./model";

/** The Review board's lanes, left to right: Start now, Waiting, the four planning stages. */
export type LaneId = "start" | "waiting" | Exclude<Stage, "none">;
export type BoardLanes = Record<LaneId, PlanningTask[]>;

/** What a card says besides its title and area: that it waits, or that it should start. */
export type CardState = "waiting" | "start";

/**
 * Waiting wins, as in the board's lanes: a @waiting task past its deadline waits, and so does one
 * whose dependency holds (`waitsFor`, its prerequisites that still hold it back). A task should
 * start once Todofy's start window opens or its deadline passes, until it is in progress.
 */
export function cardState(
  task: PlanningTask,
  today: string,
  waitsFor: readonly PlanningTask[] = [],
): CardState | undefined {
  if (waits(task) || waitsFor.length) return "waiting";
  const state = deadlineState(task, today);
  return state && isDue(state) ? "start" : undefined;
}

/**
 * Every task in at most one lane (owner, 2026-10-16). An outcome with its own stage label stays in
 * that lane, and its card says it waits or should start. Otherwise a waiting task (a label, or a
 * dependency that holds) is in Waiting and one that should start is in Start now, also when only
 * the 7-day date rule made it a Week candidate; the other date-rule candidates stay in Week. A step
 * has no card in its outcome's lane, even with the same stage label, so one that waits or should
 * start has its own card in Waiting or Start now. Start now lists the earliest deadline first, then
 * the higher priority; Waiting the longest untouched first.
 */
export function boardLanes(
  plan: Pick<PlanState, "tasks" | "managedLabels" | "dependencies">,
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
  const { waitingFor } = dependencyIndex(plan);
  const state = (task: PlanningTask) =>
    cardState(task, today, waitingFor.get(task.id));
  for (const task of outcomes)
    if (staged.has(task.id) || !state(task))
      lanes[task.stage as Exclude<Stage, "none">].push(task);
  for (const task of waitingTasks(plan))
    if (!staged.has(task.id)) lanes.waiting.push(task);
  lanes.start = plan.tasks
    .filter((task) => !staged.has(task.id) && state(task) === "start")
    .sort(
      (a, b) => a.deadline.localeCompare(b.deadline) || b.priority - a.priority,
    );
  return lanes;
}

/**
 * A card's one muted status, in parts that are shown joined by " · ": "还剩 5 天", "明天截止",
 * "今天截止" or "已过 2 天" (in --plus-danger) when it should start; "12 天未变动 · 10月22日截止",
 * "12 天未变动 · 已过 2 天" or "12 天未变动" when it waits, and "等「订场地」" or "等 2 项" in
 * place of the untouched days when it waits for other tasks (`waitsFor`). "已过 N 天" is the
 * board's one red wording.
 */
export function cardStatus(
  task: PlanningTask,
  state: CardState,
  today: string,
  language: Language,
  waitsFor: readonly PlanningTask[] = [],
): StatusText[] {
  if (state === "start") return [startStatus(task.deadline, today, language)];
  const untouched = waitsFor.length
    ? waitingForStatus(waitsFor, language)
    : { text: untouchedText(task, language) };
  const deadline =
    task.deadline && task.deadline < today
      ? startStatus(task.deadline, today, language)
      : deadlineStatus(task, today, language);
  return [
    ...(untouched.text ? [untouched] : []),
    ...(deadline ? [deadline] : []),
  ];
}

/** The status as one line of text, for an accessible name: every title in full. */
export function statusLine(parts: readonly StatusText[]): string {
  return parts
    .map(
      (part) =>
        part.text +
        (part.quoted ? part.quoted.title + part.quoted.close : "") +
        (part.danger ?? ""),
    )
    .join(" · ");
}
