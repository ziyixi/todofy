import { api, type Task, type TaskDraft } from "./api";

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
