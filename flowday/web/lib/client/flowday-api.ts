/**
 * FlowDay's owner API as the UI uses it: FlowDayUiService (proto/flowday/ui/v1) through the shared typed client
 * (proto/ts/http-client.ts), built from the same descriptors the Worker's transcoder routes with, over the transport of
 * ./http.ts (CSRF, the banner, the session). The request and answer shapes are the generated messages only; this
 * module turns the answers into the UI's own view models (lib/types/task.ts, the stores' state) in one place, and
 * reads every page of a list. Each function keeps the failure behaviour its callers expect: a read the next refresh
 * repairs answers null, a write reports to the banner and throws (or answers false).
 */
import type { Flow } from "@ziyixi/proto/flowday/ui/v1/flow_pb";
import {
  FlowDayUiService,
  SyncTasksRequest_Mode,
  SyncTasksResponse_State,
} from "@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb";
import type { Settings } from "@ziyixi/proto/flowday/ui/v1/settings_pb";
import type { Task as TaskMessage } from "@ziyixi/proto/flowday/ui/v1/task_pb";
import {
  TimeEntry_Source,
  TimerSession_Mode,
  TimerSession_State,
  type TimeEntry as TimeEntryMessage,
  type TimerSession,
} from "@ziyixi/proto/flowday/ui/v1/time_entry_pb";
import { createHttpClient } from "@ziyixi/proto/http-client";
import { timestampDate, timestampFromDate, type Timestamp } from "@ziyixi/proto/protobuf/wkt";
import type { TimeEntry } from "@/features/timer/contracts";
import type { ServerSessionPayload } from "@/features/timer/store/types";
import type { Task, TaskPriority } from "@/lib/types/task";
import { read, readOrNull, send, write, writeOk, type ReadOptions, type WriteOptions } from "./http";

/** FlowDayUiService: `flowday.getSettings({ name: "settings" })` resolves to a Settings message. */
export const flowday = createHttpClient(FlowDayUiService, send);

/** A fresh AIP-155 request ID (UUID4) for one create: it becomes the new resource's ID, so a resend is answered. */
export function newRequestId(): string {
  return crypto.randomUUID();
}

// ---- messages to view models --------------------------------------------------------------------------------------

function iso(timestamp: Timestamp | undefined): string | null {
  return timestamp === undefined ? null : timestampDate(timestamp).toISOString();
}

function idOf(name: string, collection: string): string {
  return name.startsWith(`${collection}/`) ? name.slice(collection.length + 1) : name;
}

function orNull(value: string): string | null {
  return value === "" ? null : value;
}

export function taskFromMessage(task: TaskMessage): Task {
  return {
    id: idOf(task.name, "tasks"),
    todoistId: orNull(task.todoistId),
    title: task.title,
    description: orNull(task.description),
    projectName: orNull(task.projectDisplayName),
    projectColor: orNull(task.projectColor),
    priority: (task.priority >= 1 && task.priority <= 4 ? task.priority : 1) as TaskPriority,
    labels: task.labels,
    estimatedMins: task.estimatedMinutes ?? null,
    isCompleted: task.completed,
    completedAt: iso(task.completeTime),
    dueDate: orNull(task.dueDate),
    createdAt: iso(task.createTime) ?? "",
    deletedAt: iso(task.deleteTime),
  };
}

export function timeEntryFromMessage(entry: TimeEntryMessage): TimeEntry {
  return {
    id: idOf(entry.name, "timeEntries"),
    taskId: entry.taskId,
    flowDate: entry.flowDate,
    startTime: iso(entry.startTime) ?? "",
    endTime: iso(entry.endTime),
    durationS: entry.durationSeconds ?? null,
    source: entry.source === TimeEntry_Source.MANUAL ? "manual" : "timer",
  };
}

function flowDateOf(flow: Flow): string {
  return idOf(flow.name, "flows");
}

/** Every page of a list: `page(token)` asks for one page; the pages' items in order. */
async function allPages<T>(page: (pageToken: string) => Promise<{ items: T[]; nextPageToken: string }>): Promise<T[]> {
  const items: T[] = [];
  let pageToken = "";
  do {
    const answer = await page(pageToken);
    items.push(...answer.items);
    pageToken = answer.nextPageToken;
  } while (pageToken !== "");
  return items;
}

