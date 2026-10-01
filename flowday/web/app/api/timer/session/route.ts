import { saveTimerSession, getTimerSession, clearTimerSession } from "@/features/timer/services/timer-session-service";
import { readJsonBody, serviceJson } from "@/lib/server/route-helpers";
import type { ActiveTimerSession } from "@/lib/db/queries/timer-session";

export async function GET() {
  return serviceJson(getTimerSession());
}

export async function PUT(request: Request) {
  return serviceJson(saveTimerSession(await readJsonBody<Partial<ActiveTimerSession>>(request)));
}

export async function DELETE() {
  return serviceJson(clearTimerSession());
}
