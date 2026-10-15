import type { Confirmed, FlowDayPlan, PlanningTask, PlusData } from "./model";

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