// ---- tasks --------------------------------------------------------------------------------------------------------

async function listTasks(showDeleted: boolean): Promise<Task[]> {
  const tasks = await allPages(async (pageToken) => {
    const answer = await flowday.listTasks({ showDeleted, pageToken });
    return { items: answer.tasks, nextPageToken: answer.nextPageToken };
  });
  return tasks.map(taskFromMessage);
}

/** The task list (every page); null when it could not be read. */
export function loadTasks(): Promise<Task[] | null> {
  return readOrNull(() => listTasks(false));
}

/** The trash: the tasks deleted in FlowDay; null when it could not be read. */
export async function loadDeletedTasks(): Promise<Task[] | null> {
  const tasks = await readOrNull(() => listTasks(true));
  return tasks === null ? null : tasks.filter((task) => task.deletedAt !== null);
}

/** Creates a local task due on `dueDate`; throws (after the banner shows it) when it was not saved. */
export async function createLocalTask(title: string, dueDate: string): Promise<Task> {
  const task = await write(() => flowday.createTask({ task: { title, dueDate }, requestId: newRequestId() }));
  return taskFromMessage(task);
}

/** Replaces a task's estimate (null clears it); throws (after the banner shows it) when it was not saved. */
export async function updateTaskEstimate(taskId: string, estimatedMins: number | null): Promise<void> {
  await write(() =>
    flowday.updateTask({
      task: { name: `tasks/${taskId}`, ...(estimatedMins === null ? {} : { estimatedMinutes: estimatedMins }) },
      updateMask: { paths: ["estimated_minutes"] },
    })
  );
}

/** Renames a task; throws (after the banner shows it) when it was not saved. */
export async function updateTaskTitle(taskId: string, title: string): Promise<void> {
  await write(() => flowday.updateTask({ task: { name: `tasks/${taskId}`, title }, updateMask: { paths: ["title"] } }));
}

/** Deletes a task (to the trash); throws (after the banner shows it) when it was not saved. */
export async function deleteTask(taskId: string): Promise<void> {
  await write(() => flowday.deleteTask({ name: `tasks/${taskId}` }));
}

/** Brings a task back from the trash: true when it was saved (the banner shows a failure). */
export function restoreTask(taskId: string): Promise<boolean> {
  return writeOk(() => flowday.undeleteTask({ name: `tasks/${taskId}` }));
}

export type SyncMode = "auto" | "manual";

/** What one sync request did (the Worker's answer, as the task store keeps it). */
export interface SyncResult {
  status: "synced" | "partial" | "throttled";
  changed: number;
  fullSync: boolean;
  lastSyncAt: string | null;
  /** Earliest time (epoch ms) at which an automatic sync may run again. */
  nextAutoSyncAt: number;
}

/**
 * Asks the Worker to bring in Todoist's changes. The automatic sync is quiet (a failure waits for the next attempt);
 * "Sync now" shows its failure. Throws ApiError on failure.
 */
export async function syncTasks(mode: SyncMode): Promise<SyncResult> {
  const answer = await write(
    () => flowday.syncTasks({ mode: mode === "manual" ? SyncTasksRequest_Mode.MANUAL : SyncTasksRequest_Mode.AUTO }),
    { quiet: mode === "auto" }
  );
  return {
    status:
      answer.state === SyncTasksResponse_State.PARTIAL ? "partial" : answer.state === SyncTasksResponse_State.THROTTLED ? "throttled" : "synced",
    changed: answer.changedTaskCount,
    fullSync: answer.fullSync,
    lastSyncAt: iso(answer.lastSyncTime),
    nextAutoSyncAt: answer.nextAutoSyncTime === undefined ? Date.now() : timestampDate(answer.nextAutoSyncTime).getTime(),
  };
}

// ---- settings -----------------------------------------------------------------------------------------------------

/** The settings as the UI shows them (the key itself is never answered). */
export interface SettingsView {
  hasApiKey: boolean;
  lastSyncAt: string | null;
  dayCapacityMins: number;
}

function settingsFromMessage(settings: Settings): SettingsView {
  return { hasApiKey: settings.todoistApiKeySet, lastSyncAt: iso(settings.lastSyncTime), dayCapacityMins: settings.dayCapacityMinutes };
}

