/**
 * The Worker's own records: what the store (./store/*) reads from and writes to D1, and what the sync (./sync.ts)
 * reports. They are not the wire: the owner API's shapes are the messages of flowday.ui.v1
 * (proto/flowday/ui/v1, generated into @ziyixi/proto), which ./api.ts builds from these records.
 */

/** Todoist's priority scale: 1 (normal) to 4 (urgent). */
export type TaskPriority = 1 | 2 | 3 | 4;

/** A row of `tasks`, as stored (times as stored strings, absent values null). */
export interface TaskRecord {
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

/** A row of `time_entries`. */
export interface TimeEntryRecord {
  id: string;
  taskId: string;
  flowDate: string;
  startTime: string;
  endTime: string | null;
  durationS: number | null;
  source: string;
  createdAt: string | null;
}

/** A row of `flow_task_notes` (or the empty note of a task and day without one: `updatedAt` null). */
export interface NoteRecord {
  taskId: string;
  flowDate: string;
  content: string;
  updatedAt: string | null;
}

export type TimerSessionStatus = 'idle' | 'running' | 'paused';
export type TimerSessionMode = 'countup' | 'pomodoro';

/** The row of `active_timer_session` (the column values the container era wrote). */
export interface TimerSessionRecord {
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
 * What one sync request did (flowday.ui.v1 SyncTasksResponse). `synced`: Todoist was read and its answer applied;
 * `changed` task rows were written. `partial`: part of a large answer was applied (or a full pass must follow); the
 * page asks again right away. `throttled`: another tab or device synced within the minimum interval; nothing was
 * read or written.
 */
export interface SyncResult {
  status: 'synced' | 'partial' | 'throttled';
  /** Task rows this sync inserted, updated, hid or restored (0 when nothing changed). */
  changed: number;
  /** Whether Todoist answered with a full sync (first sync, new token, or Todoist reset the sync token). */
  fullSync: boolean;
  lastSyncAt: string | null;
  /** Earliest time (epoch ms) at which an automatic sync may run again (later after failed syncs). */
  nextAutoSyncAt: number;
}

/** A (day, task) pair of a flow or of a day's done tasks, in order. */
export interface FlowTaskRow {
  flowDate: string;
  taskId: string;
}
