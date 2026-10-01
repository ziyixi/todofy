import { getNotes, saveNote } from "@/features/flow/services/notes-service";
import {
  getSearchParams,
  readJsonBody,
  serviceJson,
} from "@/lib/server/route-helpers";

export async function GET(request: Request) {
  const searchParams = getSearchParams(request);
  return serviceJson(
    getNotes({
      taskId: searchParams.get("taskId"),
      date: searchParams.get("date"),
    })
  );
}

export async function PUT(request: Request) {
  return serviceJson(
    saveNote(
      await readJsonBody<{
        taskId?: string;
        flowDate?: string;
        content?: string;
      }>(request)
    )
  );
}
