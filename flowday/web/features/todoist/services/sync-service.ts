import { getSetting } from "@/lib/db/queries/settings";
import { serviceError, serviceOk, type ServiceResult } from "@/lib/server/service-result";
import { syncTodoistToDb } from "@/lib/todoist/sync";
import type { SyncResponse } from "../contracts";

export async function syncTodoist(): Promise<ServiceResult<SyncResponse>> {
  const apiKey = getSetting("todoist_api_key");
  if (!apiKey) {
    return serviceError("No Todoist API key configured. Add one in Settings.", 400);
  }

  try {
    const result = await syncTodoistToDb();
    if (result.error) {
      return serviceError(result.error, 400);
    }
    return serviceOk({
      taskCount: result.taskCount,
      lastSyncAt: getSetting("last_sync_at"),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return serviceError(message, 500);
  }
}
