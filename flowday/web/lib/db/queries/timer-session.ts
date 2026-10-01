import { eq } from "drizzle-orm";
import { getDb } from "../index";
import { activeTimerSession } from "../schema";

export type TimerSessionStatus = "idle" | "running" | "paused";
export type TimerSessionMode = "countup" | "pomodoro";

export interface ActiveTimerSession {
  taskId: string | null;
  flowDate: string | null;
  status: TimerSessionStatus;
  timerMode: TimerSessionMode;
  pomodoroTargetS: number | null;
  segmentWallStart: string | null;
  sessionSavedS: number;
  pomodoroFinishedTaskId: string | null;
  pomodoroFinishedFlowDate: string | null;
  pomodoroFinishedTargetS: number | null;
  updatedAt: string | null;
}

const SINGLETON_ID = "main";

// Returns null when the session is effectively empty (idle + no finished marker).
// Callers treat "no session" the same as "fresh timer state" on hydration.
export function getActiveTimerSession(): ActiveTimerSession | null {
  const db = getDb();
  const row = db
    .select()
    .from(activeTimerSession)
    .where(eq(activeTimerSession.id, SINGLETON_ID))
    .get();
  if (!row) return null;

  const session: ActiveTimerSession = {
    taskId: row.taskId,
    flowDate: row.flowDate,
    status: (row.status as TimerSessionStatus) ?? "idle",
    timerMode: (row.timerMode as TimerSessionMode) ?? "countup",
    pomodoroTargetS: row.pomodoroTargetS,
    segmentWallStart: row.segmentWallStart,
    sessionSavedS: row.sessionSavedS ?? 0,
    pomodoroFinishedTaskId: row.pomodoroFinishedTaskId,
    pomodoroFinishedFlowDate: row.pomodoroFinishedFlowDate,
    pomodoroFinishedTargetS: row.pomodoroFinishedTargetS,
    updatedAt: row.updatedAt,
  };

  if (session.status === "idle" && !session.pomodoroFinishedTaskId && !session.taskId) {
    return null;
  }
  return session;
}

export function saveActiveTimerSession(
  session: Omit<ActiveTimerSession, "updatedAt">
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.insert(activeTimerSession)
    .values({
      id: SINGLETON_ID,
      taskId: session.taskId,
      flowDate: session.flowDate,
      status: session.status,
      timerMode: session.timerMode,
      pomodoroTargetS: session.pomodoroTargetS,
      segmentWallStart: session.segmentWallStart,
      sessionSavedS: session.sessionSavedS,
      pomodoroFinishedTaskId: session.pomodoroFinishedTaskId,
      pomodoroFinishedFlowDate: session.pomodoroFinishedFlowDate,
      pomodoroFinishedTargetS: session.pomodoroFinishedTargetS,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: activeTimerSession.id,
      set: {
        taskId: session.taskId,
        flowDate: session.flowDate,
        status: session.status,
        timerMode: session.timerMode,
        pomodoroTargetS: session.pomodoroTargetS,
        segmentWallStart: session.segmentWallStart,
        sessionSavedS: session.sessionSavedS,
        pomodoroFinishedTaskId: session.pomodoroFinishedTaskId,
        pomodoroFinishedFlowDate: session.pomodoroFinishedFlowDate,
        pomodoroFinishedTargetS: session.pomodoroFinishedTargetS,
        updatedAt: now,
      },
    })
    .run();
}

export function clearActiveTimerSession(): void {
  const db = getDb();
  db.delete(activeTimerSession)
    .where(eq(activeTimerSession.id, SINGLETON_ID))
    .run();
}
