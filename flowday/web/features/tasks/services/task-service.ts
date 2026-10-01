import {
  createLocalTask,
  getAllTasks,
  getDeletedTasks,
  removeTaskFromFlows,
  restoreTask,
  softDeleteTask,
  updateTaskEstimate,
  updateTaskTitle,
} from "@/lib/db/queries/tasks";
import { serviceError, serviceOk, type ServiceResult } from "@/lib/server/service-result";
import type {
  TaskCreateBody,
  TaskDeleteBody,
  TaskPatchBody,
} from "../contracts";

export function listTasks() {
  return serviceOk(getAllTasks());
}

export function createTask(body: TaskCreateBody): ServiceResult<ReturnType<typeof createLocalTask>> {
  if (typeof body.title !== "string" || !body.title.trim()) {
    return serviceError("title is required", 400);
  }

  const task = createLocalTask({
    title: body.title.trim(),
    priority: typeof body.priority === "number" ? body.priority : undefined,
    dueDate: typeof body.dueDate === "string" ? body.dueDate : undefined,
    estimatedMins:
      typeof body.estimatedMins === "number" ? body.estimatedMins : undefined,
    labels: Array.isArray(body.labels) ? body.labels : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
  });

  return serviceOk(task, 201);
}

export function patchTask(body: TaskPatchBody): ServiceResult<{ success: true }> {
  if (typeof body.taskId !== "string") {
    return serviceError("taskId required", 400);
  }

  if (typeof body.title === "string") {
    if (!body.title.trim()) {
      return serviceError("title cannot be empty", 400);
    }
    updateTaskTitle(body.taskId, body.title.trim());
  }

  if ("estimatedMins" in body) {
    const mins =
      body.estimatedMins === null || body.estimatedMins === ""
        ? null
        : Number(body.estimatedMins);
    if (mins !== null && (Number.isNaN(mins) || mins < 0)) {
      return serviceError("Invalid estimatedMins", 400);
    }
    updateTaskEstimate(body.taskId, mins);
  }

  return serviceOk({ success: true });
}

export function deleteTask(body: TaskDeleteBody): ServiceResult<{ success: true }> {
  if (typeof body.taskId !== "string") {
    return serviceError("taskId required", 400);
  }

  softDeleteTask(body.taskId);
  removeTaskFromFlows(body.taskId);
  return serviceOk({ success: true });
}

export function listDeletedTasks() {
  return serviceOk(getDeletedTasks());
}

export function restoreDeletedTask(taskId: string | undefined): ServiceResult<{ success: true }> {
  if (typeof taskId !== "string") {
    return serviceError("taskId required", 400);
  }

  restoreTask(taskId);
  return serviceOk({ success: true });
}
