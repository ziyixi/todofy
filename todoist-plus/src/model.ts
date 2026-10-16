// UI state. API messages are mapped from the root generated proto in api.ts.
export type Area = "work" | "personal" | "unassigned";
/** The two areas a week's Bets are written for. */
export type BetArea = Exclude<Area, "unassigned">;
export type Stage = "none" | "quarterly" | "monthly" | "weekly" | "committed";
export type View = "plan" | "focus" | "mailbox";
export type Language = "en" | "zh";
export interface PlanningTask {
  id: string;
  title: string;
  parentId: string;
  projectId: string;
  labels: string[];
  area: Area;
  stage: Stage;
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
  /** Its scheduled date repeats: completing it advances the date and keeps the task. */
  recurring?: boolean;
  /** Todoist's count of its completions, recurrences included; absent when Todoist does not say. */
  completedCount?: number;
}
/** One task waits for another; kept only in Todofy, never in Todoist (dependencies.ts). */
export interface TaskDependency {
  /** The task that waits. */
  taskId: string;
  /** The task it waits for. */
  prerequisiteId: string;
  /** The prerequisite's completedCount when added: a recurring one is done once it is higher. */
  baselineCount: number;
  /** Todofy confirmed the prerequisite completed, not deleted; the active list comes first. */
  done: boolean;
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
  /** Commitments chosen on this week's Sunday, which Monday's reset keeps. */
  nextWeekTaskIds: string[];
  /** Every dependency, IDs only. */
  dependencies: TaskDependency[];
  /** The Bets saved for last, this and next week; a week and area with none is absent. */
  weeklyBets: WeeklyBet[];
}
/**
 * One week's Work or Personal Bet: the owner's own line of text, kept in Todofy's planning store
 * and tied to no task.
 */
export interface WeeklyBet {
  /** The account-local Monday of its week. */
  weekStart: string;
  area: BetArea;
  /** One line; empty means none. */
  text: string;
  /** Sent back to save over it; empty while the week and area have none. */
  etag: string;
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
  /**
   * Favourite projects a Plus page replaces while it is open: Todofy's mail project, which the
   * Mailbox lists. A configuration cached by an earlier build has none.
   */
  hiddenProjectIds?: string[];
}
export interface FlowDayPlan {
  date: string;
  taskIds: string[];
  completedTaskIds: string[];
}
/** A dependency write's confirmed result. */
export interface DependencyResult {
  /** The task whose dependencies these are; absent when they are every dependency. */
  forTask?: string;
  dependencies: TaskDependency[];
  /** Tasks that stopped waiting because what they waited for was deleted. */
  dropped?: string[];
  /** Tasks that stopped waiting because what they waited for left the list, Todoist not saying how. */
  released?: string[];
}
/** A write's server-confirmed result; void means only a re-read can show it. */
export type Confirmed =
  | void
  | FlowDayPlan[]
  | PlanningTask
  | PlanningTask[]
  | PlanMetadata
  | DependencyResult
  | TimerSnapshot
  | WeeklyBet
  | WeeklyBet[]
  | MailDeletion;
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
/**
 * One mail Todofy summarised: a Mail Hero event that created a task. Its title is the task's;
 * the mail text itself stays in Todofy.
 */
export interface MailItem {
  /** Mail Hero's event ID, Todofy's own ID of the mail. */
  id: string;
  /** The mail's Todoist task. */
  taskId: string;
  /** One plain sentence about the mail; empty when it has none. */
  brief: string;
  /** When Todofy received the mail (ISO time). */
  receivedAt: string;
  /** Whether Todofy still has its full summary. */
  hasSummary: boolean;
}
/** One of the owner's mail categories: an existing label, by ID, and a priority, P1 (1) to P4 (4). */
export interface MailCategory {
  id: string;
  labelId: string;
  /** The domain's order, 1 the most urgent; PlanningTask.priority is Todoist's API value instead. */
  priority: number;
}
/** The categories, their etag (which a filing sends back) and the project filed mail goes to ("" until chosen). */
export interface MailCategories {
  categories: MailCategory[];
  etag: string;
  destination: string;
}
/** The mail among some mail project tasks, and the categories to file it by. */
export interface MailLookup extends MailCategories {
  items: MailItem[];
}
/** A project filed mail may go to: the Inbox or an active project; its name is never stored. */
export interface MailProject {
  id: string;
  name: string;
  inbox: boolean;
}
/** DeleteMailItems' answer: the tasks now gone, and the ones Todofy kept on its own check. */
export interface MailDeletion {
  deletedTaskIds: string[];
  keptTaskIds: string[];
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
    update: { stage?: Stage; area?: Area; active?: boolean },
  ): Promise<PlanningTask>;
  /**
   * Saves a Bet's text over the one with `bet.etag`. Rejects with BetNotSaved when Todofy says it
   * changed elsewhere or its week has ended.
   */
  setWeeklyBet(bet: WeeklyBet): Promise<WeeklyBet>;
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
  /** Adds (`waits`) or removes that `taskId` waits for `prerequisiteId`; Todoist is not written. */
  setDependency(
    taskId: string,
    prerequisiteId: string,
    waits: boolean,
  ): Promise<DependencyResult>;
  /** Settles tasks that dependencies name and a complete read no longer lists (at most 20). */
  resolveDependencies(taskIds: string[]): Promise<DependencyResult>;
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
  /** The mail among these mail project tasks, asked about 200 at a time, and the categories. */
  lookupMail(taskIds: string[]): Promise<MailLookup>;
  /** One mail's full Todofy summary, as plain text; empty when it is no longer available. */
  readMailSummary(id: string): Promise<string>;
  /** The categories, the destination and the projects to choose it from (read for the dialog). */
  readMailSettings(): Promise<MailCategories & { projects: MailProject[] }>;
  /** Replaces the categories and the destination saved with `etag`; answers them as saved. */
  updateMailSettings(
    categories: Omit<MailCategory, "id">[],
    destination: string,
    etag: string,
  ): Promise<MailCategories>;
  /**
   * Files a mail task in one Todoist write: the category's label and priority, and a move to the
   * destination. The task as saved, no longer in the mail project.
   */
  fileMail(
    task: PlanningTask,
    category: MailCategory,
    categoriesEtag: string,
    requestId: string,
  ): Promise<PlanningTask>;
  /**
   * Permanently deletes these mail tasks, at most 200, that Todofy finds untouched on a fresh
   * read; a repeat with the same request ID finishes the rest and deletes nothing twice.
   */
  deleteMail(taskIds: string[], requestId: string): Promise<MailDeletion>;
}
