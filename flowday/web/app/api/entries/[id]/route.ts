import { updateEntry, removeEntry } from "@/features/timer/services/entries-service";
import { readJsonBody, serviceJson } from "@/lib/server/route-helpers";
import type { TimeEntryUpdateBody } from "@/features/timer/contracts";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return serviceJson(updateEntry(id, await readJsonBody<TimeEntryUpdateBody>(request)));
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return serviceJson(removeEntry(id));
}
