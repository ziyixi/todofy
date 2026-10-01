export interface TimeEntry {
  id: string;
  taskId: string;
  flowDate: string;
  startTime: string;
  endTime: string | null;
  durationS: number | null;
  source: string;
}

export interface TimeEntryCreateBody {
  taskId?: string;
  flowDate?: string;
  startTime?: string;
  endTime?: string | null;
  durationS?: number | null;
  source?: "timer" | "manual";
}

export interface TimeEntryUpdateBody {
  startTime?: string;
  endTime?: string;
}

export interface TimerSessionPayload {
  taskId: string | null;
  flowDate: string | null;
  status: "idle" | "running" | "paused";
  timerMode: "countup" | "pomodoro";
  pomodoroTargetS: number | null;
  segmentWallStart: string | null;
  sessionSavedS: number;
  pomodoroFinishedTaskId: string | null;
  pomodoroFinishedFlowDate: string | null;
  pomodoroFinishedTargetS: number | null;
  updatedAt: string | null;
}
