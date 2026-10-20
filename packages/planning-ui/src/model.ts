// UI state. API messages are mapped from the root generated proto in api.ts.
export type Area = "work" | "personal" | "unassigned";
/** The two areas a week's Bets are written for. */
export type BetArea = Exclude<Area, "unassigned">;
export type Stage = "none" | "quarterly" | "monthly" | "weekly" | "committed";
export type View = "plan" | "focus";
export type Language = "en" | "zh";
/** The Review board's lanes, left to right: Start now, Waiting, Parked, the four planning stages. */
export type LaneId = "start" | "waiting" | "parked" | Exclude<Stage, "none">;
export interface PlanningTask {
  id: string;
  title: string;
  parentId: string;
  projectId: string;
  labels: string[];
  /** The task's content type in Tasks. */
  kind?: "task" | "step";
  effort?: "" | "deep" | "shallow";
  /** The saved stage, before date-based candidates. */
  explicitStage?: Stage;
  /** Native planning state, separate from ordinary tags. */
  planningFlags?: string[];
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
  /** The task's last change (ISO time); absent when Tasks does not say. */
  updatedAt?: string;
  /** Its scheduled date repeats: completing it advances the date and keeps the task. */
  recurring?: boolean;
  /** The task's count of completions, recurrences included; absent when Tasks does not say. */
  completedCount?: number;
  /**
   * An earlier position among its siblings (same project, section and parent); absent when Tasks
   * does not say.
   */
  childOrder?: number;
  /** An order key among the same siblings, compared bytewise; absent when there is none. */
  orderKey?: string;
  /** Tasks' numeric sibling position; fractional positions are preserved. */
  sortOrder?: number;
}
/** One task waits for another; kept only in Todofy's planning store (dependencies.ts). */
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
  /**
   * Todofy's today, which Plan's week, lanes and statuses count from. Focus counts on Tasks' today
   * (FocusState.date); both Workers keep the account's time zone, so the two are the same date.
   */
  today: string;
  /** Pending Mail entries, supplied by a complete planning read. */
  mailboxPendingCount?: number;
  managedLabels: { role: string; id: string; label: string }[];
  /** Newest weekly review task Todofy created; the active task list says whether it is open. */
  reviewTaskId: string;
  /** Commitments chosen on this week's Sunday, which Monday's reset keeps. */
  nextWeekTaskIds: string[];
  /** Every dependency, IDs only. */
  dependencies: TaskDependency[];
  /** The Bets saved for last, this and next week; a week and area with none is absent. */
  weeklyBets: WeeklyBet[];
  /**
   * The Review lanes the owner arranged, each first to last by task ID, kept in Todofy's
   * planning store; a lane never arranged is absent.
   */
  laneOrders: Partial<Record<LaneId, string[]>>;
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
/** Time spent on a task, counted on one day: a timer session or time added by hand. */
export interface FocusEntry {
  id: string;
  taskId: string;
  date: string;
  /** Whole minutes, as seconds. */
  seconds: number;
  /** When its timer session started (ISO); absent for added time. */
  startedAt?: string;
  source: "timer" | "manual";
  /** The task's area when the time was logged; it does not follow later changes. */
  area: Area;
  etag: string;
}
/** One day's Focus queue in Tasks, with the time records counted on the day. */
export interface DayPlan {
  date: string;
  /** Open steps, first to last. */
  taskIds: string[];
  /** Steps completed from this day's queue, first to last. */
  completedTaskIds: string[];
  entries: FocusEntry[];
}
/** A queue write's answer: the days it changed, without their records. */
export type DayQueue = Omit<DayPlan, "entries">;
/** What Focus shows for a task its queues or records name, including one Plan does not list. */
export interface FocusTaskInfo {
  title: string;
  /** Its immediate parent's ID and title, or empty. */
  parentId: string;
  parentTitle: string;
  estimatedMinutes?: number;
  completed: boolean;
}
/** Focus days of a range as Tasks keeps them, with every task they name. */
export interface FocusRange {
  days: DayPlan[];
  tasks: Record<string, FocusTaskInfo>;
  /** Tasks' today. */
  today: string;
}
/** A time record to add: its task, day, whole minutes in seconds, and area. */
export type NewFocusEntry = Pick<
  FocusEntry,
  "taskId" | "date" | "seconds" | "area"
