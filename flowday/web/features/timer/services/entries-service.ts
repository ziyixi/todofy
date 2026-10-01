import {
  createTimeEntry,
  deleteTimeEntry,
  getEntriesByDate,
  getEntriesByTask,
  getEntriesByTaskAndDate,
  updateTimeEntry,
} from "@/lib/db/queries/entries";
import { serviceError, serviceOk, type ServiceResult } from "@/lib/server/service-result";
import type {
  TimeEntryCreateBody,
  TimeEntryUpdateBody,
} from "../contracts";

export function createEntry(
  body: TimeEntryCreateBody
): ServiceResult<{
  id: string;
  taskId: string;
  flowDate: string;
  startTime: string;
  endTime?: string | null;
  durationS?: number | null;
  source?: "timer" | "manual";
}> {
  if (!body.taskId || !body.flowDate || !body.startTime) {
    return serviceError("taskId, flowDate, and startTime are required", 400);
  }

  const id = crypto.randomUUID();
  createTimeEntry({
    id,
    taskId: body.taskId,
    flowDate: body.flowDate,
    startTime: body.startTime,
    endTime: body.endTime ?? null,
    durationS: body.durationS ?? null,
    source: body.source ?? "timer",
  });

  return serviceOk(
    {
      id,
      taskId: body.taskId,
      flowDate: body.flowDate,
      startTime: body.startTime,
      endTime: body.endTime,
      durationS: body.durationS,
      source: body.source,
    },
    201
  );
}

export function listEntries(args: {
  taskId: string | null;
  date: string | null;
}): ServiceResult<unknown> {
  if (args.taskId && args.date) {
    return serviceOk(getEntriesByTaskAndDate(args.taskId, args.date));
  }
  if (args.taskId) {
    return serviceOk(getEntriesByTask(args.taskId));
  }
  if (args.date) {
    return serviceOk(getEntriesByDate(args.date));
  }
  return serviceError("At least 'taskId' or 'date' query parameter is required", 400);
}

export function updateEntry(
  id: string,
  body: TimeEntryUpdateBody
): ServiceResult<{ id: string; startTime: string; endTime: string; durationS: number }> {
  if (!body.startTime || !body.endTime) {
    return serviceError("startTime and endTime are required", 400);
  }

  const durationS = Math.floor(
    (new Date(body.endTime).getTime() - new Date(body.startTime).getTime()) / 1000
  );
  const updated = updateTimeEntry(id, {
    startTime: body.startTime,
    endTime: body.endTime,
    durationS,
  });
  if (!updated) {
    return serviceError("Entry not found", 404);
  }

  return serviceOk({
    id,
    startTime: body.startTime,
    endTime: body.endTime,
    durationS,
  });
}

export function removeEntry(id: string): ServiceResult<{ success: true }> {
  const deleted = deleteTimeEntry(id);
  if (!deleted) {
    return serviceError("Entry not found", 404);
  }
  return serviceOk({ success: true });
}
