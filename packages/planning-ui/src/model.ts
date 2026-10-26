// UI state. API messages are mapped from the root generated proto in api.ts.
import type { ReactNode } from "react";
export type Area = "work" | "personal" | "unassigned";
/** The two areas a week's Bets are written for. */
export type BetArea = Exclude<Area, "unassigned">;
export type Stage = "none" | "quarterly" | "monthly" | "weekly" | "committed";
export type View = "plan" | "focus";
export type Language = "en" | "zh";
/** Review's lanes; start remains a readable legacy order key, without a displayed column. */
export type LaneId = "start" | "waiting" | "parked" | Exclude<Stage, "none">;
export interface PlanningTask {
  id: string;
  title: string;
  keyResultId?: string;
  effectiveKeyResultId?: string;
  keyResultTitle?: string;
  parentId: string;
  projectId: string;
  /** The task's content type in Tasks. */
  kind?: "task" | "step";
  effort?: "" | "deep" | "shallow";
  /** The saved stage, before date-based candidates. */
  explicitStage?: Stage;
  /** Planning state, separate from ordinary tags. */
  planningFlags?: string[];
  /** Tasks' section, which with the project and parent makes a task's siblings. */
  sectionId?: string;
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
/** One task waits for another, as a task in Tasks lists it (dependencies.ts). */
export interface TaskDependency {
  /** The task that waits. */
  taskId: string;
  /** The task it waits for. */
  prerequisiteId: string;
  /** Tasks says it is completed, or repeats and was completed again since the dependency was added. */
  done: boolean;
}
export interface PlanState {
  tasks: PlanningTask[];
  week: string;
  timezone: string;
  /**
   * Tasks' today, which Plan's week, lanes and statuses count from, as Focus does (FocusState.date).
   */
  today: string;
  /** Commitments chosen on this week's Sunday, which Monday's rollover keeps. */
  nextWeekTaskIds: string[];
  /** Every dependency of the listed tasks, IDs only. */
  dependencies: TaskDependency[];
  /** The Bets saved for last, this and next week; a week and area with none is absent. */
  weeklyBets: WeeklyBet[];
  /** The Review lanes the owner arranged, each first to last by task ID; a lane never arranged is absent. */
  laneOrders: Partial<Record<LaneId, string[]>>;
}
/** One week's Work or Personal Bet, optionally pointing to an annual result. */
export interface WeeklyBet {
  /** The account-local Monday of its week. */
  weekStart: string;
  area: BetArea;
  /** One line; empty means none. */
  text: string;
  keyResultId?: string;
  keyResultTitle?: string;
  /** Sent back to save over it; empty while the week and area have none. */
  etag: string;
}
export type WeeklyBetField = "text" | "key_result_id";
/** The host supplies its lazy annual-goal picker, without adding a read to Plan. */
export type RenderGoalPicker = (props: {
  value: string;
  title?: string;
  label: string;
  disabled: boolean;
  onChange: (id: string, title: string) => void;
}) => ReactNode;
/** The plan without the task list and its dependencies. */
export type PlanMetadata = Omit<PlanState, "tasks" | "dependencies">;
/** The weekly review's two facts, read from Tasks when the review opens. */
export interface WeeklyReviewFacts {
  /** The week's review task, or the week before's while the week has none; the open task list says whether it is open. */
  reviewTaskId: string;
  /** Mail entries still awaiting a decision; undefined when Todofy did not answer. */
  mailboxPendingCount: number | undefined;
}
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
/** A dependency write's confirmed result: the task that waits, saved, and its dependencies now. */
export interface DependencyResult {
  forTask: string;
  dependencies: TaskDependency[];
  /** The task as Tasks saved it: a dependency write changes its etag. */
  task?: PlanningTask;
}
/** A reorder's confirmed result. */
export interface ReorderResult {
  /** The tasks as Tasks lists them now; only their order and update time are new. */
  reordered: PlanningTask[];
  /** The lane's saved order; absent when only the tasks' order changed. */
  lane?: { lane: LaneId; taskIds: string[] };
}
/**
 * A saved estimate: the task's duration in the host's task store, 0 for none, and the etag the
 * write gave the task.
 */
export interface EstimateResult {
  estimate: { taskId: string; minutes: number };
  etag: string;
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
  /** Every task the read queues and records name, the shown week's included. */
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
    /** When a paused session paused (ISO); absent unless paused, and for a pause made before Tasks kept it. */
    pausedAt?: string;
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
  /** The weekly review's two facts for the week starting `week` (Tasks' GetWeeklyReview). */
  readWeeklyReview?(week: string): Promise<WeeklyReviewFacts>;
  /**
   * The week from `weekStart`, Monday to Sunday: its days, with every task they name (done steps,
   * which Plan's list leaves out, among them).
   */
  loadDays(weekStart: string): Promise<FocusRange>;
  /** Saves the task's planning state in Tasks. */
  updateTask(task: PlanningTask, update: PlanUpdate): Promise<PlanningTask>;
  /**
   * Saves a Bet's text over the one with `bet.etag`. Rejects with BetNotSaved when Tasks says it
   * changed elsewhere or its week has ended.
   */
  setWeeklyBet(bet: WeeklyBet, fields?: WeeklyBetField[]): Promise<WeeklyBet>;
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
   * Completes the task in the host's task store, under its etag. In the same write Tasks marks it
   * done in `focusDay`'s queue (empty: Tasks' today) and settles a related timer session on its own
   * day.
   */
  completeTask(
    task: PlanningTask,
    requestId: string,
    focusDay: string,
  ): Promise<void>;
  /** Deletes in Tasks under Plan's etag; Tasks owns queue, dependency and time-record semantics. */
  deleteTask(task: PlanningTask, requestId: string): Promise<void>;
  /**
   * Saves the tasks `task` waits for, one write of the waiting task under its etag. `added` names
   * the one this write adds, which Tasks may refuse. Tasks keeps a dependency it already has as it
   * is, so a done one (`restart`) is removed and added again, a second write: a recurring task is
   * then waited for until its next completion.
   */
  setDependencies(
    task: PlanningTask,
    prerequisiteIds: readonly string[],
    added?: { id: string; restart: boolean },
  ): Promise<DependencyResult>;
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
   * Sets the task's duration in the host's task store under its etag, 0 to clear it. Answers the
   * duration the store saved.
   */
  updateEstimate(task: PlanningTask, minutes: number): Promise<EstimateResult>;
  /** Tasks' timer, without rereading task lists. */
  readTimer?(): Promise<TimerSnapshot>;
  /**
   * One timer command; Start counts on Tasks' today, and `area` stays on the session's record. `at` (ISO) is when
   * a Pause or Resume takes effect, which Tasks moves into its range: a Pause between its running segment's start
   * and now, a Resume between `pausedAt` and now. Without it, now.
   */
  timer(
    action: "start" | "pause" | "resume" | "stop" | "finish",
    taskId: string,
    focus: FocusState,
    targetSeconds?: number,
    area?: Area,
    at?: string,
  ): Promise<TimerSnapshot>;
  /** Focus days from `start` to `end`, both included, with their records and the tasks they name. */
  readFocus(start: string, end: string): Promise<FocusRange>;
  /** Adds time by hand, on a day no later than Tasks' today. */
  addEntry(entry: NewFocusEntry): Promise<SavedEntry>;
  /** Changes a record's whole minutes, as seconds. */
  updateEntry(entry: FocusEntry, seconds: number): Promise<SavedEntry>;
  deleteEntry(entry: FocusEntry): Promise<DeletedEntry>;
  /**
   * Puts these tasks in this order, at most 100: `lane`'s order, or none for "". The siblings of
   * `movedId` among them (same project, section and parent) swap their positions into this order,
   * each under the etag Plan holds; Waiting and Parked never change the tasks.
   */
  reorderTasks(
    tasks: readonly PlanningTask[],
    movedId: string,
    lane: LaneId | "",
    requestId: string,
  ): Promise<ReorderResult>;
}
