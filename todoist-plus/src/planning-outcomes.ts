import { effectiveArea, taskAncestors } from "./domain";
import type { Language, PlanState, PlanningTask, Stage } from "./model";

function isDateCandidate(
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

export function outcomeSteps(
  outcome: PlanningTask,
  tasks: PlanningTask[],
  labels: PlanState["managedLabels"] = [],
): PlanningTask[] {
  const children = new Map<string, PlanningTask[]>();
  for (const task of tasks) {
    const siblings = children.get(task.parentId) ?? [];
    siblings.push(task);
    children.set(task.parentId, siblings);
  }
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

export function reviewLanes(
  language: Language,
): { stage: Stage; title: string; role: string }[] {
  return [
    {
      stage: "quarterly",
      title: language === "zh" ? "本季度" : "Quarter",
      role: "quarter",
    },
    {
      stage: "monthly",
      title: language === "zh" ? "本月" : "Month",
      role: "candiate",
    },
    {
      stage: "weekly",
      title: language === "zh" ? "本周" : "Week",
      role: "focus",
    },
    {
      stage: "committed",
      title: language === "zh" ? "本周承诺" : "Committed",
      role: "committed",
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
