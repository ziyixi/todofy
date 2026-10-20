import { withBets } from "./bets";
import { taskIndex } from "./domain";
import { PARKED_LABEL } from "./planning-outcomes";
import { ACTIVE_LABEL, isLastDay } from "./weekly-review";
import type {
  Area,
  Confirmed,
  DayPlan,
  DayQueue,
  DependencyResult,
  FocusEntry,
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

/** Confirmed queues replace the days' queues; their records stay. */
function withDays(data: PlusData, queues: DayQueue[]): PlusData {
  const queue = <Day extends DayPlan>(day: Day): Day => {
    const next = queues.find((item) => item.date === day.date);
    return next
      ? {
          ...day,
          taskIds: next.taskIds,
          completedTaskIds: next.completedTaskIds,
        }
      : day;
  };
  return { ...data, days: data.days.map(queue), focus: queue(data.focus) };
}

/**
 * A day's records with a saved one: it replaces the record with its ID, or joins the day's records;
 * without `entry`, the record with `removed`'s ID leaves. Another day's records are unchanged.
 */
export function withRecord<Day extends DayPlan>(
  day: Day,
  entry: FocusEntry | undefined,
  removed?: { id: string; date: string },
): Day {
  const target = entry ?? removed;
  if (!target || day.date !== target.date) return day;
  if (!entry)
    return {
      ...day,
      entries: day.entries.filter((item) => item.id !== target.id),
    };
  return {
    ...day,
    entries: day.entries.some((item) => item.id === entry.id)
      ? day.entries.map((item) => (item.id === entry.id ? entry : item))
      : [...day.entries, entry],
  };
}

function withEntry(
  data: PlusData,
  entry: FocusEntry | undefined,
  removed?: { id: string; date: string },
): PlusData {
  if (!entry && !removed) return data;
  const records = <Day extends DayPlan>(day: Day) =>
    withRecord(day, entry, removed);
  return { ...data, days: data.days.map(records), focus: records(data.focus) };
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

/** One task's dependencies replace its old ones, and the task its saved self (its etag changed). */
function withDependencies(data: PlusData, result: DependencyResult): PlusData {
  const dependencies = [
    ...data.plan.dependencies.filter(
      (dependency) => dependency.taskId !== result.forTask,
    ),
    ...result.dependencies,
  ];
  const saved = { ...data, plan: { ...data.plan, dependencies } };
  return result.task ? withTasks(saved, [result.task]) : saved;
}

function withWeeklyBets(data: PlusData, bets: WeeklyBet[]): PlusData {
  if (!bets.length) return data;
  return {
    ...data,
    plan: { ...data.plan, weeklyBets: withBets(data.plan.weeklyBets, bets) },
  };
}

/**
 * A lane's new order as Tasks saves it: its tasks leave every other lane's order, and a lane left
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

/**
 * A task's estimate as the host saves it: its duration, none for 0, with the etag the write gave
 * it, which the task's next write needs. Focus reads its own copy of the estimates first, so that
 * copy changes too.
 */
export function withEstimate(
  data: PlusData,
  taskId: string,
  minutes: number,
  etag?: string,
): PlusData {
  return {
    ...data,
    plan: {
      ...data.plan,
      tasks: data.plan.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              estimatedMinutes: minutes > 0 ? minutes : undefined,
              ...(etag ? { etag } : {}),
            }
          : task,
      ),
    },
    focus: {
      ...data.focus,
      estimates: { ...data.focus.estimates, [taskId]: minutes },
    },
  };
}

