import { api, type Task, type TaskDraft } from "./api";
import { planningApi, readTaskPlanning } from "./task-planning";

/** Context menus have no standalone-action draft; that explicit choice is edited in task details. */
export async function taskScheduleFromText(
  task: Task,
  text: string,
  timeZone: string,
) {
  const result = await api.previewDate({
    text,
    timeZone: task.dueTimezone || timeZone,
  });
  const timed = task.kind === "step";
  const values: Pick<
    TaskDraft,
    "dueDate" | "dueDatetime" | "dueTimezone" | "recurrence"
  > = {
    dueDate: result.dueDate,
    dueDatetime: timed ? result.dueDatetime : "",
    dueTimezone: timed ? result.dueTimezone : "",
    recurrence: result.recurrence,
  };
  return { values, ignoredClock: Boolean(result.dueDatetime) && !timed };
}

/** Called after the generic deadline clear, so only the current planning lead is changed. */
export async function clearTaskStartAhead(taskId: string): Promise<void> {
  const current = await readTaskPlanning(taskId);
  if (!current) throw new Error("Task planning is unavailable.");
  if (current.deadline)
    throw new Error(
      "The deadline changed before start-ahead could be cleared.",
    );
  if (!current.leadDays) return;
  await planningApi.setTaskLead({
    taskId,
    etag: current.etag,
    requestId: crypto.randomUUID(),
    deadline: "",
    leadDays: 0,
  });
}
