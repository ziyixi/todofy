import { withBets } from "./bets";
import { STAGE_ROLES } from "./planning-outcomes";
import { ACTIVE_LABEL, isLastDay } from "./weekly-review";
import type {
  Area,
  Confirmed,
  DependencyResult,
  FlowDayPlan,
  LaneId,
  PlanState,
  PlanningTask,
  PlusData,
  ReorderResult,
  Stage,
  WeeklyBet,
} from "./model";

/** Data at least this old is read again when the view comes back. */
export const REREAD_AFTER_MS = 60_000;

function withFlows(data: PlusData, flows: FlowDayPlan[]): PlusData {
  const today = flows.find((day) => day.date === data.focus.date);
  return {
    ...data,
    days: data.days.map(
      (day) => flows.find((next) => next.date === day.date) ?? day,
    ),
    focus: today ? { ...data.focus, ...today } : data.focus,
  };
}

function withTasks(data: PlusData, tasks: PlanningTask[]): PlusData {
  if (!tasks.length) return data;
  return {
    ...data,
    plan: {
      ...data.plan,
      tasks: data.plan.tasks.map(
        (task) => tasks.find((next) => next.id === task.id) ?? task,
      ),
    },
  };
}

/** One task's dependencies replace its old ones; an answer without a task replaces them all. */
function withDependencies(data: PlusData, result: DependencyResult): PlusData {
  const { forTask } = result;
  const dependencies =
    forTask === undefined
      ? result.dependencies
      : [
          ...data.plan.dependencies.filter(
            (dependency) => dependency.taskId !== forTask,
          ),
          ...result.dependencies,
        ];
  return { ...data, plan: { ...data.plan, dependencies } };
}

function withWeeklyBets(data: PlusData, bets: WeeklyBet[]): PlusData {
  if (!bets.length) return data;
  return {
    ...data,
    plan: { ...data.plan, weeklyBets: withBets(data.plan.weeklyBets, bets) },
  };
}

/**
 * A lane's new order as Todofy saves it: its tasks leave every other lane's order, and a lane left
 * with none is removed.
 */
export function withLaneOrder(
  plan: PlanState,
  lane: LaneId,
  taskIds: readonly string[],
): PlanState {
  const ordered = new Set(taskIds);
  const laneOrders: PlanState["laneOrders"] = {};
  for (const [other, ids] of Object.entries(plan.laneOrders) as [
    LaneId,
    string[],
  ][]) {
    const kept = ids.filter((id) => !ordered.has(id));
    if (other !== lane && kept.length) laneOrders[other] = kept;
  }
  if (taskIds.length) laneOrders[lane] = [...taskIds];
  return { ...plan, laneOrders };
}

/**
 * A confirmed reorder: only Todoist's new positions and update times are merged (estimates come
 * from FlowDay), and the lane's saved order.
 */
function withReorder(data: PlusData, result: ReorderResult): PlusData {
  const saved = new Map(result.reordered.map((task) => [task.id, task]));
  const tasks = data.plan.tasks.map((task) => {
    const next = saved.get(task.id);
    return next
      ? {
          ...task,
          childOrder: next.childOrder,
          orderKey: next.orderKey,
          updatedAt: next.updatedAt,
        }
      : task;
  });
  const plan = { ...data.plan, tasks };
  return {
    ...data,
    plan: result.lane
      ? withLaneOrder(plan, result.lane.lane, result.lane.taskIds)
      : plan,
  };
}

/** Shows a write's confirmed server result without reading everything again. */
export function applyConfirmed(data: PlusData, confirmed: Confirmed): PlusData {
  if (!confirmed) return data;
  if (Array.isArray(confirmed)) {
    const items: (FlowDayPlan | PlanningTask | WeeklyBet)[] = confirmed;
    return withWeeklyBets(
      withTasks(
        withFlows(
          data,
          items.filter((item): item is FlowDayPlan => "date" in item),
        ),
        items.filter((item): item is PlanningTask => "id" in item),
      ),
      items.filter((item): item is WeeklyBet => "weekStart" in item),
    );
  }
  if ("weekStart" in confirmed) return withWeeklyBets(data, [confirmed]);
  if ("timerEtag" in confirmed)
    return {
      ...data,
      focus: {
        ...data.focus,
        timerEtag: confirmed.timerEtag,
        timer: confirmed.timer,
      },
    };
  if ("deletedTaskIds" in confirmed) {
    const deleted = new Set(confirmed.deletedTaskIds);
    return {
      ...data,
      plan: {
        ...data.plan,
        tasks: data.plan.tasks.filter((task) => !deleted.has(task.id)),
      },
    };
  }
  if ("reordered" in confirmed) return withReorder(data, confirmed);
  if ("id" in confirmed) return withTasks(data, [confirmed]);
  if (!("managedLabels" in confirmed)) return withDependencies(data, confirmed);
  return { ...data, plan: { ...confirmed, tasks: data.plan.tasks } };
}

