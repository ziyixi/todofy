/**
 * JSON shapes of FlowDay's API (/api/*), shared with the UI (../../web/lib/types/worker-contract.ts checks that the
 * UI's own types match these). Type-only: no runtime code, so the UI can import it without bundling Worker code.
 */

export type TaskPriority = 1 | 2 | 3 | 4;

export interface Task {
  id: string;
  todoistId: string | null;
  title: string;
  description: string | null;
  projectName: string | null;
  projectColor: string | null;
  priority: TaskPriority;
  labels: string[];
  estimatedMins: number | null;
  isCompleted: boolean;
  completedAt: string | null;
  dueDate: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface TimeEntry {
  id: string;
  taskId: string;
  flowDate: string;
  startTime: string;
  endTime: string | null;
  durationS: number | null;
  source: string;
  createdAt: string | null;
}

export interface FlowStateResponse {
  flows: Record<string, string[]>;
  completedTasks: Record<string, string[]>;
}

export interface NoteResponse {
  taskId: string;
  flowDate: string;
  content: string;
  updatedAt?: string | null;
}

export interface SettingsResponse {
  /** A mask when a key is stored, never the key. */
  todoist_api_key: string | null;
  has_api_key: boolean;
  last_sync_at: string | null;
  day_capacity_mins: number;
  planning_completed_today: boolean;
}

export type TimerSessionStatus = 'idle' | 'running' | 'paused';
export type TimerSessionMode = 'countup' | 'pomodoro';

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

/**
 * POST /api/sync. `synced`: Todoist was read and `changed` task rows were written. `throttled`: another tab or
 * device synced within the minimum interval; nothing was read or written. Without a stored Todoist key the answer
 * is the error 400 no_todoist_key.
 */
export interface SyncResponse {
  status: 'synced' | 'throttled';
  /** Task rows this sync inserted, updated, hid or restored (0 when nothing changed). */
  changed: number;
  /** Whether Todoist answered with a full sync (first sync, new token, or Todoist reset the sync token). */
  fullSync: boolean;
  lastSyncAt: string | null;
  /** Earliest time (epoch ms) at which an automatic sync may run again. */
  nextAutoSyncAt: number;
}

/** The raw rows the browser computes the daily, weekly and work-pattern reviews and the exports from. */
export interface AnalyticsDataset {
  start: string | null;
  end: string | null;
  flows: { flowDate: string; taskId: string }[];
  completed: { flowDate: string; taskId: string }[];
  entries: TimeEntry[];
  /** Every task referenced by the rows above (deleted ones included), keyed by nothing: a list. */
  tasks: Task[];
  dayCapacityMins: number;
}

export interface CsrfResponse {
  token: string;
}

export interface ApiError {
  error: { code: string; message: string; request_id: string };
}