/** The settings; null when they could not be read. */
export async function loadSettings(): Promise<SettingsView | null> {
  const settings = await readOrNull(() => flowday.getSettings({ name: "settings" }));
  return settings === null ? null : settingsFromMessage(settings);
}

/** Stores the Todoist API key (the Worker seals it): true when it was saved (the banner shows a failure). */
export function saveTodoistKey(key: string): Promise<boolean> {
  return writeOk(() => flowday.updateSettings({ settings: { name: "settings", todoistApiKey: key }, updateMask: { paths: ["todoist_api_key"] } }));
}

/** Stores the day's capacity: true when it was saved (the banner shows a failure). */
export function saveDayCapacity(minutes: number): Promise<boolean> {
  return writeOk(() =>
    flowday.updateSettings({ settings: { name: "settings", dayCapacityMinutes: minutes }, updateMask: { paths: ["day_capacity_minutes"] } })
  );
}

// ---- flows --------------------------------------------------------------------------------------------------------

/** Every day's flow: the planned tasks in order, the done tasks, and the days whose planning is completed. */
export interface FlowSnapshot {
  flows: Record<string, string[]>;
  completedTasks: Record<string, string[]>;
  planningCompletedDates: Record<string, boolean>;
}

/** Every flow (every page); null when they could not be read. */
export function loadFlows(): Promise<FlowSnapshot | null> {
  return readOrNull(async () => {
    const flows = await allPages(async (pageToken) => {
      const answer = await flowday.listFlows({ pageToken });
      return { items: answer.flows, nextPageToken: answer.nextPageToken };
    });
    const snapshot: FlowSnapshot = { flows: {}, completedTasks: {}, planningCompletedDates: {} };
    for (const flow of flows) {
      const date = flowDateOf(flow);
      if (flow.taskIds.length > 0) snapshot.flows[date] = flow.taskIds;
      if (flow.completedTaskIds.length > 0) snapshot.completedTasks[date] = flow.completedTaskIds;
      if (flow.planningCompleted) snapshot.planningCompletedDates[date] = true;
    }
    return snapshot;
  });
}

/** Replaces a day's planned tasks in the background; on failure the banner shows it and `onFailure` runs. */
export function persistFlowTasks(date: string, taskIds: string[], onFailure: () => void): void {
  void writeOk(() => flowday.updateFlow({ flow: { name: `flows/${date}`, taskIds }, updateMask: { paths: ["task_ids"] } })).then((saved) => {
    if (!saved) onFailure();
  });
}

/** Marks a task done on a day (or takes the mark back) in the background; on failure `onFailure` runs. */
export function persistFlowCompletion(date: string, taskId: string, done: boolean, onFailure: () => void): void {
  const name = `flows/${date}`;
  void writeOk(() => (done ? flowday.completeFlowTask({ name, taskId }) : flowday.reopenFlowTask({ name, taskId }))).then((saved) => {
    if (!saved) onFailure();
  });
}

/** Marks a day's planning as completed, in the background (the banner shows a failure). */
export function persistPlanningCompleted(date: string): void {
  void writeOk(() => flowday.updateFlow({ flow: { name: `flows/${date}`, planningCompleted: true }, updateMask: { paths: ["planning_completed"] } }));
}

/**
 * Moves tasks of `fromDate` to the top of `toDate`: the listed ones (an empty list moves nothing), or with `taskIds`
 * undefined every task not done (`all_unfinished`). Throws (after the banner shows it) when it was not saved.
 */
export async function rolloverFlow(fromDate: string, toDate: string, taskIds?: string[]): Promise<void> {
  const selection = taskIds === undefined ? { allUnfinished: true } : { taskIds };
  await write(() => flowday.rolloverFlow({ name: `flows/${fromDate}`, destination: `flows/${toDate}`, ...selection }));
}

// ---- notes --------------------------------------------------------------------------------------------------------

/** A task's note of a day ("" when none); null when it could not be read. */
export async function loadNote(taskId: string, flowDate: string): Promise<string | null> {
  const note = await readOrNull(() => flowday.getNote({ name: `flows/${flowDate}/notes/${taskId}` }));
  return note === null ? null : note.content;
}

