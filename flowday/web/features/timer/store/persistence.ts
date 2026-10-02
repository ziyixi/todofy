import { clearTimerSession, createTimeEntry, loadEntriesByTask, loadTimerSession, saveTimerSession } from "@/lib/client/flowday-api";
import {
  sumEntryDurationSeconds,
  type DurationEntryLike,
} from "@/lib/utils/time-entries";
import type { TimerState, ServerSessionPayload } from "./types";
import { currentSegmentSeconds } from "./helpers";

interface PersistedTimerSession {
  taskId: string | null;
  flowDate: string | null;
  status: TimerState["status"];
  timerMode: TimerState["timerMode"];
  pomodoroTargetS: number | null;
  segmentWallStart: string | null;
  sessionSavedS: number;
  pomodoroFinishedTaskId: string | null;
  pomodoroFinishedFlowDate: string | null;
  pomodoroFinishedTargetS: number | null;
}

export async function loadPersistedTimerSession(): Promise<ServerSessionPayload | null> {
  return loadTimerSession();
}

// Session writes go out one after another, so a quick start-pause-resume cannot land out of order.
let sessionWrites: Promise<unknown> = Promise.resolve();

function queueSessionWrite(write: () => Promise<boolean>) {
  sessionWrites = sessionWrites.then(write, write);
}

/** Saves (or clears) the shared timer session in the background; a failure shows on the banner. */
export function persistCurrentSession(session: PersistedTimerSession | null) {
  if (!session) {
    queueSessionWrite(clearTimerSession);
    return;
  }
  queueSessionWrite(() => saveTimerSession(session));
}

export function snapshotSessionState(state: TimerState): PersistedTimerSession | null {
  if (state.status === "idle" && !state.pomodoroFinishedTaskId && !state.activeTaskId) {
    return null;
  }

  return {
    taskId: state.activeTaskId,
    flowDate: state.activeFlowDate,
    status: state.status,
    timerMode: state.timerMode,
    pomodoroTargetS: state.pomodoroTargetSeconds,
    segmentWallStart: state.segmentWallStart,
    sessionSavedS: state.sessionSavedSeconds,
    pomodoroFinishedTaskId: state.pomodoroFinishedTaskId,
    pomodoroFinishedFlowDate: state.pomodoroFinishedFlowDate,
    pomodoroFinishedTargetS: state.pomodoroFinishedTargetSeconds,
  };
}

export async function saveTimerSegment(
  state: TimerState,
  durationOverrideS?: number
): Promise<void> {
  const segmentSeconds = durationOverrideS ?? currentSegmentSeconds(state);
  if (
    segmentSeconds <= 0 ||
    !state.segmentWallStart ||
    !state.activeTaskId ||
    !state.activeFlowDate
  ) {
    return;
  }

  const segmentStartMs = new Date(state.segmentWallStart).getTime();
  const endTime = new Date(segmentStartMs + segmentSeconds * 1000).toISOString();

  // A failure shows on the banner; the user can add the time as a manual entry.
  try {
    await createTimeEntry({
      taskId: state.activeTaskId,
      flowDate: state.activeFlowDate,
      startTime: state.segmentWallStart,
      endTime,
      durationS: segmentSeconds,
      source: "timer",
    });
  } catch {
    // Already on the banner.
  }
}

export async function fetchPriorSeconds(taskId: string): Promise<number> {
  const entries: DurationEntryLike[] | null = await loadEntriesByTask(taskId);
  return sumEntryDurationSeconds(entries);
}

export function clearPersistedTimerSession() {
  queueSessionWrite(clearTimerSession);
}
