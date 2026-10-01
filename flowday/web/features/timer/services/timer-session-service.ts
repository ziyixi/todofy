import {
  clearActiveTimerSession,
  getActiveTimerSession,
  saveActiveTimerSession,
  type ActiveTimerSession,
  type TimerSessionMode,
  type TimerSessionStatus,
} from "@/lib/db/queries/timer-session";
import { serviceOk } from "@/lib/server/service-result";

const STATUSES: readonly TimerSessionStatus[] = ["idle", "running", "paused"];
const MODES: readonly TimerSessionMode[] = ["countup", "pomodoro"];

function asNullableString(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : null;
}

function asNullableInt(value: unknown): number | null {
  if (value == null) return null;
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

export function getTimerSession() {
  return serviceOk({ session: getActiveTimerSession() });
}

export function saveTimerSession(body: Partial<ActiveTimerSession>) {
  const status = STATUSES.includes(body.status as TimerSessionStatus)
    ? (body.status as TimerSessionStatus)
    : "idle";
  const timerMode = MODES.includes(body.timerMode as TimerSessionMode)
    ? (body.timerMode as TimerSessionMode)
    : "countup";

  saveActiveTimerSession({
    taskId: asNullableString(body.taskId),
    flowDate: asNullableString(body.flowDate),
    status,
    timerMode,
    pomodoroTargetS: asNullableInt(body.pomodoroTargetS),
    segmentWallStart: asNullableString(body.segmentWallStart),
    sessionSavedS: Math.max(asNullableInt(body.sessionSavedS) ?? 0, 0),
    pomodoroFinishedTaskId: asNullableString(body.pomodoroFinishedTaskId),
    pomodoroFinishedFlowDate: asNullableString(body.pomodoroFinishedFlowDate),
    pomodoroFinishedTargetS: asNullableInt(body.pomodoroFinishedTargetS),
  });

  return serviceOk({ success: true });
}

export function clearTimerSession() {
  clearActiveTimerSession();
  return serviceOk({ success: true });
}