/** The notes written on a day, by task ID; null when they could not be read. */
export function loadNotesByDate(flowDate: string): Promise<Record<string, string> | null> {
  return readOrNull(async () => {
    const notes = await allPages(async (pageToken) => {
      const answer = await flowday.listNotes({ parent: `flows/${flowDate}`, pageToken });
      return { items: answer.notes, nextPageToken: answer.nextPageToken };
    });
    return Object.fromEntries(notes.map((note) => [note.name.split("/").at(-1) ?? "", note.content]));
  });
}

/** Saves a note: true when it was saved (the banner shows a failure). */
export function saveNote(taskId: string, flowDate: string, content: string): Promise<boolean> {
  return writeOk(() => flowday.updateNote({ note: { name: `flows/${flowDate}/notes/${taskId}`, content } }));
}

// ---- time entries -------------------------------------------------------------------------------------------------

async function listEntries(selector: { taskId?: string; flowDate?: string }): Promise<TimeEntry[]> {
  const entries = await allPages(async (pageToken) => {
    const answer = await flowday.listTimeEntries({ ...selector, pageToken });
    return { items: answer.timeEntries, nextPageToken: answer.nextPageToken };
  });
  return entries.map(timeEntryFromMessage);
}

/** A task's time entries by start time; null when they could not be read. */
export function loadEntriesByTask(taskId: string): Promise<TimeEntry[] | null> {
  return readOrNull(() => listEntries({ taskId }));
}

/** A day's time entries by start time; null when they could not be read. */
export function loadEntriesByDate(flowDate: string): Promise<TimeEntry[] | null> {
  return readOrNull(() => listEntries({ flowDate }));
}

export interface NewTimeEntry {
  taskId: string;
  flowDate: string;
  startTime: string;
  endTime: string | null;
  durationS: number | null;
  source: "timer" | "manual";
}

/** Logs time; throws (after the banner shows it) when it was not saved. */
export async function createTimeEntry(entry: NewTimeEntry): Promise<TimeEntry> {
  const created = await write(() =>
    flowday.createTimeEntry({
      timeEntry: {
        taskId: entry.taskId,
        flowDate: entry.flowDate,
        startTime: timestampFromDate(new Date(entry.startTime)),
        ...(entry.endTime === null ? {} : { endTime: timestampFromDate(new Date(entry.endTime)) }),
        ...(entry.durationS === null ? {} : { durationSeconds: Math.max(Math.round(entry.durationS), 0) }),
        source: entry.source === "manual" ? TimeEntry_Source.MANUAL : TimeEntry_Source.TIMER,
      },
      requestId: newRequestId(),
    })
  );
  return timeEntryFromMessage(created);
}

/** Replaces an entry's start and end (the Worker recomputes its duration); throws (after the banner) on failure. */
export async function updateTimeEntry(id: string, startTime: string, endTime: string): Promise<TimeEntry> {
  const updated = await write(() =>
    flowday.updateTimeEntry({
      timeEntry: { name: `timeEntries/${id}`, startTime: timestampFromDate(new Date(startTime)), endTime: timestampFromDate(new Date(endTime)) },
      updateMask: { paths: ["start_time", "end_time"] },
    })
  );
  return timeEntryFromMessage(updated);
}

/** Deletes an entry: true when it was deleted (the banner shows a failure). */
export function deleteTimeEntry(id: string): Promise<boolean> {
  return writeOk(() => flowday.deleteTimeEntry({ name: `timeEntries/${id}` }));
}

// ---- the timer session --------------------------------------------------------------------------------------------

const STATES = { idle: TimerSession_State.IDLE, running: TimerSession_State.RUNNING, paused: TimerSession_State.PAUSED } as const;

/** The shared timer as the timer store reads it; null for an empty session (IDLE, no task, no finished pomodoro). */
export function sessionFromMessage(session: TimerSession): ServerSessionPayload | null {
  const status = session.state === TimerSession_State.RUNNING ? "running" : session.state === TimerSession_State.PAUSED ? "paused" : "idle";
  if (status === "idle" && session.taskId === "" && session.finishedPomodoroTaskId === "") return null;
  return {
    taskId: orNull(session.taskId),
    flowDate: orNull(session.flowDate),
    status,
    timerMode: session.mode === TimerSession_Mode.POMODORO ? "pomodoro" : "countup",
    pomodoroTargetS: session.pomodoroTargetSeconds ?? null,
    segmentWallStart: iso(session.segmentStartTime),
    sessionSavedS: session.savedSeconds,
    pomodoroFinishedTaskId: orNull(session.finishedPomodoroTaskId),
    pomodoroFinishedFlowDate: orNull(session.finishedPomodoroFlowDate),
    pomodoroFinishedTargetS: session.finishedPomodoroTargetSeconds ?? null,
    updatedAt: iso(session.updateTime),
  };
}

