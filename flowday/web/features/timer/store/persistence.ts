import { loadEntriesByTask } from "@/lib/client/flowday-api";
import { sumEntryDurationSeconds } from "@/lib/utils/time-entries";

export async function fetchPriorSeconds(taskId: string): Promise<number> {
  return sumEntryDurationSeconds(await loadEntriesByTask(taskId));
}
