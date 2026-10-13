import { create } from "zustand";
import { timestampFromDate } from "@ziyixi/proto/protobuf/wkt";
import { TimerSession_Mode } from "@ziyixi/proto/flowday/ui/v1/time_entry_pb";
import { commandTimerSession, loadTimerSession, TimerAction } from "@/lib/client/flowday-api";
import { playCompletionChime } from "@/lib/utils/chime";
import { fetchPriorSeconds } from "./persistence";
import { clearTickInterval, pomodoroRemainingSeconds, resetState, STALE_FINISHED_MARKER_MS, STALE_RUNNING_SEGMENT_MS, startTickInterval, totalSeconds } from "./helpers";
import type { ServerSessionPayload, TimerState } from "./types";

type TimerInput = Omit<Parameters<typeof commandTimerSession>[0], "requestId" | "etag">;

async function applySession(session: ServerSessionPayload | null, current: () => boolean = () => true): Promise<void> {
  if (session === null) return;
  const recorded = session.taskId ? await fetchPriorSeconds(session.taskId) : 0;
  if (!current()) return;
  clearTickInterval();
  // Recorded entries already include the paused segments of this session.
  const priorSeconds = Math.max(0, recorded - session.sessionSavedS);
  useTimerStore.setState((state) => ({
    ...resetState(), etag: session.etag, entryRevision: state.entryRevision + 1,
    activeTaskId: session.taskId, activeFlowDate: session.flowDate, status: session.status,
    timerMode: session.timerMode, pomodoroTargetSeconds: session.pomodoroTargetS,
    segmentWallStart: session.segmentWallStart,
    segmentStartedAt: session.segmentWallStart ? Date.parse(session.segmentWallStart) : null,
    sessionSavedSeconds: session.sessionSavedS, priorSeconds,
    pomodoroFinishedTaskId: session.pomodoroFinishedTaskId,
    pomodoroFinishedFlowDate: session.pomodoroFinishedFlowDate,
    pomodoroFinishedTargetSeconds: session.pomodoroFinishedTargetS,
    displaySeconds: session.timerMode === "pomodoro" ? Math.max(0, (session.pomodoroTargetS ?? 0) - session.sessionSavedS) : recorded,
  }));
  if (session.status === "running") {
    useTimerStore.getState().tick();
    startTickInterval(() => useTimerStore.getState().tick());
  }
}

/** Serialize local clicks; the etag also protects against another device or window. */
let commands: Promise<unknown> = Promise.resolve();
function command(input: Partial<TimerInput> & Pick<TimerInput, "action">): Promise<boolean> {
  const run = async () => {
    useTimerStore.setState({ commandPending: true });
    try {
      if (useTimerStore.getState().etag === null) await applySession(await loadTimerSession(true));
      const etag = useTimerStore.getState().etag;
      if (etag === null) return false;
      const session = await commandTimerSession({
        taskId: "", flowDate: "", mode: TimerSession_Mode.COUNT_UP,
        ...input, requestId: crypto.randomUUID(), etag,
      });
      await applySession(session);
      if (input.action === TimerAction.FINISH_POMODORO) playCompletionChime();
      return true;
    } catch {
      // The transport displays the failure. Read the winner; never overwrite a newer timer.
      await applySession(await loadTimerSession());
      return false;
    } finally {
      useTimerStore.setState({ commandPending: false });
    }
  };
  const next = commands.then(run, run);
  commands = next;
  return next;
}

export const useTimerStore = create<TimerState>()((set, get) => ({
  ...resetState(), etag: null, commandPending: false, entryRevision: 0,
  pomodoroFinishedTaskId: null, pomodoroFinishedFlowDate: null, pomodoroFinishedTargetSeconds: null,
  startTimer: async (taskId, flowDate) => { await command({ action: TimerAction.START, taskId, flowDate }); },
  startPomodoro: async (taskId, flowDate, targetSeconds) => { await command({ action: TimerAction.START, taskId, flowDate, mode: TimerSession_Mode.POMODORO, targetSeconds }); },
  pauseTimer: async (effectiveStopMs) => { await command({ action: TimerAction.PAUSE, ...(effectiveStopMs === undefined ? {} : { effectiveStopTime: timestampFromDate(new Date(effectiveStopMs)) }) }); },
  resumeTimer: () => { void command({ action: TimerAction.RESUME }); },
  stopAndSave: () => command({ action: TimerAction.STOP }),
  stopWithoutSaving: () => { void command({ action: TimerAction.DISCARD }); },
  dismissPomodoroFinished: async () => { await command({ action: TimerAction.DISMISS_POMODORO }); },
  hydrateSession: async () => {
    if (get().commandPending) return;
    const previousEtag = get().etag;
    const session = await loadTimerSession();
    const current = () => !get().commandPending && get().etag === previousEtag;
    if (!current() || session === null) return;
    await applySession(session, current);
    if (get().etag !== session.etag || get().commandPending) return;
    if (session.status === "running" && session.segmentWallStart && Date.now() - Date.parse(session.segmentWallStart) > STALE_RUNNING_SEGMENT_MS) {
      await command({ action: TimerAction.DISCARD });
    } else if (session.pomodoroFinishedTaskId && session.updatedAt && Date.now() - Date.parse(session.updatedAt) > STALE_FINISHED_MARKER_MS) {
      await command({ action: TimerAction.DISMISS_POMODORO });
    }
  },
  tick: () => {
    const state = get();
    if (state.status !== "running") return;
    if (state.timerMode === "pomodoro") {
      const remaining = pomodoroRemainingSeconds(state);
      if (remaining <= 0 && !state.commandPending) {
        clearTickInterval();
        void command({ action: TimerAction.FINISH_POMODORO });
      }
      set({ displaySeconds: remaining });
    } else set({ displaySeconds: totalSeconds(state) });
  },
}));
