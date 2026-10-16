import { displayedTitle, taskAncestors, taskIndex } from "./domain";
import { byUntouched, waits } from "./weekly-review";
import type { Language, PlanningTask, TaskDependency } from "./model";

/**
 * Dependencies between tasks (owner decisions of 2026-10-16): stored only in Todofy, by ID, as edges
 * between its own task IDs; never in a Todoist title, description, comment or label. Everything here is
 * derived from a complete read. A dependency holds while its prerequisite is in the active list, and, when
 * that one repeats, until it is completed once more after the dependency was added. Holding is display
 * only: nothing is rescheduled or relabelled when it ends.
 */

/** A task waits for at most MAX_DEPENDENCIES tasks, with MAX_ALL_DEPENDENCIES in all (Todofy core/plan.py). */
export const MAX_DEPENDENCIES = 5;
export const MAX_ALL_DEPENDENCIES = 300;
/** Task IDs one ResolveDependencies call may name. */
export const RESOLVE_LIMIT = 20;

/**
 * Whether a dependency still holds back its task. A prerequisite missing from a complete read is done,
 * whether completed or deleted: Todofy settles which later, and either way nothing waits for it.
 */
export function holds(
  dependency: TaskDependency,
  prerequisite: PlanningTask | undefined,
): boolean {
  if (!prerequisite) return false;
  if (!prerequisite.recurring) return true;
  // A recurring task never leaves the list: its next completion raises Todoist's counter.
  return (
    (prerequisite.completedCount ?? dependency.baselineCount) <=
    dependency.baselineCount
  );
}

/** What the dependency rules read: a complete read's active tasks and every dependency. */
export interface DependencyView {
  tasks: readonly PlanningTask[];
  dependencies: readonly TaskDependency[];
}

export interface DependencyIndex {
  /** Each active task's prerequisites that still hold it back, oldest dependency first. */
  waitingFor: Map<string, PlanningTask[]>;
  /** How many of each active task's dependencies are done. */
  done: Map<string, number>;
  /** The active tasks each task still holds back. */
  waiters: Map<string, PlanningTask[]>;
}

const indexes = new WeakMap<
  readonly TaskDependency[],
  WeakMap<readonly PlanningTask[], DependencyIndex>
>();
/** Built once per pair of lists: every read and confirmed write replaces them instead of changing them. */
export function dependencyIndex(plan: DependencyView): DependencyIndex {
  let byTasks = indexes.get(plan.dependencies);
  if (!byTasks) {
    byTasks = new WeakMap();
    indexes.set(plan.dependencies, byTasks);
  }
  let index = byTasks.get(plan.tasks);
  if (index) return index;
  index = { waitingFor: new Map(), done: new Map(), waiters: new Map() };
  const byId = taskIndex(plan.tasks);
  for (const dependency of plan.dependencies) {
    const task = byId.get(dependency.taskId);
    // A task that is gone waits for nothing; Todofy drops its dependencies once it confirms.
    if (!task) continue;
    const prerequisite = byId.get(dependency.prerequisiteId);
    if (prerequisite && holds(dependency, prerequisite)) {
      index.waitingFor.set(task.id, [
        ...(index.waitingFor.get(task.id) ?? []),
        prerequisite,
      ]);
      index.waiters.set(prerequisite.id, [
        ...(index.waiters.get(prerequisite.id) ?? []),
        task,
      ]);
    } else index.done.set(task.id, (index.done.get(task.id) ?? 0) + 1);
  }
  byTasks.set(plan.tasks, index);
  return index;
}

/** A task that waits: a `waiting` or `blocked` label, or a dependency that holds. */
export function isWaiting(task: PlanningTask, index: DependencyIndex): boolean {
  return waits(task) || index.waitingFor.has(task.id);
}

/** Every task that waits, by label or by dependency, the longest untouched first. */
export function waitingTasks(plan: DependencyView): PlanningTask[] {
  const index = dependencyIndex(plan);
  return byUntouched(plan.tasks.filter((task) => isWaiting(task, index)));
}

/** Whether `taskId` already waits for `prerequisiteId`, directly or through others (core/plan.py waits_for). */
export function waitsThrough(
  dependencies: readonly TaskDependency[],
  taskId: string,
  prerequisiteId: string,
): boolean {
  const seen = new Set([taskId]);
  const pending = [taskId];
  while (pending.length) {
    const current = pending.pop();
    for (const dependency of dependencies) {
      if (dependency.taskId !== current) continue;
      if (dependency.prerequisiteId === prerequisiteId) return true;
      if (!seen.has(dependency.prerequisiteId)) {
        seen.add(dependency.prerequisiteId);
        pending.push(dependency.prerequisiteId);
      }
    }
  }
  return false;
}

