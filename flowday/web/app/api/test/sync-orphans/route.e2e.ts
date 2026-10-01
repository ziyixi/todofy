import { NextResponse } from "next/server";
import { isE2ETestModeEnabled } from "@/features/testing/server/e2e-data";
import { markOrphanedTodoistTasksDeleted } from "@/lib/db/queries/tasks";

export const dynamic = "force-dynamic";

// E2E-only: simulate the orphan-reconciliation step of a Todoist sync without
// hitting the real Todoist API. Pass the list of todoistIds the API would
// have returned; everything else gets soft-deleted with source='sync'.
export async function POST(request: Request) {
  if (!isE2ETestModeEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    activeTodoistIds?: unknown;
  };
  const ids = Array.isArray(body.activeTodoistIds)
    ? body.activeTodoistIds.filter((v): v is string => typeof v === "string")
    : [];

  const changed = markOrphanedTodoistTasksDeleted(ids);
  return NextResponse.json({ ok: true, changed });
}
