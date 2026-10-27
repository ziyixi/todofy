import {
  deadlineStatus,
  planningReadiness,
  startStatus,
  type StatusText,
} from "./deadlines";
import { dependencyIndex, waitingForStatus } from "./dependencies";
import {
  inLaneOrder,
  isDateCandidate,
  isParked,
  planningOutcomes,
} from "./planning-outcomes";
import { byUntouched, untouchedText, waits } from "./weekly-review";
import { planVisibility } from "./plan-visibility";
import type { LaneId, Language, PlanState, PlanningTask, Stage } from "./model";

export type { LaneId } from "./model";
export type BoardLanes = Record<LaneId, PlanningTask[]>;

/** A card's waiting, deadline-window or completed-prerequisite reason. */
export type CardState = "waiting" | "start" | "ready";

/**
 * Waiting wins, as in the board's lanes: a @waiting task past its deadline waits, and so does one
 * whose dependency holds (`waitsFor`, its prerequisites that still hold it back). A task should
 * start once its start window opens or its deadline passes, until it is in progress.
 */
export function cardState(
  task: PlanningTask,
  today: string,
  waitsFor: readonly PlanningTask[] = [],
  dependenciesDone = false,
): CardState | undefined {
  if (waits(task) || waitsFor.length) return "waiting";
  const ready = planningReadiness(task, today, false, dependenciesDone);
  return ready === "dependencies" ? "ready" : ready ? "start" : undefined;
}

/**
 * One card per task. Ready tasks surface in Parked before the manually parked backlog, without
 * rewriting their stages; committed work stays in Committed with its status, where Week lists it.
 * Picking one up uses the existing active flag. Remaining tasks keep their stage or date-candidate
 * lane. Waiting tasks and their descendants are hidden. The old start key remains readable in lane
 * orders; the board no longer displays a separate Start now lane.
 */
export function boardLanes(
  plan: Pick<PlanState, "tasks" | "dependencies" | "laneOrders">,
  today: string,
): BoardLanes {
  const lanes: BoardLanes = {
    start: [],
    waiting: [],
    parked: [],
    quarterly: [],
    monthly: [],
    weekly: [],
    committed: [],
  };
  const tasks = planVisibility(plan).tasks;
  const parked = (task: PlanningTask) => isParked(task);
  const index = dependencyIndex(plan);
  const state = (task: PlanningTask) =>
    cardState(
      task,
      today,
      index.waitingFor.get(task.id),
      index.done.has(task.id),
    );
  const ready = tasks
    .filter((task) => {
      const ready = state(task);
      // As committedOutcomes lists it, committed work stays in its own lane.
      return (
        task.stage !== "committed" && (ready === "start" || ready === "ready")
      );
    })
    .sort(
      (a, b) =>
        (a.deadline || "9999").localeCompare(b.deadline || "9999") ||
        b.priority - a.priority,
    );
  const readyIds = new Set(ready.map((task) => task.id));
  lanes.parked = [
    ...inLaneOrder("start", ready, plan.laneOrders.parked),
    ...inLaneOrder(
      "parked",
      byUntouched(tasks.filter(parked)),
      plan.laneOrders.parked,
    ),
  ];
  const outcomes = planningOutcomes(tasks).filter(
    (task) => !parked(task) && !readyIds.has(task.id),
  );
  const staged = new Set(
    outcomes.filter((task) => !isDateCandidate(task)).map((task) => task.id),
  );
  for (const task of outcomes)
    if (staged.has(task.id) || !state(task))
      lanes[task.stage as Exclude<Stage, "none">].push(task);
  for (const lane of Object.keys(lanes) as LaneId[])
    if (lane !== "parked")
      lanes[lane] = inLaneOrder(lane, lanes[lane], plan.laneOrders[lane]);
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
  if (state === "ready")
    return [
      {
        text: language === "zh" ? "前置任务已完成" : "Prerequisites completed",
      },
    ];
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
