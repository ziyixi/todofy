import { createEntry, listEntries } from "@/features/timer/services/entries-service";
import {
  getSearchParams,
  readJsonBody,
  serviceJson,
} from "@/lib/server/route-helpers";
import type { TimeEntryCreateBody } from "@/features/timer/contracts";

export async function POST(request: Request) {
  return serviceJson(createEntry(await readJsonBody<TimeEntryCreateBody>(request)));
}

export async function GET(request: Request) {
  const searchParams = getSearchParams(request);
  return serviceJson(
    listEntries({
      taskId: searchParams.get("taskId"),
      date: searchParams.get("date"),
    })
  );
}
