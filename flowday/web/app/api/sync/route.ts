import { syncTodoist } from "@/features/todoist/services/sync-service";
import { serviceJson } from "@/lib/server/route-helpers";

export async function POST() {
  return serviceJson(await syncTodoist());
}
