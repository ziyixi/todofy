import { withBets } from "./bets";
import { taskIndex } from "./domain";
import { PARKED_LABEL, STAGE_ROLES } from "./planning-outcomes";
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
 * A confirmed reorder: merge positions, update times and the etag needed by the next write,
 * preserving the task's other properties, and the lane's saved order.
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
          sortOrder: next.sortOrder,
          updatedAt: next.updatedAt,
          etag: next.etag,
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
        finishedPomodoro: confirmed.finishedPomodoro,
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
 * after which the task no longer needs to start. `parked` comes last, as there: true sets the task
 * aside, with no planning label and not in progress; false only takes the set-aside label off.
 */
export function withStage(
  plan: PlanState,
  taskId: string,
  stage: Stage,
  active = false,
  parked?: boolean,
): PlanState {
  const names = new Map(
    plan.managedLabels.map((binding) => [binding.role, binding.label]),
  );
  const planning = Object.values(STAGE_ROLES).map((role) => names.get(role));
  const added = parked
    ? [PARKED_LABEL]
    : [
        stage !== "none" && names.get(STAGE_ROLES[stage]),
        active && ACTIVE_LABEL,
      ].filter((label): label is string => Boolean(label));
  const removed = (label: string) =>
    planning.includes(label) ||
    added.includes(label) ||
    (parked !== undefined && label === PARKED_LABEL) ||
    (parked === true && label === ACTIVE_LABEL);
  const predicted = (task: PlanningTask): PlanningTask => {
    const nextStage = parked ? "none" : stage;
    const status =
      active && !parked ? { mustStart: false, missingLead: false } : {};
    if (task.explicitStage !== undefined) {
      const flags = new Set(task.planningFlags);
      if (parked !== undefined) {
        if (parked) flags.add(PARKED_LABEL);
        else flags.delete(PARKED_LABEL);
      }
      if (parked) flags.delete(ACTIVE_LABEL);
      else if (active) flags.add(ACTIVE_LABEL);
      return {
        ...task,
        stage: nextStage,
        explicitStage: nextStage,
        planningFlags: [...flags],
        ...status,
      };
    }
    return {
      ...task,
      stage: nextStage,
      labels: [...task.labels.filter((label) => !removed(label)), ...added],
      ...status,
    };
  };
  return {
    ...plan,
    tasks: plan.tasks.map((task) =>
      task.id === taskId ? predicted(task) : task,
    ),
  };
}

/** `ids` with the one at `from` moved to `to`, as a sortable list moves it. */
export function moved(
  ids: readonly string[],
  from: number,
  to: number,
): string[] {
  const next = [...ids];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** Shows a reorder inside a Review lane at once; the confirmed order replaces it. */
export function predictLaneOrder(lane: LaneId, ids: readonly string[]) {
  return (data: PlusData): PlusData => ({
    ...data,
    plan: withLaneOrder(data.plan, lane, ids),
  });
}

/**
 * Shows a reorder of Next steps at once, as Todofy writes it: the siblings' own positions,
 * smallest first, in the new order, and their order keys likewise when every one has one.
 * Undefined when a position is missing or repeated, where Todofy writes nothing either.
 */
export function predictChildOrder(
  tasks: readonly PlanningTask[],
  ids: readonly string[],
) {
  const byId = taskIndex(tasks);
  const group = ids.flatMap((id) => byId.get(id) ?? []);
  const native = group.every((task) => task.sortOrder !== undefined);
  const orders = group.map((task) =>
    native ? task.sortOrder : task.childOrder,
  );
  if (
    group.length !== ids.length ||
    orders.some((order) => order === undefined) ||
    new Set(orders).size !== orders.length
  )
    return undefined;
  const positions = [...(orders as number[])].sort((a, b) => a - b);
  const keys = group.every((task) => task.orderKey !== undefined)
    ? group.map((task) => task.orderKey!).sort()
    : undefined;
  const placed = new Map(
    ids.map((id, index) => [
      id,
      {
        ...(native
          ? { sortOrder: positions[index] }
          : { childOrder: positions[index] }),
        ...(keys ? { orderKey: keys[index] } : {}),
      },
    ]),
  );
  return (data: PlusData): PlusData => ({
    ...data,
    plan: {
      ...data.plan,
      tasks: data.plan.tasks.map((task) => {
        const place = placed.get(task.id);
        return place ? { ...task, ...place } : task;
      }),
    },
  });
}

/** Shows a stage drag at once (withStage); the confirmed task (labels, etag) replaces it. */
export function predictStage(
  taskId: string,
  stage: Stage,
  active = false,
  parked?: boolean,
) {
  return (data: PlusData): PlusData => ({
    ...data,
    plan: withStage(data.plan, taskId, stage, active, parked),
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
