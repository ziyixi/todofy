import {
  addCompletedFlowTask,
  getAllCompletedFlowTasks,
  getAllFlows,
  removeCompletedFlowTask,
  setFlowTaskIds,
} from "@/lib/db/queries/flows";
import { serviceError, serviceOk, type ServiceResult } from "@/lib/server/service-result";
import type { FlowMutationAction, FlowStateResponse } from "../contracts";

export function getFlowState(): ServiceResult<FlowStateResponse> {
  return serviceOk({
    flows: getAllFlows(),
    completedTasks: getAllCompletedFlowTasks(),
  });
}

function rolloverAllTasks(fromDate: string, toDate: string) {
  const allFlows = getAllFlows();
  const allCompleted = getAllCompletedFlowTasks();
  const sourceTasks = allFlows[fromDate] ?? [];
  const completedSet = new Set(allCompleted[fromDate] ?? []);
  const incomplete = sourceTasks.filter((id) => !completedSet.has(id));
  if (incomplete.length === 0) return;

  const existing = allFlows[toDate] ?? [];
  const existingSet = new Set(existing);
  const toAdd = incomplete.filter((id) => !existingSet.has(id));
  if (toAdd.length > 0) {
    setFlowTaskIds(toDate, [...toAdd, ...existing]);
  }

  const remaining = sourceTasks.filter(
    (id) => completedSet.has(id) || !incomplete.includes(id)
  );
  setFlowTaskIds(fromDate, remaining);
}

function rolloverSelectedTasks(fromDate: string, toDate: string, taskIds: string[]) {
  const selectedSet = new Set(taskIds);
  const allFlows = getAllFlows();
  const sourceTasks = allFlows[fromDate] ?? [];
  const toMove = sourceTasks.filter((id) => selectedSet.has(id));
  if (toMove.length === 0) return;

  const existing = allFlows[toDate] ?? [];
  const existingSet = new Set(existing);
  const toAdd = toMove.filter((id) => !existingSet.has(id));
  if (toAdd.length > 0) {
    setFlowTaskIds(toDate, [...toAdd, ...existing]);
  }

  setFlowTaskIds(
    fromDate,
    sourceTasks.filter((id) => !selectedSet.has(id))
  );
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

// Keep the route's existing 400 messages while narrowing unknown JSON into the
// discriminated union the mutation logic actually expects.
function parseFlowMutationAction(body: unknown): ServiceResult<FlowMutationAction> {
  const record = asObjectRecord(body);
  const date = record?.date;
  if (typeof date !== "string" || !date) {
    return serviceError("date is required", 400);
  }

  switch (record?.action) {
    case "setFlow":
      if (!Array.isArray(record.taskIds)) {
        return serviceError("taskIds array required", 400);
      }
      return serviceOk({
        action: "setFlow",
        date,
        taskIds: record.taskIds as string[],
      });

    case "addCompleted":
    case "removeCompleted": {
      if (typeof record.taskId !== "string" || !record.taskId) {
        return serviceError("taskId required", 400);
      }
      return serviceOk({
        action: record.action,
        date,
        taskId: record.taskId,
      });
    }

    case "rollover":
      if (typeof record.fromDate !== "string" || typeof record.toDate !== "string") {
        return serviceError("fromDate and toDate required", 400);
      }
      return serviceOk({
        action: "rollover",
        date,
        fromDate: record.fromDate,
        toDate: record.toDate,
      });

    case "rolloverSelected":
      if (
        typeof record.fromDate !== "string" ||
        typeof record.toDate !== "string" ||
        !Array.isArray(record.taskIds)
      ) {
        return serviceError("fromDate, toDate, and taskIds required", 400);
      }
      return serviceOk({
        action: "rolloverSelected",
        date,
        fromDate: record.fromDate,
        toDate: record.toDate,
        taskIds: record.taskIds as string[],
      });

    default:
      return serviceError("Unknown action", 400);
  }
}

export function mutateFlow(body: unknown): ServiceResult<{ success: true }> {
  const parsed = parseFlowMutationAction(body);
  if (!parsed.ok) {
    return parsed;
  }

  switch (parsed.data.action) {
    case "setFlow":
      setFlowTaskIds(parsed.data.date, parsed.data.taskIds);
      return serviceOk({ success: true });

    case "addCompleted":
      addCompletedFlowTask(parsed.data.date, parsed.data.taskId);
      return serviceOk({ success: true });

    case "removeCompleted":
      removeCompletedFlowTask(parsed.data.date, parsed.data.taskId);
      return serviceOk({ success: true });

    case "rollover":
      rolloverAllTasks(parsed.data.fromDate, parsed.data.toDate);
      return serviceOk({ success: true });

    case "rolloverSelected":
      rolloverSelectedTasks(parsed.data.fromDate, parsed.data.toDate, parsed.data.taskIds);
      return serviceOk({ success: true });
  }
}
