// UI state. API messages are mapped from the root generated proto in api.ts.
export type Area = "work" | "personal" | "unassigned";
export type Stage = "none" | "quarterly" | "monthly" | "weekly" | "committed";
export type View = "plan" | "focus";
export type Language = "en" | "zh";
export interface PlanningTask {
  id: string;
  title: string;
  parentId: string;
  projectId: string;
  labels: string[];
  area: Area;
  stage: Stage;
  bet: boolean;
  priority: number;
  deadline: string;
  leadDays: number;
  due: string;
  estimatedMinutes?: number;
  etag: string;
  mustStart: boolean;
  missingLead: boolean;
  /** Todoist's last change to the task (ISO time); absent when Todoist does not say. */
  updatedAt?: string;
}
export interface PlanState {
  tasks: PlanningTask[];
  week: string;
  timezone: string;
  configured: boolean;
  hiddenFilterIds: string[];
  flowdayUrl: string;
  managedLabelNames: string[];
  managedLabels: { role: string; id: string; label: string }[];
  etag: string;
  availableLabels: { id: string; label: string }[];
  /** Todofy's mail project, for the weekly review's inbox line; empty when not configured. */
  inboxProjectId: string;
  /** Newest weekly review task Todofy created; the active task list says whether it is open. */
  reviewTaskId: string;
  /** Commitments and Bets chosen on this week's Sunday, which Monday's reset keeps. */
  nextWeekTaskIds: string[];
}
/** Account planning settings without the task list. */
export type PlanMetadata = Omit<PlanState, "tasks">;
/**
 * What Plus replaces in native Todoist, by ID only. The background caches it on disk so the
 * sidebar is arranged as soon as a page mounts; it never holds task content.
 */
export interface PlanConfig {
  configured: boolean;
  hiddenFilterIds: string[];
  labelIds: string[];
}
export interface FlowDayPlan {
  date: string;
  taskIds: string[];
  completedTaskIds: string[];
}
/** A write's server-confirmed result; void means only a re-read can show it. */
export type Confirmed =
  | void
  | FlowDayPlan[]
  | PlanningTask
  | PlanningTask[]
  | PlanMetadata
  | TimerSnapshot;
/**
 * A write shown before it is confirmed. Only the named cards wait, dimmed and fixed in place,
 * with the predicted change if any; a failure drops it again.
 */
export interface PendingChange {
  pending: string[];
  predict?: (data: PlusData) => PlusData;
}
/**
 * Runs a write after the earlier ones. Without a pending change the write is confirm-first:
 * write controls stay disabled until the server confirms it.
 */
export type RunOperation = (
  operation: () => Promise<Confirmed>,
  change?: PendingChange,
) => Promise<boolean>;
export interface FocusState extends FlowDayPlan {
  timerEtag: string;
  estimates: Record<string, number>;
  flowTasks: Record<
    string,
    { title: string; local: boolean; estimatedMinutes?: number }
  >;
  timer?: {
    taskId: string;
    flowDate: string;
    status: "running" | "paused";
    elapsedSeconds: number;
    startedAt: string;
    etag: string;
  };
}
export interface StepDraft {
  title: string;
  estimatedMinutes?: number;
}
export interface PlusData {
  plan: PlanState;
  focus: FocusState;
  days: FlowDayPlan[];
}
/** The last confirmed data, kept only in content-script memory between visits. */
export interface PlusSnapshot {
  data: PlusData;
  /** When the complete data was last read; confirmed writes may be merged since. */
  readAt: number;
}
export interface TimerSnapshot {
  timerEtag: string;
  timer?: FocusState["timer"];
}
export interface PlusActions {
  load(weekStart?: string): Promise<PlusData>;
  readPlan(): Promise<PlanMetadata>;
  loadDays(weekStart: string): Promise<FlowDayPlan[]>;
  /** `active` adds or removes the literal in-progress label, which the account must have. */
  updateTask(
    task: PlanningTask,
    update: { stage?: Stage; area?: Area; bet?: boolean; active?: boolean },
  ): Promise<PlanningTask>;
  updateLabels(
    labels: { role: string; id: string; label: string }[],
    etag: string,
  ): Promise<PlanMetadata>;
  createSteps(
    task: PlanningTask,
    steps: StepDraft[],
    requestId: string,
  ): Promise<void>;
  updateLead(
    task: PlanningTask,
    deadline: string,
    leadDays: number,
  ): Promise<PlanningTask>;
  completeTask(
    task: PlanningTask,
    requestId: string,
    flowDate: string,
  ): Promise<void>;
  /**
   * Adds or removes one step in the day's current FlowDay queue, not in the copy on screen:
   * UpdateFlow replaces the whole queue without an etag.
   */
  addToDay(taskId: string, date: string): Promise<FlowDayPlan[]>;
  removeFromDay(taskId: string, date: string): Promise<FlowDayPlan[]>;
  moveTaskToDay(
    taskId: string,
    source: FlowDayPlan | undefined,
    target: FlowDayPlan,
    beforeId?: string,
  ): Promise<FlowDayPlan[]>;
  updateEstimate(taskId: string, minutes: number): Promise<void>;
  timer(
    action: "start" | "pause" | "resume" | "stop",
    taskId: string,
    focus: FocusState,
  ): Promise<TimerSnapshot>;
}
