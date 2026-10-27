import {
  effectiveArea,
  hasPlanningFlag,
  isSchedulable,
  taskAncestors,
} from "./domain";
import type { LaneId, Language, PlanState, PlanningTask, Stage } from "./model";

const childIndexes = new WeakMap<
  readonly PlanningTask[],
  Map<string, PlanningTask[]>
>();
/**
 * Todoist's order of one parent's children: by order key, compared bytewise, when every one has
 * one, else by position, unknown positions last; ties keep the list's order.
 */
function inTodoistOrder(siblings: PlanningTask[]): PlanningTask[] {
  if (siblings.every((task) => task.sortOrder !== undefined))
    return siblings.sort((a, b) => a.sortOrder! - b.sortOrder!);
  if (siblings.every((task) => task.orderKey !== undefined))
    return siblings.sort((a, b) =>
      a.orderKey! < b.orderKey! ? -1 : a.orderKey! > b.orderKey! ? 1 : 0,
    );
  const position = (task: PlanningTask) => task.childOrder ?? Infinity;
  return siblings.sort((a, b) =>
    position(a) === position(b) ? 0 : position(a) - position(b),
  );
}
/** Children by parent ID, in Todoist's order, built once per task list like `taskIndex`. */
function childIndex(tasks: readonly PlanningTask[]) {
  let children = childIndexes.get(tasks);
  if (!children) {
    children = new Map();
    for (const task of tasks) {
      const siblings = children.get(task.parentId) ?? [];
      siblings.push(task);
      children.set(task.parentId, siblings);
    }
    for (const siblings of children.values()) inTodoistOrder(siblings);
    childIndexes.set(tasks, children);
  }
  return children;
}

/** A sub-task's siblings in Todoist's order, itself included; none for a top-level task. */
export function stepSiblings(
  task: PlanningTask,
  tasks: readonly PlanningTask[],
): PlanningTask[] {
  return task.parentId ? (childIndex(tasks).get(task.parentId) ?? []) : [];
}

/** The literal set-aside label, as the native @parked filter names it; never created here. */
export const PARKED_LABEL = "parked";

/** Set aside: in Review's Parked lane, and on no list of commitments or steps. */
export function isParked(task: PlanningTask): boolean {
  return hasPlanningFlag(task, PARKED_LABEL);
}

/** Tasks keeps at most this many tasks of one lane's order (planning.ts MAX_LANE_TASKS). */
export const MAX_LANE_TASKS = 100;

/**
 * A lane's tasks in the owner's order: the ones in the stored order first, as stored (IDs no
 * longer in the lane are skipped), then the rest in the lane's own order. For "start", Parked's
 * ready cards, the rest come first instead: a task that has just become ready is its newest news.
 */
export function inLaneOrder(
  lane: LaneId,
  tasks: readonly PlanningTask[],
  stored: readonly string[] = [],
): PlanningTask[] {
  const positions = new Map(stored.map((id, index) => [id, index]));
  const arranged = tasks
    .filter((task) => positions.has(task.id))
    .sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
  const rest = tasks.filter((task) => !positions.has(task.id));
  return lane === "start" ? [...rest, ...arranged] : [...arranged, ...rest];
}

/** A Week candidate only by the 7-day date rule (Candidate If): it has no stage of its own. */
export function isDateCandidate(task: PlanningTask): boolean {
  return (
    task.stage === "weekly" &&
    (task.explicitStage ?? "none") === "none" &&
    Boolean(task.due || task.deadline)
  );
}

function outcomeCandidates(chain: PlanningTask[]): PlanningTask[] {
  return chain.filter(
    (task, index) =>
      task.stage !== "none" &&
      (!isDateCandidate(task) ||
        !chain.slice(index + 1).some((ancestor) => ancestor.stage !== "none")),
  );
}

export function planningOutcomes(tasks: PlanningTask[]): PlanningTask[] {
  const outcomes = tasks.filter((task) => {
    if (task.stage === "none") return false;
    const chain = [task, ...taskAncestors(task, tasks).reverse()];
    const candidates = outcomeCandidates(chain);
    return (
      candidates[0]?.id === task.id &&
      !candidates.slice(1).some((ancestor) => ancestor.stage === task.stage)
    );
  });
  return (["work", "personal", "unassigned"] as const).flatMap((area) =>
    outcomes.filter((task) => effectiveArea(task, tasks) === area),
  );
}

/**
 * This week's commitments as Review's Committed lane lists them, in its order and none set aside:
 * Week's overview, the toolbar's counts and the weekly review all use this one list.
 */
export function committedOutcomes(
  plan: Pick<PlanState, "tasks" | "laneOrders">,
): PlanningTask[] {
  return inLaneOrder(
    "committed",
    planningOutcomes(plan.tasks).filter(
      (task) => task.stage === "committed" && !isParked(task),
    ),
    plan.laneOrders.committed,
  );
}

export function outcomeSteps(
  outcome: PlanningTask,
  tasks: PlanningTask[],
): PlanningTask[] {
  const children = childIndex(tasks);
  const leaves: PlanningTask[] = [];
  const seen = new Set<string>();
  function visit(task: PlanningTask) {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    if (
      task.id !== outcome.id &&
      task.stage !== "none" &&
      task.stage !== outcome.stage &&
      !isDateCandidate(task)
    )
      return;
    const next = children.get(task.id) ?? [];
    if (task.kind ? isSchedulable(task) : !next.length) leaves.push(task);
    next.forEach(visit);
  }
  visit(outcome);
  return leaves;
}

export function outcomeForTask(
  task: PlanningTask,
  tasks: PlanningTask[],
): PlanningTask {
  const parents = taskAncestors(task, tasks).reverse();
  const candidates = outcomeCandidates([task, ...parents]);
  return (
    candidates.find(
      (item, index) =>
        !candidates
          .slice(index + 1)
          .some((ancestor) => ancestor.stage === item.stage),
    ) ??
    parents[0] ??
    task
  );
}

/**
 * A card's edge colour, from its area: its own, else its nearest ancestor's. Work and Personal have
 * one colour each, which the area filters' dots explain; Unassigned shows none, only the card's own
 * border. Cards set it as `--area-color`.
 */
export function areaColor(task: PlanningTask, tasks: PlanningTask[]): string {
  const area = effectiveArea(task, tasks);
  return `var(--plus-area-${area === "unassigned" ? "none" : area})`;
}

export function reviewLanes(
  language: Language,
): { stage: Exclude<Stage, "none">; title: string }[] {
  return [
    { stage: "quarterly", title: language === "zh" ? "本季度" : "Quarter" },
    { stage: "monthly", title: language === "zh" ? "本月" : "Month" },
    { stage: "weekly", title: language === "zh" ? "本周" : "Week" },
    { stage: "committed", title: language === "zh" ? "本周承诺" : "Committed" },
  ];
}

export function outcomeArea(
  task: PlanningTask,
  tasks: PlanningTask[],
  language: Language,
): string {
  const area = effectiveArea(task, tasks);
  if (area === "work") return language === "zh" ? "工作" : "Work";
  if (area === "personal") return language === "zh" ? "生活" : "Personal";
  return language === "zh" ? "未分类" : "Unassigned";
}
