export type TimerMode = "countup" | "pomodoro";

export interface TimerState {
  etag: string | null;
  commandPending: boolean;
  activeTaskId: string | null;
  activeFlowDate: string | null;
  status: "idle" | "running" | "paused";
  timerMode: TimerMode;
  pomodoroTargetSeconds: number | null;
  segmentWallStart: string | null;
  segmentStartedAt: number | null;
  sessionSavedSeconds: number;
  priorSeconds: number;
  displaySeconds: number;
  entryRevision: number;
  pomodoroFinishedTaskId: string | null;
  pomodoroFinishedFlowDate: string | null;
  pomodoroFinishedTargetSeconds: number | null;
  startTimer: (taskId: string, flowDate: string) => Promise<void>;
  startPomodoro: (
    taskId: string,
    flowDate: string,
    targetSeconds: number
  ) => Promise<void>;
  pauseTimer: (effectiveStopMs?: number) => Promise<void>;
  resumeTimer: () => void;
  stopAndSave: () => Promise<boolean>;
  stopWithoutSaving: () => void;
  dismissPomodoroFinished: () => Promise<void>;
  hydrateSession: () => Promise<void>;
  tick: () => void;
}

export interface ServerSessionPayload {
  taskId: string | null;
  flowDate: string | null;
  status: TimerState["status"];
  timerMode: TimerMode;
  pomodoroTargetS: number | null;
  segmentWallStart: string | null;
  sessionSavedS: number;
  pomodoroFinishedTaskId: string | null;
  pomodoroFinishedFlowDate: string | null;
  pomodoroFinishedTargetS: number | null;
  updatedAt: string | null;
  etag: string;
}
