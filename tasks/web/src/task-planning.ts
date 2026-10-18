import { createHttpClient } from "@ziyixi/proto/http-client";
import { PlusService } from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import type { PlanningTask } from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import { send } from "./api";

export const planningApi = createHttpClient(PlusService, send);
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
export function planningDraft(task?: PlanningTask): PlanningDraft {
  const flags = new Set(task?.planningFlags || []);
  return {
    stage: task?.explicitStage || "none",
    area: task?.area || "unassigned",
    leadDays: task?.leadDays || 0,
    ...(Object.fromEntries(
      TASK_OPTIONS.map(([field, flag]) => [field, flags.has(flag)]),
    ) as Record<TaskOption, boolean>),
  };
}
export async function readTaskPlanning(id: string) {
  const result = await planningApi.listPlanningTasks({
    taskIds: [id],
    pageSize: 1,
  });
  return result.planningTasks[0];
}

/** Generic task persistence precedes these owner-planning writes; each service owns its own state. */
export async function saveTaskPlanning(
  id: string,
  deadline: string,
  desired: PlanningDraft,
  base?: PlanningDraft,
) {
  const initial = base || planningDraft();
  const fields = [
    "stage",
    "area",
    ...TASK_OPTIONS.map(([field]) => field),
  ] as const;
  const changed = fields.filter((field) => desired[field] !== initial[field]);
  const leadChanged = desired.leadDays !== initial.leadDays;
  if (!changed.length && !leadChanged) return;
  let current = await readTaskPlanning(id);
  if (!current)
    throw new Error("This task is no longer available for planning.");
  const fresh = planningDraft(current);
  if (
    base &&
    [...changed, ...(leadChanged ? ["leadDays" as const] : [])].some(
      (field) =>
        fresh[field] !== initial[field] && fresh[field] !== desired[field],
    )
  )
    throw new Error(
      "Planning changed elsewhere. Reopen this task to read the latest values.",
    );
  if (changed.length) {
    const update = Object.fromEntries(
      changed.map((field) => [field, desired[field]]),
    );
    const result = await planningApi.setTaskPlan({
      taskId: id,
      etag: current.etag,
      requestId: crypto.randomUUID(),
      ...update,
    });
    if (!result.task)
      throw new Error("The saved planning values could not be read.");
    current = result.task;
  }
  if (leadChanged)
    await planningApi.setTaskLead({
      taskId: id,
      etag: current.etag,
      requestId: crypto.randomUUID(),
      deadline,
      leadDays: desired.leadDays,
    });
}
