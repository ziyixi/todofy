import { effectiveArea, taskAncestors } from "./domain";
import type { Language, PlanState, PlanningTask, Stage } from "./model";

const childIndexes = new WeakMap<
  readonly PlanningTask[],
  Map<string, PlanningTask[]>
>();
/** Children by parent ID, built once per task list like `taskIndex`. */
function childIndex(tasks: readonly PlanningTask[]) {
  let children = childIndexes.get(tasks);
  if (!children) {
    children = new Map();
    for (const task of tasks) {
      const siblings = children.get(task.parentId) ?? [];
      siblings.push(task);
      children.set(task.parentId, siblings);
    }
    childIndexes.set(tasks, children);
  }
  return children;
}

/** The literal set-aside label, as the native @parked filter names it; never created here. */
export const PARKED_LABEL = "parked";

/** Review's Parked lane exists only while the account has a label named exactly `parked`. */
export function canPark(plan: Pick<PlanState, "availableLabels">): boolean {
  return plan.availableLabels.some((label) => label.label === PARKED_LABEL);
}

/** Set aside: in Review's Parked lane, and on no list of commitments or steps. */
export function isParked(
  task: PlanningTask,
  plan: Pick<PlanState, "availableLabels">,
): boolean {
  return task.labels.includes(PARKED_LABEL) && canPark(plan);
}

/** A Week candidate only by Todofy's 7-day date rule (Candidate If): it has no Week label of its own. */
export function isDateCandidate(
  task: PlanningTask,
  labels: PlanState["managedLabels"],
): boolean {
  const weeklyLabel = labels.find((label) => label.role === "focus")?.label;
  return (
    task.stage === "weekly" &&
    Boolean(task.due || task.deadline) &&
    !task.labels.some((label) => label === weeklyLabel)
  );
}

function outcomeCandidates(
  chain: PlanningTask[],
  labels: PlanState["managedLabels"],
): PlanningTask[] {
  return chain.filter(
    (task, index) =>
      task.stage !== "none" &&
      (!isDateCandidate(task, labels) ||
        !chain.slice(index + 1).some((ancestor) => ancestor.stage !== "none")),
  );
}

export function planningOutcomes(
  tasks: PlanningTask[],
  labels: PlanState["managedLabels"] = [],
): PlanningTask[] {
  const outcomes = tasks.filter((task) => {
    if (task.stage === "none") return false;
    const chain = [task, ...taskAncestors(task, tasks).reverse()];
    const candidates = outcomeCandidates(chain, labels);
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
 * This week's commitments as Review's Committed lane lists them, none set aside: Week's overview,
 * the toolbar's counts and the weekly review all use this one list.
 */
export function committedOutcomes(
  plan: Pick<PlanState, "tasks" | "managedLabels" | "availableLabels">,
): PlanningTask[] {
  return planningOutcomes(plan.tasks, plan.managedLabels).filter(
    (task) => task.stage === "committed" && !isParked(task, plan),
  );
}

export function outcomeSteps(
  outcome: PlanningTask,
  tasks: PlanningTask[],
  labels: PlanState["managedLabels"] = [],
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
      !isDateCandidate(task, labels)
    )
      return;
    const next = children.get(task.id) ?? [];
    if (!next.length) leaves.push(task);
    else next.forEach(visit);
  }
  visit(outcome);
  return leaves;
}

export function outcomeForTask(
  task: PlanningTask,
  tasks: PlanningTask[],
  labels: PlanState["managedLabels"] = [],
): PlanningTask {
  const parents = taskAncestors(task, tasks).reverse();
  const candidates = outcomeCandidates([task, ...parents], labels);
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

export function outcomeColor(outcome: PlanningTask): string {
  const colors = [
    "#6387a3",
    "#9b7eb0",
    "#6b928c",
    "#a98369",
    "#829968",
    "#aa8b63",
  ];
  let hash = 0;
  for (const character of outcome.id)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length]!;
}

/** The label role of each planning stage, as Todofy maps them (core/plus.py STAGES). */
export const STAGE_ROLES = {
  quarterly: "quarter",
  monthly: "candiate",
  weekly: "focus",
  committed: "committed",
} as const;

export function reviewLanes(
  language: Language,
): { stage: Exclude<Stage, "none">; title: string; role: string }[] {
  return [
    {
      stage: "quarterly",
      title: language === "zh" ? "本季度" : "Quarter",
      role: STAGE_ROLES.quarterly,
    },
    {
      stage: "monthly",
      title: language === "zh" ? "本月" : "Month",
      role: STAGE_ROLES.monthly,
    },
    {
      stage: "weekly",
      title: language === "zh" ? "本周" : "Week",
      role: STAGE_ROLES.weekly,
    },
    {
      stage: "committed",
      title: language === "zh" ? "本周承诺" : "Committed",
      role: STAGE_ROLES.committed,
    },
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
