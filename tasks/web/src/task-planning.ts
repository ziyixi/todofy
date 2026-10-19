import { createHttpClient } from "@ziyixi/proto/http-client";
import { PlusService } from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import type { PlanningTask } from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import { send, type Task } from "./api";
import {
  peekDetailRead,
  readDetail,
  clearDetailReadCache,
  type DetailReadKey,
} from "./detail-read-cache";

export const planningApi = createHttpClient(PlusService, send);
export type { PlanningTask };

/** List decoration is a bounded bulk read; it never seeds the editor's detail cache. */
export async function readTaskListPlanning(tasks: readonly Task[]) {
  const ids = tasks.filter((task) => !task.completed).map((task) => task.id);
  const values = new Map<string, PlanningTask>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const result = await planningApi.listPlanningTasks({
      taskIds: ids.slice(offset, offset + 100),
      pageSize: 100,
    });
    if (result.nextPageToken)
      throw new Error("Planning properties are incomplete.");
    for (const value of result.planningTasks) values.set(value.id, value);
  }
  return values;
}
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
  if (flags.has("quick")) flags.add("task");
  return {
    stage: task?.explicitStage || "none",
    area: task?.area || "unassigned",
    leadDays: task?.leadDays || 0,
    ...(Object.fromEntries(
      TASK_OPTIONS.map(([field, flag]) => [field, flags.has(flag)]),
    ) as Record<TaskOption, boolean>),
  };
}
function planningReadKey(task: Pick<Task, "id" | "etag">): DetailReadKey {
  return `planning:${task.id}:${task.etag}`;
}
export function peekTaskPlanning(
  task: Pick<Task, "id" | "etag">,
): PlanningTask | undefined {
  return peekDetailRead<PlanningTask>(planningReadKey(task));
}
/** Only opening details uses this short-lived page-memory read. Mutation preflights stay fresh. */
export function readCachedTaskPlanning(task: Pick<Task, "id" | "etag">) {
  return readDetail(planningReadKey(task), () => readTaskPlanning(task.id));
}
/** Deliberately uncached: saves and deadline cleanup compare against the current server state. */
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
  // A write preflight can prove an opened snapshot stale even before the server rejects a mutation.
  clearDetailReadCache();
  if (!current)
    throw new Error("This task is no longer available for planning.");
  const fresh = planningDraft(current);
  if (leadChanged && current.deadline !== deadline)
    throw new Error(
      "The deadline changed elsewhere. Reopen this task before changing start-ahead.",
    );
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