/** Why a task cannot be chosen, shown greyed in the picker; undefined when it can. */
export type Refusal = "cycle" | "repeats";

export interface Candidate {
  task: PlanningTask;
  /** Its parents, outermost first, for the picker's second line. */
  path: string;
  refusal?: Refusal;
}

/**
 * The picker's matches for `query` among the loaded active tasks, by title or parent title as in
 * "Change goal", at most `limit`. Never the task itself, its parents or its steps, or a task it already
 * waits for. One that would wait for it in turn is greyed (Todofy refuses it too), and so is a recurring
 * task whose completions Todoist does not count.
 */
export function candidates(
  plan: DependencyView,
  task: PlanningTask,
  query: string,
  limit = 6,
): Candidate[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const excluded = new Set([
    task.id,
    ...taskAncestors(task, plan.tasks).map((parent) => parent.id),
    ...plan.dependencies
      .filter((dependency) => dependency.taskId === task.id)
      .map((dependency) => dependency.prerequisiteId),
  ]);
  const result: Candidate[] = [];
  for (const candidate of plan.tasks) {
    if (result.length >= limit) break;
    const ancestors = taskAncestors(candidate, plan.tasks);
    if (
      excluded.has(candidate.id) ||
      ancestors.some((parent) => parent.id === task.id)
    )
      continue;
    const parents = ancestors
      .map((parent) => displayedTitle(parent.title))
      .join(" › ");
    if (
      !`${displayedTitle(candidate.title)} ${parents}`
        .toLocaleLowerCase()
        .includes(needle)
    )
      continue;
    const refusal: Refusal | undefined = waitsThrough(
      plan.dependencies,
      candidate.id,
      task.id,
    )
      ? "cycle"
      : candidate.recurring && candidate.completedCount === undefined
        ? "repeats"
        : undefined;
    result.push({ task: candidate, path: parents, refusal });
  }
  return result;
}

/**
 * Tasks the dependencies name that a complete read did not list, for Todofy to settle: every task
 * that waited, and each prerequisite not yet known to be completed. At most RESOLVE_LIMIT.
 */
export function unsettled(plan: DependencyView): string[] {
  const byId = taskIndex(plan.tasks);
  const ids = new Set<string>();
  for (const dependency of plan.dependencies) {
    if (!byId.has(dependency.taskId)) ids.add(dependency.taskId);
    else if (!dependency.done && !byId.has(dependency.prerequisiteId))
      ids.add(dependency.prerequisiteId);
  }
  return [...ids].slice(0, RESOLVE_LIMIT);
}

const quoted = (task: PlanningTask, language: Language) =>
  language === "zh"
    ? `「${displayedTitle(task.title)}」`
    : `“${displayedTitle(task.title)}”`;

/** A card's quiet status: 「等「订场地」」 or 「等 2 项」; “Waiting for “Book venue”” or “Waiting for 2 tasks”. */
export function waitingForText(
  prerequisites: readonly PlanningTask[],
  language: Language,
): string {
  const [first] = prerequisites;
  if (prerequisites.length === 1 && first)
    return language === "zh"
      ? `等${quoted(first, language)}`
      : `Waiting for ${quoted(first, language)}`;
  return language === "zh"
    ? `等 ${prerequisites.length} 项`
    : `Waiting for ${prerequisites.length} tasks`;
}

/** The details' line under what is still open: 「另有 1 项已完成」, or that all of it is done. */
export function doneText(done: number, open: number, language: Language) {
  if (!open)
    return language === "zh"
      ? "所等的任务都已完成，可以开始了"
      : "Everything it waits for is done — ready to start";
  return language === "zh"
    ? `另有 ${done} 项已完成`
    : `${done} more ${done === 1 ? "is" : "are"} done`;
}

/** 「「发邀请函」在等它」, or 「「发邀请函」等 2 项在等它」. */
export function waitersText(
  waiters: readonly PlanningTask[],
  language: Language,
): string {
  const [first] = waiters;
  if (!first) return "";
  if (language === "zh")
    return `${quoted(first, language)}${waiters.length > 1 ? `等 ${waiters.length} 项` : ""}在等它`;
  return waiters.length > 1
    ? `${quoted(first, language)} and ${waiters.length - 1} more are waiting for this`
    : `${quoted(first, language)} is waiting for this`;
}

/** The Review board's one-time notice for a task whose prerequisite was deleted. */
export function droppedText(task: PlanningTask, language: Language): string {
  return language === "zh"
    ? `${quoted(task, language)}等的任务已被删除，不再等待。`
    : `${quoted(task, language)} no longer waits — the task it waited for was deleted.`;
}