/**
 * Mirrors how Todofy records a confirmed SetTaskPlan on the week's last day (core/plus.py
 * membership_week, REMEMBER_WEEK, FORGET_TASK), until the next read lists next week's choices: a
 * commitment chosen then is kept for next week, and a task no longer committed is not.
 */
export function withNextWeek(
  data: PlusData,
  update: { stage?: Stage; area?: Area; active?: boolean; parked?: boolean },
  saved: PlanningTask,
): PlusData {
  const { plan } = data;
  if (!isLastDay(plan.week, data.focus.date)) return data;
  const others = plan.nextWeekTaskIds.filter((id) => id !== saved.id);
  const chosen = update.stage === "committed";
  const marked = saved.stage === "committed";
  const kept = chosen || (marked && plan.nextWeekTaskIds.includes(saved.id));
  return {
    ...data,
    plan: { ...plan, nextWeekTaskIds: kept ? [...others, saved.id] : others },
  };
}

/** A new label mapping changes every task's derived stage and etag. */
export function remapsTasks(confirmed: Confirmed): boolean {
  return confirmed
    ? !Array.isArray(confirmed) && "managedLabels" in confirmed
    : false;
}

/**
 * Void results (completion, new steps, estimates) are shown only by a re-read, and so is the
 * effect of a new label mapping on the tasks.
 */
export function rereadsAfter(confirmed: Confirmed): boolean {
  return !confirmed || remapsTasks(confirmed);
}

/** A Review card whose stage write is not yet confirmed. */
export function pendingTask(taskId: string): string {
  return `task:${taskId}`;
}
/** A day card whose queue write is not yet confirmed. */
export function pendingStep(date: string, taskId: string): string {
  return `${date}:${taskId}`;
}

/**
 * The plan as a stage write will leave it, with the labels Todofy writes (core/plus.py plan_labels):
 * the stage's label in place of the other planning labels, and with `active` the in-progress label,
 * after which the task no longer needs to start.
 */
export function withStage(
  plan: PlanState,
  taskId: string,
  stage: Stage,
  active = false,
): PlanState {
  const names = new Map(
    plan.managedLabels.map((binding) => [binding.role, binding.label]),
  );
  const planning = Object.values(STAGE_ROLES).map((role) => names.get(role));
  const added = [
    stage !== "none" && names.get(STAGE_ROLES[stage]),
    active && ACTIVE_LABEL,
  ].filter((label): label is string => Boolean(label));
  const predicted = (task: PlanningTask): PlanningTask => ({
    ...task,
    stage,
    labels: [
      ...task.labels.filter(
        (label) => !planning.includes(label) && !added.includes(label),
      ),
      ...added,
    ],
    ...(active ? { mustStart: false, missingLead: false } : {}),
  });
  return {
    ...plan,
    tasks: plan.tasks.map((task) =>
      task.id === taskId ? predicted(task) : task,
    ),
  };
}

/** Shows a stage drag at once (withStage); the confirmed task (labels, etag) replaces it. */
export function predictStage(taskId: string, stage: Stage, active = false) {
  return (data: PlusData): PlusData => ({
    ...data,
    plan: withStage(data.plan, taskId, stage, active),
  });
}

/**
 * Shows a day drag at once, mirroring moveTaskToDay: the step leaves its source day and is
 * inserted before `beforeId` in the target day, or appended.
 */
export function predictMove(
  taskId: string,
  sourceDate: string | undefined,
  targetDate: string,
  beforeId?: string,
) {
  const move = <Day extends FlowDayPlan>(day: Day): Day => {
    if (day.date === targetDate) {
      const taskIds = day.taskIds.filter((id) => id !== taskId);
      const before = beforeId ? taskIds.indexOf(beforeId) : -1;
      taskIds.splice(before < 0 ? taskIds.length : before, 0, taskId);
      return { ...day, taskIds };
    }
    if (day.date === sourceDate)
      return { ...day, taskIds: day.taskIds.filter((id) => id !== taskId) };
    return day;
  };
  return (data: PlusData): PlusData => ({
    ...data,
    days: data.days.map(move),
    focus: move(data.focus),
  });
}