/** Shows a write's confirmed server result without reading everything again. */
export function applyConfirmed(data: PlusData, confirmed: Confirmed): PlusData {
  if (!confirmed) return data;
  if (Array.isArray(confirmed)) {
    const items: (DayQueue | PlanningTask | WeeklyBet)[] = confirmed;
    return withWeeklyBets(
      withTasks(
        withDays(
          data,
          items.filter((item): item is DayQueue => "date" in item),
        ),
        items.filter((item): item is PlanningTask => "id" in item),
      ),
      items.filter((item): item is WeeklyBet => "weekStart" in item),
    );
  }
  if ("weekStart" in confirmed) return withWeeklyBets(data, [confirmed]);
  if ("timerEtag" in confirmed)
    return withEntry(
      {
        ...data,
        focus: {
          ...data.focus,
          timerEtag: confirmed.timerEtag,
          timer: confirmed.timer,
          finishedPomodoro: confirmed.finishedPomodoro,
        },
      },
      confirmed.entry,
    );
  if ("savedEntry" in confirmed) return withEntry(data, confirmed.savedEntry);
  if ("deletedEntry" in confirmed)
    return withEntry(data, undefined, confirmed.deletedEntry);
  if ("reordered" in confirmed) return withReorder(data, confirmed);
  if ("estimate" in confirmed)
    return withEstimate(
      data,
      confirmed.estimate.taskId,
      confirmed.estimate.minutes,
      confirmed.etag,
    );
  if ("id" in confirmed) return withTasks(data, [confirmed]);
  return withDependencies(data, confirmed);
}

/**
 * Mirrors how Tasks records a commitment confirmed on the week's last day (its committed week),
 * until the next read lists next week's choices: a commitment chosen then is kept for next week, and
 * a task no longer committed is not.
 */
export function withNextWeek(
  data: PlusData,
  update: { stage?: Stage; area?: Area; active?: boolean; parked?: boolean },
  saved: PlanningTask,
): PlusData {
  const { plan } = data;
  if (!isLastDay(plan.week, plan.today)) return data;
  const others = plan.nextWeekTaskIds.filter((id) => id !== saved.id);
  const chosen = update.stage === "committed";
  const marked = saved.stage === "committed";
  const kept = chosen || (marked && plan.nextWeekTaskIds.includes(saved.id));
  return {
    ...data,
    plan: { ...plan, nextWeekTaskIds: kept ? [...others, saved.id] : others },
  };
}

/** Void results (completion, new steps) are shown only by a re-read. */
export function rereadsAfter(confirmed: Confirmed): boolean {
  return !confirmed;
}

/** A Review card whose stage write is not yet confirmed. */
export function pendingTask(taskId: string): string {
  return `task:${taskId}`;
}
/** A day card whose queue write is not yet confirmed. */
export function pendingStep(date: string, taskId: string): string {
  return `${date}:${taskId}`;
}
/** A time record whose write is not yet confirmed. */
export function pendingEntry(id: string): string {
  return `entry:${id}`;
}

/**
 * The plan as a stage write will leave it, as Todofy saves native planning state: the saved stage,
 * and with `active` the in-progress flag, after which the task no longer needs to start. `parked`
 * comes last: true sets the task aside, with no stage and not in progress; false only clears it.
 */
export function withStage(
  plan: PlanState,
  taskId: string,
  stage: Stage,
  active = false,
  parked?: boolean,
): PlanState {
  const predicted = (task: PlanningTask): PlanningTask => {
    const nextStage = parked ? "none" : stage;
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
      ...(active && !parked ? { mustStart: false, missingLead: false } : {}),
    };
  };
  return {
    ...plan,
    tasks: plan.tasks.map((task) =>
      task.id === taskId ? predicted(task) : task,
    ),
  };
}

/** `items` with the one at `from` moved to `to`, as a sortable list moves it. */
export function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
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
 * Shows a reorder of Next steps at once, as it is written: the siblings' own positions, smallest
 * first, in the new order, and their order keys likewise when every one has one. Undefined when a
 * position is missing or repeated, where the write changes nothing either.
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

/** Shows a new estimate at once (withEstimate); the saved one replaces it. */
export function predictEstimate(taskId: string, minutes: number) {
  return (data: PlusData): PlusData => withEstimate(data, taskId, minutes);
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
  const move = <Day extends DayQueue>(day: Day): Day => {
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