/** The shared timer session (null when empty or when it could not be read). */
export async function loadTimerSession(): Promise<ServerSessionPayload | null> {
  const session = await readOrNull(() => flowday.getTimerSession({ name: "timerSession" }));
  return session === null ? null : sessionFromMessage(session);
}

/** Stores the shared timer session (every field): true when it was saved (the banner shows a failure). */
export function saveTimerSession(session: Omit<ServerSessionPayload, "updatedAt">): Promise<boolean> {
  return writeOk(() =>
    flowday.updateTimerSession({
      timerSession: {
        name: "timerSession",
        taskId: session.taskId ?? "",
        flowDate: session.flowDate ?? "",
        state: STATES[session.status],
        mode: session.timerMode === "pomodoro" ? TimerSession_Mode.POMODORO : TimerSession_Mode.COUNT_UP,
        ...(session.pomodoroTargetS === null ? {} : { pomodoroTargetSeconds: Math.trunc(session.pomodoroTargetS) }),
        ...(session.segmentWallStart === null ? {} : { segmentStartTime: timestampFromDate(new Date(session.segmentWallStart)) }),
        savedSeconds: Math.max(Math.trunc(session.sessionSavedS), 0),
        finishedPomodoroTaskId: session.pomodoroFinishedTaskId ?? "",
        finishedPomodoroFlowDate: session.pomodoroFinishedFlowDate ?? "",
        ...(session.pomodoroFinishedTargetS === null ? {} : { finishedPomodoroTargetSeconds: Math.trunc(session.pomodoroFinishedTargetS) }),
      },
    })
  );
}

/** Empties the shared timer session: true when it was saved (the banner shows a failure). */
export function clearTimerSession(): Promise<boolean> {
  return writeOk(() => flowday.clearTimerSession({ name: "timerSession" }));
}

// ---- analytics ----------------------------------------------------------------------------------------------------

/** A (day, task) pair of a flow, in the flow's order. */
export interface FlowRow {
  flowDate: string;
  taskId: string;
}

/** The raw rows the browser computes the reviews and exports from (every page of QueryAnalytics). */
export interface AnalyticsDataset {
  start: string | null;
  end: string | null;
  flows: FlowRow[];
  completed: FlowRow[];
  entries: TimeEntry[];
  /** Every task the rows above name (deleted ones included). */
  tasks: Task[];
  dayCapacityMins: number;
}

/** The rows of [start, end] (null: every time entry). A failure throws ApiError (with `report`, after the banner). */
export async function queryAnalytics(range: { start: string; end: string } | null, options: ReadOptions = {}): Promise<AnalyticsDataset> {
  return read(async () => {
    const dataset: AnalyticsDataset = { start: range?.start ?? null, end: range?.end ?? null, flows: [], completed: [], entries: [], tasks: [], dayCapacityMins: 0 };
    const tasks = new Map<string, Task>();
    let pageToken = "";
    do {
      const page = await flowday.queryAnalytics({ startDate: range?.start ?? "", endDate: range?.end ?? "", pageToken });
      dataset.flows.push(...page.plannedTasks.map(({ flowDate, taskId }) => ({ flowDate, taskId })));
      dataset.completed.push(...page.completedTasks.map(({ flowDate, taskId }) => ({ flowDate, taskId })));
      dataset.entries.push(...page.timeEntries.map(timeEntryFromMessage));
      for (const task of page.tasks) tasks.set(idOf(task.name, "tasks"), taskFromMessage(task));
      dataset.dayCapacityMins = page.dayCapacityMinutes;
      pageToken = page.nextPageToken;
    } while (pageToken !== "");
    dataset.tasks = [...tasks.values()];
    return dataset;
  }, options);
}

export type { ReadOptions, WriteOptions };
