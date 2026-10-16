import { STAGE_ROLES } from "./planning-outcomes";
import { ACTIVE_LABEL, isLastDay } from "./weekly-review";
import type {
  Area,
  Confirmed,
  FlowDayPlan,
  PlanningTask,
  PlusData,
  Stage,
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

/** Shows a write's confirmed server result without reading everything again. */
export function applyConfirmed(data: PlusData, confirmed: Confirmed): PlusData {
  if (!confirmed) return data;
  if (Array.isArray(confirmed)) {
    const items: (FlowDayPlan | PlanningTask)[] = confirmed;
    return withTasks(
      withFlows(
        data,
        items.filter((item): item is FlowDayPlan => "date" in item),
      ),
      items.filter((item): item is PlanningTask => "id" in item),
    );
  }
  if ("timerEtag" in confirmed)
    return {
      ...data,
      focus: {
        ...data.focus,
        timerEtag: confirmed.timerEtag,
        timer: confirmed.timer,
      },
    };
  if ("id" in confirmed) return withTasks(data, [confirmed]);
  return { ...data, plan: { ...confirmed, tasks: data.plan.tasks } };
}

/**
 * Mirrors how Todofy records a confirmed SetTaskPlan on the week's last day (core/plus.py
 * membership_week, REMEMBER_WEEK, FORGET_TASK), until the next read lists next week's choices: a
 * commitment or Bet chosen then is kept for next week, and a task left with neither mark is not.
 */
export function withNextWeek(
  data: PlusData,
  update: { stage?: Stage; area?: Area; bet?: boolean; active?: boolean },
  saved: PlanningTask,
): PlusData {
  const { plan } = data;
  if (!isLastDay(plan.week, data.focus.date)) return data;
  const others = plan.nextWeekTaskIds.filter((id) => id !== saved.id);
  const chosen = update.stage === "committed" || update.bet === true;
  const marked = saved.stage === "committed" || saved.bet;
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
 * Shows a stage drag at once with the labels Todofy writes (core/plus.py plan_labels): the stage's
 * label in place of the other planning labels, and with `active` the in-progress label, after which
 * the task no longer needs to start. The confirmed task (labels, etag) replaces it.
 */
export function predictStage(taskId: string, stage: Stage, active = false) {
  return (data: PlusData): PlusData => {
    const names = new Map(
      data.plan.managedLabels.map((binding) => [binding.role, binding.label]),
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
      ...data,
      plan: {
        ...data.plan,
        tasks: data.plan.tasks.map((task) =>
          task.id === taskId ? predicted(task) : task,
        ),
      },
    };
  };
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
