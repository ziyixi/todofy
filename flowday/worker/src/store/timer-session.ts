/**
 * The single active-timer row (`id = 'main'`), so a timer started on one device continues on another. Written
 * through the atomic command handler only. Reads keep the idle row's version for the next command.
 */
import { eq } from 'drizzle-orm';
import type { TimerSessionMode, TimerSessionRecord, TimerSessionStatus } from '../model.ts';
import type { Db } from '../db.ts';
import { activeTimerSession } from '../schema.ts';

const SINGLETON_ID = 'main';

/** The stored session, or null before the first command. */
export async function getActiveTimerSession(db: Db): Promise<TimerSessionRecord | null> {
  const [row] = await db.select().from(activeTimerSession).where(eq(activeTimerSession.id, SINGLETON_ID)).limit(1);
  if (row === undefined) return null;
  return {
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
    etag: row.etag,
  };
}
