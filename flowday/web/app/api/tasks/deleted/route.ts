import {
  listDeletedTasks,
  restoreDeletedTask,
} from "@/features/tasks/services/task-service";
import {
  readJsonBody,
  serviceJson,
} from "@/lib/server/route-helpers";

export async function GET() {
  return serviceJson(listDeletedTasks());
}

export async function POST(request: Request) {
  const body = await readJsonBody<{ taskId?: string }>(request);
  return serviceJson(restoreDeletedTask(body.taskId));
}
