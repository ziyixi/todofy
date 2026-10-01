import { getNote, getNotesByDate, upsertNote } from "@/lib/db/queries/notes";
import { serviceError, serviceOk, type ServiceResult } from "@/lib/server/service-result";

export function getNotes(args: {
  taskId: string | null;
  date: string | null;
}): ServiceResult<unknown> {
  if (args.taskId && args.date) {
    const note = getNote(args.taskId, args.date);
    return serviceOk(note ?? { taskId: args.taskId, flowDate: args.date, content: "" });
  }
  if (args.date) {
    return serviceOk(getNotesByDate(args.date));
  }
  return serviceError("date query param required", 400);
}

export function saveNote(body: {
  taskId?: string;
  flowDate?: string;
  content?: string;
}): ServiceResult<ReturnType<typeof upsertNote>> {
  if (!body.taskId || !body.flowDate || typeof body.content !== "string") {
    return serviceError("taskId, flowDate, and content are required", 400);
  }
  return serviceOk(upsertNote(body.taskId, body.flowDate, body.content));
}