>;
/** A record as Tasks saved it. */
export interface SavedEntry {
  savedEntry: FocusEntry;
}
/** A record Tasks deleted. */
export interface DeletedEntry {
  deletedEntry: { id: string; date: string };
}
/** A dependency write's confirmed result. */
export interface DependencyResult {
  /** The task whose dependencies these are; absent when they are every dependency. */
  forTask?: string;
  dependencies: TaskDependency[];
  /** Tasks that stopped waiting because what they waited for was deleted. */
  dropped?: string[];
  /** Tasks that stopped waiting because what they waited for left the list, Tasks not saying how. */
  released?: string[];
}
/** A reorder's confirmed result. */
export interface ReorderResult {
  /** The tasks as Tasks lists them now; only their order and update time are new. */
  reordered: PlanningTask[];
  /** The lane's saved order; absent when only the tasks' order changed. */
  lane?: { lane: LaneId; taskIds: string[] };
}
/** A saved estimate: the task's duration in the host's task store, 0 for none. */
export interface EstimateResult {
  estimate: { taskId: string; minutes: number };
}
/** A write's server-confirmed result; void means only a re-read can show it. */
export type Confirmed =
  | void
  | DayQueue[]
  | PlanningTask
  | PlanningTask[]
  | DependencyResult
  | TimerSnapshot
  | WeeklyBet
  | WeeklyBet[]
  | ReorderResult
  | EstimateResult
  | SavedEntry
  | DeletedEntry;
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
/** Tasks' today in Focus: its queue and records, and the one timer. */
export interface FocusState extends DayPlan {
  finishedPomodoro?: { taskId: string; targetSeconds: number };
  timerEtag: string;
  estimates: Record<string, number>;
  /** Every task the read queues and records name. */
  tasks: Record<string, FocusTaskInfo>;
  timer?: {
    taskId: string;
    /** The day the session counts on: Tasks' today when it started. */
    day: string;
    /** The area sent with Start, which its record keeps. */
    area: Area;
    status: "running" | "paused";
    elapsedSeconds: number;
    mode?: "countup" | "pomodoro";
    targetSeconds?: number;
    startedAt: string;
    etag: string;
  };
}
/** One of the owner's mail categories: an existing label, by ID, and a priority, P1 (1) to P4 (4). */
export interface MailCategory {
  id: string;
  labelId: string;
  /** The domain's order, 1 the most urgent; PlanningTask.priority is the API value (4 is P1) instead. */
  priority: number;
}
/** The categories and their etag, which an edit sends back. */
export interface MailCategories {
  categories: MailCategory[];
  etag: string;
}
export interface StepDraft {
  title: string;
  estimatedMinutes?: number;
}
export interface PlusData {
  plan: PlanState;
  focus: FocusState;
  days: DayPlan[];
}
/** The last confirmed data, kept only in page memory between visits. */
export interface PlusSnapshot {
  data: PlusData;
  /** When the complete data was last read; confirmed writes may be merged since. */
  readAt: number;
}
export interface TimerSnapshot {
  timerEtag: string;
  finishedPomodoro?: FocusState["finishedPomodoro"];
  timer?: FocusState["timer"];
  /** The record a command saved when it ended a session of at least a minute. */
  entry?: FocusEntry;
}
export interface PlanUpdate {
  stage?: Stage;
  area?: Area;
  active?: boolean;
  parked?: boolean;
  quick?: boolean;
  waiting?: boolean;
  routine?: boolean;
  onHold?: boolean;
  blocked?: boolean;
  singleAction?: boolean;
}
export interface PlusActions {
  load(weekStart?: string): Promise<PlusData>;
  readPlan(): Promise<PlanMetadata>;
  loadDays(weekStart: string): Promise<DayPlan[]>;
  /** Saves the task's planning state in Todofy. */
  updateTask(task: PlanningTask, update: PlanUpdate): Promise<PlanningTask>;
  /**
   * Saves a Bet's text over the one with `bet.etag`. Rejects with BetNotSaved when Todofy says it
   * changed elsewhere or its week has ended.
   */
  setWeeklyBet(bet: WeeklyBet): Promise<WeeklyBet>;
  /** Appends sub-tasks under `task`; answers their IDs, in the entered order. */
  createSteps(
    task: PlanningTask,
    steps: StepDraft[],
    requestId: string,
  ): Promise<string[]>;
  updateLead(
    task: PlanningTask,
    deadline: string,
    leadDays: number,
  ): Promise<PlanningTask>;
  /**
   * Completes the task in the host's task store. In the same write Tasks marks it done in
   * `focusDay`'s queue (empty: Tasks' today) and settles a related timer session on its own day.
   */
  completeTask(
    task: PlanningTask,
    requestId: string,
    focusDay: string,
  ): Promise<void>;
  /** Adds (`waits`) or removes that `taskId` waits for `prerequisiteId`; the tasks are not written. */
  setDependency(
    taskId: string,
    prerequisiteId: string,
    waits: boolean,
  ): Promise<DependencyResult>;
  /** Settles tasks that dependencies name and a complete read no longer lists (at most 20). */
  resolveDependencies(taskIds: string[]): Promise<DependencyResult>;
  /**
   * Adds, removes or moves one step in Tasks' day queues, each one MoveFocusStep against the
   * queues Tasks holds, not the copy on screen.
   */
  addToDay(taskId: string, date: string): Promise<DayQueue[]>;
  removeFromDay(taskId: string, date: string): Promise<DayQueue[]>;
  moveTaskToDay(
    taskId: string,
    source: DayQueue | undefined,
    target: DayQueue,
    beforeId?: string,
  ): Promise<DayQueue[]>;
  /**
   * Sets the task's duration in the host's task store, 0 to clear it. Answers the duration the
   * store saved.
   */
  updateEstimate(taskId: string, minutes: number): Promise<EstimateResult>;
  /** Tasks' timer, without rereading task lists. */
  readTimer?(): Promise<TimerSnapshot>;
  /** One timer command; Start counts on Tasks' today, and `area` stays on the session's record. */
  timer(
    action: "start" | "pause" | "resume" | "stop" | "finish",
    taskId: string,
    focus: FocusState,
    targetSeconds?: number,
    area?: Area,
  ): Promise<TimerSnapshot>;
  /** Focus days from `start` to `end`, both included, with their records and the tasks they name. */
  readFocus(start: string, end: string): Promise<FocusRange>;
  /** Adds time by hand, on a day no later than Tasks' today. */
  addEntry(entry: NewFocusEntry): Promise<SavedEntry>;
  /** Changes a record's whole minutes, as seconds. */
  updateEntry(entry: FocusEntry, seconds: number): Promise<SavedEntry>;
  deleteEntry(entry: FocusEntry): Promise<DeletedEntry>;
  /**
   * Puts these tasks in this order, at most 100: `lane`'s order in Todofy's planning store, or
   * none for "". In Tasks, the siblings of `movedId` among them (same project, section and parent)
   * swap their positions into this order; Waiting and Parked never change the tasks.
   */
  reorderTasks(
    taskIds: string[],
    movedId: string,
    lane: LaneId | "",
    requestId: string,
  ): Promise<ReorderResult>;
}
