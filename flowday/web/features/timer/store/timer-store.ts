import { create } from "zustand";
import { playCompletionChime } from "@/lib/utils/chime";
import {
  clearPersistedTimerSession,
  fetchPriorSeconds,
  loadPersistedTimerSession,
  persistCurrentSession,
  saveTimerSegment,
  snapshotSessionState,
} from "./persistence";
import {
  clearTickInterval,
  currentSegmentSeconds,
  pomodoroRemainingSeconds,
  resetState,
  STALE_FINISHED_MARKER_MS,
  STALE_RUNNING_SEGMENT_MS,
  startTickInterval,
  totalSeconds,
} from "./helpers";
import type { ServerSessionPayload, TimerState } from "./types";

async function clearCurrentTimerForStart(state: TimerState): Promise<void> {
  if (state.status === "idle") return;

  clearTickInterval();

  if (state.status === "running") {
    await saveTimerSegment(state);
    useTimerStore.setState((prev) => ({
      ...resetState(),
      entryRevision: prev.entryRevision + 1,
    }));
    return;
  }

  useTimerStore.setState((prev) => ({
    ...resetState(),
    entryRevision: prev.entryRevision,
  }));
}

export const useTimerStore = create<TimerState>()((set, get) => ({
  activeTaskId: null,
  activeFlowDate: null,
  status: "idle",
  timerMode: "countup",
  pomodoroTargetSeconds: null,
  segmentWallStart: null,
  segmentStartedAt: null,
  sessionSavedSeconds: 0,
  priorSeconds: 0,
  displaySeconds: 0,
  entryRevision: 0,
  pomodoroFinishedTaskId: null,
  pomodoroFinishedFlowDate: null,
  pomodoroFinishedTargetSeconds: null,

  startTimer: async (taskId, flowDate) => {
    const state = get();
    if (state.status !== "idle" && state.activeTaskId !== taskId) {
      await clearCurrentTimerForStart(state);
    }

    const prior = await fetchPriorSeconds(taskId);
    const current = get();
    if (
      current.activeTaskId &&
      current.activeTaskId !== taskId &&
      current.status === "running"
    ) {
      return;
    }

    const now = Date.now();
    set({
      activeTaskId: taskId,
      activeFlowDate: flowDate,
      status: "running",
      timerMode: "countup",
      pomodoroTargetSeconds: null,
      segmentWallStart: new Date(now).toISOString(),
      segmentStartedAt: now,
      sessionSavedSeconds: 0,
      priorSeconds: prior,
      displaySeconds: prior,
      pomodoroFinishedTaskId: null,
      pomodoroFinishedFlowDate: null,
      pomodoroFinishedTargetSeconds: null,
    });

    persistCurrentSession(snapshotSessionState(get()));
    startTickInterval(() => get().tick());
  },

  startPomodoro: async (taskId, flowDate, targetSeconds) => {
    if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) return;

    const state = get();
    if (state.status !== "idle") {
      await clearCurrentTimerForStart(state);
    }

    const prior = await fetchPriorSeconds(taskId);
    const current = get();
    if (
      current.activeTaskId &&
      current.activeTaskId !== taskId &&
      current.status === "running"
    ) {
      return;
    }

    const now = Date.now();
    set({
      activeTaskId: taskId,
      activeFlowDate: flowDate,
      status: "running",
      timerMode: "pomodoro",
      pomodoroTargetSeconds: targetSeconds,
      segmentWallStart: new Date(now).toISOString(),
      segmentStartedAt: now,
      sessionSavedSeconds: 0,
      priorSeconds: prior,
      displaySeconds: targetSeconds,
      pomodoroFinishedTaskId: null,
      pomodoroFinishedFlowDate: null,
      pomodoroFinishedTargetSeconds: null,
    });

    persistCurrentSession(snapshotSessionState(get()));
    startTickInterval(() => get().tick());
  },

  dismissPomodoroFinished: () => {
    set({
      pomodoroFinishedTaskId: null,
      pomodoroFinishedFlowDate: null,
      pomodoroFinishedTargetSeconds: null,
    });
    persistCurrentSession(snapshotSessionState(get()));
  },

  pauseTimer: async (effectiveStopMs) => {
    const state = get();
    if (state.status !== "running") return;

    const segmentSeconds =
      effectiveStopMs != null && state.segmentStartedAt != null
        ? Math.max(
            Math.floor((effectiveStopMs - state.segmentStartedAt) / 1000),
            0
          )
        : currentSegmentSeconds(state);
    clearTickInterval();

    await saveTimerSegment(state, segmentSeconds);
    const nextSessionSaved = state.sessionSavedSeconds + segmentSeconds;
    const nextDisplay =
      state.timerMode === "pomodoro"
        ? Math.max((state.pomodoroTargetSeconds ?? 0) - nextSessionSaved, 0)
        : state.priorSeconds + nextSessionSaved;
    set((prev) => ({
      status: "paused",
      sessionSavedSeconds: nextSessionSaved,
      segmentWallStart: null,
      segmentStartedAt: null,
      displaySeconds: nextDisplay,
      entryRevision: prev.entryRevision + 1,
    }));
    persistCurrentSession(snapshotSessionState(get()));
  },

  resumeTimer: () => {
    const state = get();
    if (state.status !== "paused") return;
    if (
      state.timerMode === "pomodoro" &&
      state.pomodoroTargetSeconds != null &&
      state.sessionSavedSeconds >= state.pomodoroTargetSeconds
    ) {
      return;
    }

    set({
      status: "running",
      segmentWallStart: new Date().toISOString(),
      segmentStartedAt: Date.now(),
    });

    persistCurrentSession(snapshotSessionState(get()));
    startTickInterval(() => get().tick());
  },

  stopAndSave: async () => {
    const state = get();
    if (state.status === "idle") return;

    clearTickInterval();
    if (state.status === "running") {
      await saveTimerSegment(state);
    }
    set((prev) => ({
      ...resetState(),
      entryRevision:
        state.status === "running" ? prev.entryRevision + 1 : prev.entryRevision,
    }));
    persistCurrentSession(snapshotSessionState(get()));
  },

  stopWithoutSaving: () => {
    clearTickInterval();
    set((prev) => ({ ...resetState(), entryRevision: prev.entryRevision }));
    persistCurrentSession(snapshotSessionState(get()));
  },

  hydrateSession: async () => {
    if (typeof fetch === "undefined") return;

    const clearHydratedSession = () => {
      clearTickInterval();
      set((prev) => ({
        ...resetState(),
        entryRevision: prev.entryRevision,
        pomodoroFinishedTaskId: null,
        pomodoroFinishedFlowDate: null,
        pomodoroFinishedTargetSeconds: null,
      }));
    };

    let session: ServerSessionPayload | null = null;
    try {
      session = await loadPersistedTimerSession();
    } catch {
      return;
    }
    if (!session) {
      clearHydratedSession();
      return;
    }

    const {
      taskId,
      flowDate,
      status,
      timerMode,
      pomodoroTargetS,
      segmentWallStart,
      sessionSavedS,
      pomodoroFinishedTaskId,
      pomodoroFinishedFlowDate,
      pomodoroFinishedTargetS,
      updatedAt,
    } = session;

    clearTickInterval();

    if (status === "idle" && pomodoroFinishedTaskId) {
      if (updatedAt) {
        const age = Date.now() - Date.parse(updatedAt);
        if (age > STALE_FINISHED_MARKER_MS) {
          clearHydratedSession();
          clearPersistedTimerSession();
          return;
        }
      }
      set((prev) => ({
        ...resetState(),
        entryRevision: prev.entryRevision,
        pomodoroFinishedTaskId,
        pomodoroFinishedFlowDate,
        pomodoroFinishedTargetSeconds: pomodoroFinishedTargetS,
      }));
      return;
    }

    if (!taskId || !flowDate) {
      clearHydratedSession();
      return;
    }

    if (status === "running" && segmentWallStart) {
      const age = Date.now() - Date.parse(segmentWallStart);
      if (age > STALE_RUNNING_SEGMENT_MS) {
        clearHydratedSession();
        clearPersistedTimerSession();
        return;
      }
    }

    const prior = await fetchPriorSeconds(taskId);

    if (status === "running" && segmentWallStart) {
      const segmentStartedAt = Date.parse(segmentWallStart);
      set({
        activeTaskId: taskId,
        activeFlowDate: flowDate,
        status: "running",
        timerMode,
        pomodoroTargetSeconds: pomodoroTargetS,
        segmentWallStart,
        segmentStartedAt,
        sessionSavedSeconds: sessionSavedS,
        priorSeconds: prior,
        displaySeconds:
          timerMode === "pomodoro"
            ? Math.max((pomodoroTargetS ?? 0) - sessionSavedS, 0)
            : prior + sessionSavedS,
        pomodoroFinishedTaskId: null,
        pomodoroFinishedFlowDate: null,
        pomodoroFinishedTargetSeconds: null,
      });
      get().tick();
      startTickInterval(() => get().tick());
      return;
    }

    if (status === "paused") {
      set({
        activeTaskId: taskId,
        activeFlowDate: flowDate,
        status: "paused",
        timerMode,
        pomodoroTargetSeconds: pomodoroTargetS,
        segmentWallStart: null,
        segmentStartedAt: null,
        sessionSavedSeconds: sessionSavedS,
        priorSeconds: prior,
        displaySeconds:
          timerMode === "pomodoro"
            ? Math.max((pomodoroTargetS ?? 0) - sessionSavedS, 0)
            : prior + sessionSavedS,
        pomodoroFinishedTaskId: null,
        pomodoroFinishedFlowDate: null,
        pomodoroFinishedTargetSeconds: null,
      });
    }
  },

  tick: () => {
    const state = get();
    if (state.status !== "running") return;

    if (state.timerMode === "pomodoro") {
      const remaining = pomodoroRemainingSeconds(state);
      if (remaining <= 0) {
        clearTickInterval();
        playCompletionChime();
        const segmentSecondsToSave = Math.max(
          (state.pomodoroTargetSeconds ?? 0) - state.sessionSavedSeconds,
          0
        );
        const finishedTaskId = state.activeTaskId;
        const finishedFlowDate = state.activeFlowDate;
        const finishedTarget = state.pomodoroTargetSeconds;

        void (async () => {
          if (segmentSecondsToSave > 0) {
            await saveTimerSegment(state, segmentSecondsToSave);
          }

          set((prev) => ({
            ...resetState(),
            entryRevision: prev.entryRevision + (segmentSecondsToSave > 0 ? 1 : 0),
            pomodoroFinishedTaskId: finishedTaskId,
            pomodoroFinishedFlowDate: finishedFlowDate,
            pomodoroFinishedTargetSeconds: finishedTarget,
          }));
          persistCurrentSession(snapshotSessionState(get()));
        })();
        return;
      }

      set({ displaySeconds: remaining });
      return;
    }

    set({ displaySeconds: totalSeconds(state) });
  },
}));
