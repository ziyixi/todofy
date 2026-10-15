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
}
/** Account planning settings without the task list. */
export type PlanMetadata = Omit<PlanState, "tasks">;
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
export type RunOperation = (
  operation: () => Promise<Confirmed>,
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
export interface TimerSnapshot {
  timerEtag: string;
  timer?: FocusState["timer"];
}
export interface PlusActions {
  load(weekStart?: string): Promise<PlusData>;
  loadDays(weekStart: string): Promise<FlowDayPlan[]>;
  updateTask(
    task: PlanningTask,
    update: { stage?: Stage; area?: Area; bet?: boolean },
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
  updateQueue(taskIds: string[], day: FlowDayPlan): Promise<FlowDayPlan[]>;
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
