/**
 * The single active-timer row (`id = 'main'`), so a timer started on one device continues on another. Written
 * only on timer state changes (start, pause, resume, stop), one D1 row each.
 */
import { eq } from 'drizzle-orm';
import type { ActiveTimerSession, TimerSessionMode, TimerSessionStatus } from '../api-types.ts';
import type { Db } from '../db.ts';
import { activeTimerSession } from '../schema.ts';

const SINGLETON_ID = 'main';

/** The session, or null when it is effectively empty (idle, no task, no finished pomodoro). */
export async function getActiveTimerSession(db: Db): Promise<ActiveTimerSession | null> {
  const [row] = await db.select().from(activeTimerSession).where(eq(activeTimerSession.id, SINGLETON_ID)).limit(1);
  if (row === undefined) return null;
  const session: ActiveTimerSession = {
    taskId: row.taskId,
    flowDate: row.flowDate,
    status: row.status as TimerSessionStatus,
    timerMode: row.timerMode as TimerSessionMode,
    pomodoroTargetS: row.pomodoroTargetS,
    segmentWallStart: row.segmentWallStart,
    sessionSavedS: row.sessionSavedS,
    pomodoroFinishedTaskId: row.pomodoroFinishedTaskId,
    pomodoroFinishedFlowDate: row.pomodoroFinishedFlowDate,
    pomodoroFinishedTargetS: row.pomodoroFinishedTargetS,
    updatedAt: row.updatedAt,
  };
  if (session.status === 'idle' && session.pomodoroFinishedTaskId === null && session.taskId === null) return null;
  return session;
}

export async function saveActiveTimerSession(db: Db, session: Omit<ActiveTimerSession, 'updatedAt'>, now: Date = new Date()): Promise<void> {
  const values = { ...session, updatedAt: now.toISOString() };
  await db
    .insert(activeTimerSession)
    .values({ id: SINGLETON_ID, ...values })
    .onConflictDoUpdate({ target: activeTimerSession.id, set: values });
}

export async function clearActiveTimerSession(db: Db): Promise<void> {
  await db.delete(activeTimerSession).where(eq(activeTimerSession.id, SINGLETON_ID));
}
