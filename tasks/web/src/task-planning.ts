import type { Task } from "./api";

export const TASK_OPTIONS = [
  ["singleAction", "task", "Standalone action"],
  ["quick", "quick", "Quick action"],
  ["active", "active", "In progress"],
  ["waiting", "waiting", "Waiting"],
  ["onHold", "onhold", "On hold"],
  ["routine", "routine", "Routine"],
  ["parked", "parked", "Parked"],
] as const;
export type TaskOption = (typeof TASK_OPTIONS)[number][0];
export interface PlanningDraft extends Record<TaskOption, boolean> {
  stage: string;
  area: string;
  leadDays: number;
}
/** A task's planning facts as the dialog edits them; a new task has none. */
export function planningDraft(task?: Task): PlanningDraft {
  const flags = new Set(task?.planningFlags || []);
  if (flags.has("quick")) flags.add("task");
  return {
    stage: task?.stage || "none",
    area: task?.area || "unassigned",
    leadDays: task?.leadDays || 0,
    ...(Object.fromEntries(
      TASK_OPTIONS.map(([field, flag]) => [field, flags.has(flag)]),
    ) as Record<TaskOption, boolean>),
  };
}
/**
 * The planning paths a dialog save adds to its one UpdateTask, with their values: only what the owner changed, so
 * that a Sunday area edit never keeps a commitment for next week.
 */
export function planningChanges(
  draft: PlanningDraft,
  base: PlanningDraft,
): {
  paths: string[];
  values: Pick<Task, "stage" | "area" | "leadDays" | "planningFlags">;
} {
  const paths: string[] = [];
  if (draft.stage !== base.stage) paths.push("stage");
  if (draft.area !== base.area) paths.push("area");
  if (draft.leadDays !== base.leadDays) paths.push("lead_days");
  if (TASK_OPTIONS.some(([field]) => draft[field] !== base[field]))
    paths.push("planning_flags");
  return {
    paths,
    values: {
      stage: draft.stage,
      area: draft.area,
      leadDays: draft.leadDays,
      planningFlags: TASK_OPTIONS.flatMap(([field, flag]) =>
        draft[field] ? [flag] : [],
      ),
    },
  };
}
