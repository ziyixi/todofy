import {
  createTask,
  deleteTask,
  listTasks,
  patchTask,
} from "@/features/tasks/services/task-service";
import {
  readJsonBody,
  serviceJson,
} from "@/lib/server/route-helpers";
import type {
  TaskCreateBody,
  TaskDeleteBody,
  TaskPatchBody,
} from "@/features/tasks/contracts";

export async function GET() {
  return serviceJson(listTasks());
}

export async function POST(request: Request) {
  return serviceJson(createTask(await readJsonBody<TaskCreateBody>(request)));
}

export async function PATCH(request: Request) {
  return serviceJson(patchTask(await readJsonBody<TaskPatchBody>(request)));
}

export async function DELETE(request: Request) {
  return serviceJson(deleteTask(await readJsonBody<TaskDeleteBody>(request)));
}
