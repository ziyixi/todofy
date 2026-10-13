// UI state. API messages are mapped from the root generated proto in api.ts.
export type Area = "work" | "personal" | "unassigned";
export type Stage = "none" | "monthly" | "weekly" | "committed";
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
}
export interface FocusState {
  date: string;
  timerEtag: string;
  taskIds: string[];
  completedTaskIds: string[];
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
export interface PlusActions {
  load(): Promise<{ plan: PlanState; focus: FocusState }>;
  updateTask(
    task: PlanningTask,
    update: { stage?: Stage; area?: Area; bet?: boolean },
  ): Promise<void>;
  createSteps(
    task: PlanningTask,
    steps: StepDraft[],
    requestId: string,
  ): Promise<void>;
  updateLead(
    task: PlanningTask,
    deadline: string,
    leadDays: number,
  ): Promise<void>;
  completeTask(
    task: PlanningTask,
    requestId: string,
    flowDate: string,
  ): Promise<void>;
  updateQueue(taskIds: string[], focus: FocusState): Promise<void>;
  updateEstimate(taskId: string, minutes: number): Promise<void>;
  timer(
    action: "start" | "pause" | "resume" | "stop",
    taskId: string,
    focus: FocusState,
  ): Promise<void>;
}
