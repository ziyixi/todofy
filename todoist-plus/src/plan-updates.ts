import type {
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
 * Void results (completion, new steps, estimates) are shown only by a re-read. A new label
 * mapping changes every task's derived stage, so its confirmed plan is followed by one too.
 */
export function rereadsAfter(confirmed: Confirmed): boolean {
  return (
    !confirmed || (!Array.isArray(confirmed) && "managedLabels" in confirmed)
  );
}

/** A Review card whose stage write is not yet confirmed. */
export function pendingTask(taskId: string): string {
  return `task:${taskId}`;
}
/** A day card whose queue write is not yet confirmed. */
export function pendingStep(date: string, taskId: string): string {
  return `${date}:${taskId}`;
}

/** Shows a stage drag at once; the confirmed task (labels, etag) replaces it. */
export function predictStage(taskId: string, stage: Stage) {
  return (data: PlusData): PlusData => ({
    ...data,
    plan: {
      ...data.plan,
      tasks: data.plan.tasks.map((task) =>
        task.id === taskId ? { ...task, stage } : task,
      ),
    },
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
