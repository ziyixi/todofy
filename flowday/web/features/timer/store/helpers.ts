import type { TimerState } from "./types";

let intervalId: ReturnType<typeof setInterval> | null = null;

// Drop a running segment on hydrate if its wall-clock start is this far in the
// past — 6 hours assumes any single unattended session that old was abandoned
// and the auto-idle hook would have paused a live session long before this.
export const STALE_RUNNING_SEGMENT_MS = 6 * 60 * 60 * 1000;
// Skip hydrating a finished-pomodoro marker older than this; the user can
// always restart manually if the stale marker was still relevant.
export const STALE_FINISHED_MARKER_MS = 60 * 60 * 1000;

export function clearTickInterval() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export function startTickInterval(tick: () => void) {
  clearTickInterval();
  intervalId = setInterval(tick, 1000);
}

export function currentSegmentSeconds(state: TimerState): number {
  if (!state.segmentStartedAt) return 0;
  return Math.floor((Date.now() - state.segmentStartedAt) / 1000);
}

export function totalSeconds(state: TimerState): number {
  return state.priorSeconds + state.sessionSavedSeconds + currentSegmentSeconds(state);
}

export function pomodoroRemainingSeconds(state: TimerState): number {
  if (state.pomodoroTargetSeconds == null) return 0;
  const elapsed = state.sessionSavedSeconds + currentSegmentSeconds(state);
  return Math.max(state.pomodoroTargetSeconds - elapsed, 0);
}

export function resetState(): Omit<
  TimerState,
  | "entryRevision"
  | "pomodoroFinishedTaskId"
  | "pomodoroFinishedFlowDate"
  | "pomodoroFinishedTargetSeconds"
  | "startTimer"
  | "startPomodoro"
  | "pauseTimer"
  | "resumeTimer"
  | "stopAndSave"
  | "stopWithoutSaving"
  | "dismissPomodoroFinished"
  | "hydrateSession"
  | "tick"
> {
  return {
    activeTaskId: null,
    activeFlowDate: null,
    status: "idle" as const,
    timerMode: "countup" as const,
    pomodoroTargetSeconds: null,
    segmentWallStart: null,
    segmentStartedAt: null,
    sessionSavedSeconds: 0,
    priorSeconds: 0,
    displaySeconds: 0,
  };
}
