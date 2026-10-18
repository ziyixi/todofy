import { api, type TaskDraft } from "./api";

export function scheduledTime(datetime: string, timeZone: string): string {
  return datetime
    ? new Date(datetime).toLocaleTimeString("sv-SE", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timeZone || undefined,
      })
    : "";
}

export async function scheduledDate(
  date: string,
  time: string,
  timeZone: string,
): Promise<Pick<TaskDraft, "dueDate" | "dueDatetime" | "dueTimezone">> {
  if (!date || !time)
    return { dueDate: date, dueDatetime: "", dueTimezone: "" };
  const result = await api.previewDate({
    text: `${date} at ${time}`,
    timeZone,
  });
  return {
    dueDate: result.dueDate,
    dueDatetime: result.dueDatetime,
    dueTimezone: result.dueTimezone,
  };
}
